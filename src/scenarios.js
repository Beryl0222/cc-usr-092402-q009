// 短缺情景试算：对台账只读，不产生任何锁定或行政分配。
// 输出一律 advisory=true；建议落账必须先走 proposeCommitment 并由企业确认。

import { monthCompare } from './ledger.js';

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function sortedWindows(windows) {
  return [...new Set(windows)].sort(monthCompare);
}

/**
 * 计算全局短缺情景。
 * @param {object} view CoordinationRound.view() 的只读快照
 * @param {object} [opts]
 * @param {string[]} [opts.windows] 只试算指定月份窗（默认：出现过需求的全部窗）
 */
export function buildScenario(view, opts = {}) {
  const demandWindows = sortedWindows(view.demands.map((d) => d.window_id));
  const windows = opts.windows ? sortedWindows(opts.windows) : demandWindows;

  // 已确认承诺按 地区|规格|窗 汇总（撤回/紧急调减后的余量才是有效支撑）。
  const confirmed = new Map(); // region|spec|window -> qty
  const unconfirmed = [];
  for (const c of view.commitments) {
    if (c.status === 'proposed') {
      unconfirmed.push({
        commitment_id: c.commitment_id,
        enterprise_id: c.enterprise_id,
        region_id: c.region_id,
        spec_id: c.spec_id,
        qty: c.remaining_qty,
        proposed_at: c.proposed_at,
      });
    }
    if (c.status !== 'confirmed') continue;
    for (const s of c.slices) {
      const key = `${c.region_id}|${c.spec_id}|${s.window_id}`;
      confirmed.set(key, (confirmed.get(key) ?? 0) + s.remaining_qty);
    }
  }

  // 在途：未抵达部分按预计抵达窗计入目的地区；已抵达按实际抵达窗计入。
  const arrivals = new Map(); // region|spec|window -> {arrived, in_transit}
  const bump = (key, win, field, n) => {
    const k = `${key}|${win}`;
    const row = arrivals.get(k) ?? { arrived: 0, in_transit: 0 };
    row[field] += n;
    arrivals.set(k, row);
  };
  for (const s of view.shipments) {
    const key = `${s.destination_region_id}|${s.spec_id}`;
    for (const a of s.arrivals) bump(key, a.window_id, 'arrived', a.qty);
    if (s.remaining_qty > 0) bump(key, s.eta_window_id, 'in_transit', s.remaining_qty);
  }

  // 检修影响一览：台账已把扣减计入 effective_qty；这里关联到受波及产能所支撑的交付窗，
  // 让专班直接看到"一次检修会影响哪些交付窗口/地区"。
  const maintenanceImpacts = [];
  for (const m of view.maintenance) {
    for (const i of m.impacts) {
      const affectedCapacityIds = new Set(
        view.capacities
          .filter(
            (c) =>
              c.enterprise_id === m.enterprise_id &&
              c.factory_id === m.factory_id &&
              c.line_id === m.line_id &&
              c.window_id === m.window_id &&
              c.spec_id === i.spec_id,
          )
          .map((c) => c.capacity_id),
      );
      const affectedDeliveries = [];
      for (const c of view.commitments) {
        if (!affectedCapacityIds.has(c.capacity_id)) continue;
        for (const s of c.slices) {
          affectedDeliveries.push({
            region_id: c.region_id,
            window_id: s.window_id,
            commitment_id: c.commitment_id,
            status: c.status,
            remaining_qty: s.remaining_qty,
          });
        }
      }
      maintenanceImpacts.push({
        maintenance_id: m.maintenance_id,
        enterprise_id: m.enterprise_id,
        factory_id: m.factory_id,
        line_id: m.line_id,
        spec_id: i.spec_id,
        window_id: m.window_id,
        down_qty: i.down_qty,
        note: m.note,
        affected_delivery_windows: [...new Set(affectedDeliveries.map((d) => d.window_id))].sort(),
        affected_deliveries: affectedDeliveries,
      });
    }
  }

  // 现货池（质检放行，可分批）与自由产能池；建议只锁定自由产能，现货仅展示供人工协调。
  const releasedPool = new Map(); // spec|window -> qty
  for (const b of view.batches) {
    for (const r of b.releases) {
      const key = `${b.spec_id}|${r.window_id}`;
      releasedPool.set(key, (releasedPool.get(key) ?? 0) + r.qty);
    }
  }

  // 按 (规格, 生产窗) 汇总仍可承诺的产能；逐条保留来源以支撑可追溯建议。
  const freeBySpecWin = new Map(); // spec|window -> [capacity rows with free_qty>0]
  for (const cap of view.capacities) {
    if (cap.free_qty <= 0) continue;
    const key = `${cap.spec_id}|${cap.window_id}`;
    if (!freeBySpecWin.has(key)) freeBySpecWin.set(key, []);
    freeBySpecWin.get(key).push(cap);
  }

  const allSuggestions = [];
  // 跨窗共享的可建议量账本：同一笔生产产能不能在 9 月交付窗和 10 月交付窗各被建议一次。
  const scenarioFree = new Map(); // capacity_id -> 本情景中尚未建议出去的量（跨全部窗）
  const suggestedByWindow = new Map(); // window_id|capacity_id -> 本窗建议量
  const windowReports = windows.map((win) => {
    const demandsHere = view.demands
      .filter((d) => d.window_id === win)
      .sort((a, b) => a.tier - b.tier || a.region_id.localeCompare(b.region_id));

    // 可支撑本窗的自由产能：生产窗不晚于交付窗；按生产窗先后、产能编号排序，保证可重复。
    const capacityPool = [];
    for (const [key, caps] of freeBySpecWin) {
      const [spec, prodWin] = key.split('|');
      if (monthCompare(prodWin, win) <= 0) {
        for (const cap of caps) {
          if (!scenarioFree.has(cap.capacity_id)) scenarioFree.set(cap.capacity_id, cap.free_qty);
          capacityPool.push({ spec, cap });
        }
      }
    }
    capacityPool.sort(
      (a, b) =>
        monthCompare(a.cap.window_id, b.cap.window_id) ||
        a.cap.capacity_id.localeCompare(b.cap.capacity_id),
    );

    const rows = demandsHere.map((d) => {
      const key = `${d.region_id}|${d.spec_id}`;
      const confirmedQty = confirmed.get(`${key}|${win}`) ?? 0;
      const flow = arrivals.get(`${key}|${win}`) ?? { arrived: 0, in_transit: 0 };
      const releasedQty = releasedPool.get(`${d.spec_id}|${win}`) ?? 0;
      const shortage = Math.max(0, d.qty - confirmedQty - flow.arrived);
      // 在途按预计抵达窗进入情景比较：预计缺口把在途当作可如期到货，实际缺口仍保守不计。
      const projectedGap = Math.max(0, d.qty - confirmedQty - flow.arrived - flow.in_transit);
      const minimumGap = Math.max(0, d.minimum_line - confirmedQty - flow.arrived);
      const projectedMinimumGap = Math.max(
        0,
        d.minimum_line - confirmedQty - flow.arrived - flow.in_transit,
      );
      return {
        region_id: d.region_id,
        spec_id: d.spec_id,
        tier: d.tier,
        window_id: win,
        demand_qty: d.qty,
        minimum_line: d.minimum_line,
        confirmed_qty: confirmedQty,
        arrived_qty: flow.arrived,
        in_transit_qty: flow.in_transit,
        released_inventory_qty: releasedQty,
        shortage_qty: shortage,
        projected_gap_qty: projectedGap,
        minimum_line_gap_qty: minimumGap,
        projected_minimum_line_gap_qty: projectedMinimumGap,
        covered_by_suggestion_qty: 0,
        suggestions: [],
      };
    });

    // 两遍分配：先保最低保障线，再按分级（tier 1 优先）补预计缺口。
    // 预计口径已计入在途如期到货，避免把同一笔需求同时建议给在途与新产能；
    // 实际缺口（不计在途）仍保守并列呈现。
    // 注意：现货池只展示、不自动划转；自动建议全部落到可锁定的自由产能。
    for (const pass of ['minimum_line', 'remaining']) {
      for (const row of rows) {
        let need =
          pass === 'minimum_line'
            ? Math.max(0, row.projected_minimum_line_gap_qty - row.covered_by_suggestion_qty)
            : Math.max(0, row.projected_gap_qty - row.covered_by_suggestion_qty);
        if (need <= 0) continue;
        for (const item of capacityPool) {
          if (item.spec !== row.spec_id) continue;
          const avail = scenarioFree.get(item.cap.capacity_id) ?? 0;
          if (avail <= 0) continue;
          const take = Math.min(avail, need);
          if (take <= 0) continue;
          scenarioFree.set(item.cap.capacity_id, avail - take);
          suggestedByWindow.set(
            `${win}|${item.cap.capacity_id}`,
            (suggestedByWindow.get(`${win}|${item.cap.capacity_id}`) ?? 0) + take,
          );
          // 生产窗早于交付窗时，建议为本窗交付（跨月切片由专班在落账时按需拆分）。
          const suggestion = {
            source_type: 'free_capacity',
            capacity_id: item.cap.capacity_id,
            enterprise_id: item.cap.enterprise_id,
            factory_id: item.cap.factory_id,
            line_id: item.cap.line_id,
            region_id: row.region_id,
            spec_id: row.spec_id,
            qty: take,
            slices: [{ window_id: win, qty: take }],
          };
          row.suggestions.push(suggestion);
          allSuggestions.push(suggestion);
          row.covered_by_suggestion_qty += take;
          need -= take;
          if (need <= 0) break;
        }
      }
    }

    for (const row of rows) {
      row.residual_gap_qty = Math.max(0, row.shortage_qty - row.covered_by_suggestion_qty);
    }

    const sources = capacityPool.map(({ spec, cap }) => ({
      spec_id: spec,
      capacity_id: cap.capacity_id,
      enterprise_id: cap.enterprise_id,
      factory_id: cap.factory_id,
      line_id: cap.line_id,
      production_window_id: cap.window_id,
      effective_qty: cap.effective_qty,
      locked_qty: cap.locked_qty,
      free_qty: cap.free_qty,
      suggested_qty: suggestedByWindow.get(`${win}|${cap.capacity_id}`) ?? 0,
    }));

    return { window_id: win, rows, sources };
  });

  return {
    advisory: true,
    note: '结果只供协调，不构成行政分配；建议须经企业 commitment_confirmed 后才锁定',
    windows: windowReports,
    suggestions: allSuggestions,
    maintenance_impacts: maintenanceImpacts,
    released_inventory: [...releasedPool.entries()].map(([key, qty]) => {
      const [spec_id, window_id] = key.split('|');
      return { spec_id, window_id, qty };
    }),
    unconfirmed,
  };
}

