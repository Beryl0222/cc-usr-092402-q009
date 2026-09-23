// 三类角色视图：
//   - 申报企业：自身明细 + 与其所产规格相关的汇总缺口
//   - 供应保障专班：全局情景、对账单与逐消息回执
//   - 公开页面：仅脱敏后的汇总结论，不含企业/地区/工厂/产线/批次/承诺标识

import { buildScenario, summarizeGaps } from './scenarios.js';
import { buildStatement } from './reconcile.js';

/** 申报企业视图：只能看到本企业提交的事实与本企业的承诺。 */
export function enterpriseView(view, enterpriseId) {
  const ownSpecs = new Set(
    view.capacities.filter((c) => c.enterprise_id === enterpriseId).map((c) => c.spec_id),
  );

  const capacities = view.capacities
    .filter((c) => c.enterprise_id === enterpriseId)
    .map((c) => ({
      capacity_id: c.capacity_id,
      factory_id: c.factory_id,
      line_id: c.line_id,
      spec_id: c.spec_id,
      window_id: c.window_id,
      declared_qty: c.declared_qty,
      current_qty: c.current_qty,
      revisions: c.revisions,
      maintenance_qty: c.maintenance_qty,
      effective_qty: c.effective_qty,
      locked_qty: c.locked_qty,
      free_qty: c.free_qty,
    }));

  const commitments = view.commitments
    .filter((c) => c.enterprise_id === enterpriseId)
    .map((c) => ({
      commitment_id: c.commitment_id,
      region_id: c.region_id,
      spec_id: c.spec_id,
      status: c.status,
      origin: c.origin,
      qty: c.qty,
      remaining_qty: c.remaining_qty,
      slices: c.slices.map((s) => ({
        window_id: s.window_id,
        qty: s.qty,
        withdrawn_qty: s.withdrawn_qty,
        remaining_qty: s.remaining_qty,
        corrections: s.corrections,
      })),
      proposed_at: c.proposed_at,
      confirmed_at: c.confirmed_at,
    }));

  // 汇总缺口只按"本企业生产的规格"聚合地区需求，不暴露其他企业的承诺明细。
  const arrivalsIndex = new Map();
  for (const s of view.shipments) {
    for (const a of s.arrivals) {
      const key = `${s.destination_region_id}|${s.spec_id}|${a.window_id}`;
      arrivalsIndex.set(key, (arrivalsIndex.get(key) ?? 0) + a.qty);
    }
  }
  const gapRows = view.demands
    .filter((d) => ownSpecs.has(d.spec_id))
    .map((d) => {
      const confirmed = view.commitments
        .filter(
          (c) =>
            c.status === 'confirmed' &&
            c.region_id === d.region_id &&
            c.spec_id === d.spec_id &&
            c.slices.some((s) => s.window_id === d.window_id),
        )
        .reduce(
          (sum, c) =>
            sum +
            (c.slices.find((s) => s.window_id === d.window_id)?.remaining_qty ?? 0),
          0,
        );
      const arrived = arrivalsIndex.get(`${d.region_id}|${d.spec_id}|${d.window_id}`) ?? 0;
      return {
        spec_id: d.spec_id,
        window_id: d.window_id,
        demand_qty: d.qty,
        minimum_line: d.minimum_line,
        confirmed_total_qty: confirmed, // 全体企业对该地区/规格/窗的确认量
        arrived_qty: arrived,
        shortage_qty: Math.max(0, d.qty - confirmed - arrived),
      };
    });
  const gapSummary = gapRows.reduce(
    (acc, r) => {
      acc.demand_qty += r.demand_qty;
      acc.confirmed_total_qty += r.confirmed_total_qty;
      acc.arrived_qty += r.arrived_qty;
      acc.shortage_qty += r.shortage_qty;
      return acc;
    },
    { demand_qty: 0, confirmed_total_qty: 0, arrived_qty: 0, shortage_qty: 0 },
  );

  return {
    viewer: 'enterprise',
    enterprise_id: enterpriseId,
    round_id: view.meta.round_id,
    as_of_window: view.meta.as_of_window,
    round_closed: view.closed,
    capacities,
    maintenance: view.maintenance.filter((m) => m.enterprise_id === enterpriseId),
    batches: view.batches
      .filter((b) => b.enterprise_id === enterpriseId)
      .map((b) => ({
        batch_id: b.batch_id,
        factory_id: b.factory_id,
        spec_id: b.spec_id,
        released_total: b.released_total,
        releases: b.releases,
      })),
    shipments: view.shipments
      .filter((s) => s.enterprise_id === enterpriseId)
      .map((s) => ({
        shipment_id: s.shipment_id,
        spec_id: s.spec_id,
        destination_region_id: s.destination_region_id,
        qty: s.qty,
        eta_window_id: s.eta_window_id,
        arrived_total: s.arrived_total,
        arrivals: s.arrivals,
        cancelled_qty: s.cancelled_qty,
        remaining_qty: s.remaining_qty,
      })),
    commitments,
    gap_summary: gapSummary,
    gap_rows: gapRows,
  };
}