/** 汇总缺口：总缺口、最低保障线缺口、建议可覆盖与残余缺口。 */
export function summarizeGaps(scenario) {
  const sum = (acc, row) => {
    acc.demand_qty += row.demand_qty;
    acc.shortage_qty += row.shortage_qty;
    acc.minimum_line_gap_qty += row.minimum_line_gap_qty;
    acc.covered_by_suggestion_qty += row.covered_by_suggestion_qty;
    acc.residual_gap_qty += row.residual_gap_qty;
    return acc;
  };
  const bySpec = new Map();
  const total = {
    demand_qty: 0,
    shortage_qty: 0,
    minimum_line_gap_qty: 0,
    covered_by_suggestion_qty: 0,
    residual_gap_qty: 0,
  };
  for (const w of scenario.windows) {
    for (const row of w.rows) {
      sum(total, row);
      if (!bySpec.has(row.spec_id)) {
        bySpec.set(row.spec_id, {
          spec_id: row.spec_id,
          demand_qty: 0,
          shortage_qty: 0,
          minimum_line_gap_qty: 0,
          covered_by_suggestion_qty: 0,
          residual_gap_qty: 0,
        });
      }
      sum(bySpec.get(row.spec_id), row);
    }
  }
  return { total, by_spec: [...bySpec.values()] };
}