/** 专班视图：全局情景 + 对账单 + 逐消息回执与确认状态。 */
export function taskForceView(view) {
  const scenario = buildScenario(view);
  const statement = buildStatement(view, scenario);
  const gaps = summarizeGaps(scenario);

  // 回执：企业每条带 message_id 的命令的落账序号（重复消息记录为 duplicate，由台账外的提交方标注；
  // 台账对重复消息幂等忽略，因此这里只呈现已入账事件）。
  const receipts = view.events
    .filter((e) => e.message_id)
    .map((e) => ({
      seq: e.seq,
      message_id: e.message_id,
      event_id: e.event_id,
      type: e.type,
      occurred_at: e.occurred_at,
      ref:
        e.enterprise_id ??
        e.region_id ??
        e.operator_id ??
        e.capacity_id ??
        e.commitment_id ??
        null,
    }));

  return {
    viewer: 'task_force',
    round_id: view.meta.round_id,
    as_of_window: view.meta.as_of_window,
    round_closed: view.closed,
    scenario,
    gap_totals: gaps.total,
    gap_by_spec: gaps.by_spec,
    statement,
    receipts,
    pending_confirmations: statement.pending_confirmations,
    emergency_adjustments: statement.emergency_adjustments,
  };
}

/** 公开页面：仅脱敏结论——不出现任何企业、地区、工厂、产线、批次、承诺标识。 */
export function publicView(view) {
  const scenario = buildScenario(view);
  const specSet = new Set(view.demands.map((d) => d.spec_id));

  const bySpecWindow = [];
  for (const spec of specSet) {
    const windows = new Set(view.demands.filter((d) => d.spec_id === spec).map((d) => d.window_id));
    for (const win of windows) {
      const rows = scenario.windows.find((w) => w.window_id === win)?.rows ?? [];
      const here = rows.filter((r) => r.spec_id === spec);
      const demand = here.reduce((a, r) => a + r.demand_qty, 0);
      const confirmed = here.reduce((a, r) => a + r.confirmed_qty, 0);
      const arrived = here.reduce((a, r) => a + r.arrived_qty, 0);
      const shortage = here.reduce((a, r) => a + r.shortage_qty, 0);
      const minimumGap = here.reduce((a, r) => a + r.minimum_line_gap_qty, 0);
      const regionsInNeed = new Set(here.filter((r) => r.shortage_qty > 0).map((r) => r.region_id)).size;
      const regionsBelowMinimum = new Set(
        here.filter((r) => r.minimum_line_gap_qty > 0).map((r) => r.region_id),
      ).size;
      bySpecWindow.push({
        spec_id: spec,
        window_id: win,
        demand_qty: demand,
        covered_qty: confirmed + arrived,
        shortage_qty: shortage,
        coverage_ratio: demand === 0 ? 1 : Number(((confirmed + arrived) / demand).toFixed(4)),
        conclusion:
          shortage === 0
            ? '供需平衡'
            : minimumGap > 0
              ? '部分地区低于最低保障线'
              : '存在区域性缺口',
        // 只有计数，没有任何地区标识。
        regions_with_gap_count: regionsInNeed,
        regions_below_minimum_line_count: regionsBelowMinimum,
      });
    }
  }
  bySpecWindow.sort((a, b) => a.spec_id.localeCompare(b.spec_id) || a.window_id.localeCompare(b.window_id));

  return {
    viewer: 'public',
    round_id: view.meta.round_id,
    round_closed: view.closed,
    published_at: new Date().toISOString(),
    notice: '本页仅为脱敏汇总结论，不构成行政分配依据',
    conclusions: bySpecWindow,
    conservation_ok: view.capacities.every((c) => c.locked_qty <= c.effective_qty),
  };
}
