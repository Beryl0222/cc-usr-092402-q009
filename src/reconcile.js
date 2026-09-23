// 对账单：每轮协调结束（或过程中）生成。
// 必须明确：哪笔产能支撑哪项承诺、还剩多少缺口、谁尚未确认；
// 履约更正与原承诺并列留存，不覆盖；并给出总量守恒检查结论。

function check(name, violations, detail) {
  return { name, ok: violations.length === 0, violations, detail };
}

/**
 * @param {object} view CoordinationRound.view()
 * @param {object} [scenario] 可选，buildScenario 的结果；带入缺口与建议列
 */
export function buildStatement(view, scenario = null) {
  const generatedAt = new Date().toISOString();

  // 1) 产能 ↔ 承诺对照（含未确认建议，专班能看到同一产能被多少地区"排队"）。
  const capacityIndex = new Map(view.capacities.map((c) => [c.capacity_id, c]));
  const supportedByCapacity = new Map();
  for (const c of view.commitments) {
    if (!supportedByCapacity.has(c.capacity_id)) supportedByCapacity.set(c.capacity_id, []);
    supportedByCapacity.get(c.capacity_id).push({
      commitment_id: c.commitment_id,
      region_id: c.region_id,
      status: c.status,
      origin: c.origin,
      qty: c.qty,
      remaining_qty: c.remaining_qty,
      slices: c.slices.map((s) => ({
        window_id: s.window_id,
        qty: s.qty,
        withdrawn_qty: s.withdrawn_qty,
        remaining_qty: s.remaining_qty,
      })),
      proposed_at: c.proposed_at,
      confirmed_at: c.confirmed_at,
    });
  }

  const capacityLines = view.capacities.map((cap) => ({
    capacity_id: cap.capacity_id,
    enterprise_id: cap.enterprise_id,
    factory_id: cap.factory_id,
    line_id: cap.line_id,
    spec_id: cap.spec_id,
    window_id: cap.window_id,
    declared_qty: cap.declared_qty,
    current_qty: cap.current_qty,
    revisions: cap.revisions.map((r) => ({ new_qty: r.new_qty, reason: r.reason, at: r.at })),
    maintenance_qty: cap.maintenance_qty,
    effective_qty: cap.effective_qty,
    locked_qty: cap.locked_qty,
    free_qty: cap.free_qty,
    supported_commitments: supportedByCapacity.get(cap.capacity_id) ?? [],
  }));

  // 2) 地区需求覆盖与缺口。
  const confirmedIndex = new Map();
  const arrivalsIndex = new Map();
  const inTransitIndex = new Map();
  for (const c of view.commitments) {
    if (c.status !== 'confirmed') continue;
    for (const s of c.slices) {
      const key = `${c.region_id}|${c.spec_id}|${s.window_id}`;
      confirmedIndex.set(key, (confirmedIndex.get(key) ?? 0) + s.remaining_qty);
    }
  }
  for (const s of view.shipments) {
    for (const a of s.arrivals) {
      const key = `${s.destination_region_id}|${s.spec_id}|${a.window_id}`;
      arrivalsIndex.set(key, (arrivalsIndex.get(key) ?? 0) + a.qty);
    }
    if (s.remaining_qty > 0) {
      const key = `${s.destination_region_id}|${s.spec_id}|${s.eta_window_id}`;
      inTransitIndex.set(key, (inTransitIndex.get(key) ?? 0) + s.remaining_qty);
    }
  }

  const coverage = view.demands
    .map((d) => {
      const confirmed = confirmedIndex.get(`${d.region_id}|${d.spec_id}|${d.window_id}`) ?? 0;
      const arrived = arrivalsIndex.get(`${d.region_id}|${d.spec_id}|${d.window_id}`) ?? 0;
      const inTransit = inTransitIndex.get(`${d.region_id}|${d.spec_id}|${d.window_id}`) ?? 0;
      const shortage = Math.max(0, d.qty - confirmed - arrived);
      const projectedShortage = Math.max(0, d.qty - confirmed - arrived - inTransit);
      const minimumLineGap = Math.max(0, d.minimum_line - confirmed - arrived);
      return {
        region_id: d.region_id,
        spec_id: d.spec_id,
        window_id: d.window_id,
        tier: d.tier,
        demand_qty: d.qty,
        minimum_line: d.minimum_line,
        confirmed_qty: confirmed,
        arrived_qty: arrived,
        in_transit_qty: inTransit,
        shortage_qty: shortage,
        projected_shortage_qty: projectedShortage,
        minimum_line_gap_qty: minimumLineGap,
        status:
          shortage === 0
            ? 'covered'
            : minimumLineGap > 0
              ? 'below_minimum_line'
              : 'partial_gap',
      };
    })
    .sort(
      (a, b) =>
        a.window_id.localeCompare(b.window_id) ||
        a.tier - b.tier ||
        a.region_id.localeCompare(b.region_id),
    );

  // 3) 谁尚未确认。
  const pendingConfirmations = view.commitments
    .filter((c) => c.status === 'proposed')
    .map((c) => ({
      commitment_id: c.commitment_id,
      enterprise_id: c.enterprise_id, // 尚未确认的一方
      region_id: c.region_id,
      spec_id: c.spec_id,
      qty: c.qty,
      proposed_at: c.proposed_at,
      capacity_id: c.capacity_id,
    }));

  // 4) 履约更正与原承诺并列（只追加，永不覆盖）。
  const corrections = [];
  for (const c of view.commitments) {
    for (const s of c.slices) {
      for (const [i, x] of s.corrections.entries()) {
        corrections.push({
          commitment_id: c.commitment_id,
          enterprise_id: c.enterprise_id,
          region_id: c.region_id,
          spec_id: c.spec_id,
          window_id: x.window_id,
          original_slice_qty: s.qty, // 原承诺（保留）
          original_remaining_qty: s.remaining_qty,
          correction_seq: i + 1,
          corrected_fulfilled_qty: x.corrected_qty, // 履约更正（并列）
          variance_qty: x.corrected_qty - s.qty,
          note: x.note,
          at: x.at,
        });
      }
    }
  }

  // 5) 总量守恒检查。
  const violations1 = view.capacities.filter((c) => c.locked_qty > c.effective_qty).map((c) => ({
    capacity_id: c.capacity_id,
    effective_qty: c.effective_qty,
    locked_qty: c.locked_qty,
  }));

  const violations2 = [];
  for (const c of view.commitments) {
    const sliceTotal = c.slices.reduce((a, s) => a + s.qty, 0);
    if (sliceTotal !== c.qty) {
      violations2.push({ commitment_id: c.commitment_id, problem: '切片合计不等于承诺总量' });
    }
    for (const s of c.slices) {
      if (s.withdrawn_qty > s.qty || s.remaining_qty < 0 || s.withdrawn_qty + s.remaining_qty !== s.qty) {
        violations2.push({
          commitment_id: c.commitment_id,
          window_id: s.window_id,
          problem: '切片撤回/余量不守恒',
        });
      }
    }
    if (!capacityIndex.has(c.capacity_id)) {
      violations2.push({ commitment_id: c.commitment_id, problem: '承诺指向不存在的产能' });
    }
  }

  const violations3 = [];
  for (const s of view.shipments) {
    const settled = s.arrived_total + s.cancelled_qty + s.remaining_qty;
    if (settled !== s.qty) {
      violations3.push({ shipment_id: s.shipment_id, reported_qty: s.qty, accounted_qty: settled });
    }
  }

  // 质检延期：放行走延期事件只在窗间挪动，逐批合计应始终非负（台账已保证，这里复核呈现）。
  const batchReleases = view.batches.map((b) => ({
    batch_id: b.batch_id,
    spec_id: b.spec_id,
    released_total: b.released_total,
    by_window: b.releases,
  }));
  const violations4 = batchReleases
    .flatMap((b) => b.by_window.filter((r) => r.qty < 0).map((r) => ({ batch_id: b.batch_id, ...r })));

  const checks = [
    check('capacity_locked_le_effective', violations1, '锁定量 ≤ 当前有效产能（已扣检修）'),
    check('commitment_slice_conservation', violations2, '承诺总量 = 各交付窗切片之和；撤回 + 余量 = 切片'),
    check('shipment_conservation', violations3, '在途：抵达 + 取消 + 剩余 = 申报总量'),
    check('qc_release_non_negative', violations4, '质检放行各窗数量非负（延期只跨窗挪动）'),
  ];

  const totals = coverage.reduce(
    (acc, row) => {
      acc.demand_qty += row.demand_qty;
      acc.confirmed_qty += row.confirmed_qty;
      acc.arrived_qty += row.arrived_qty;
      acc.in_transit_qty += row.in_transit_qty;
      acc.shortage_qty += row.shortage_qty;
      acc.projected_shortage_qty += row.projected_shortage_qty;
      acc.minimum_line_gap_qty += row.minimum_line_gap_qty;
      return acc;
    },
    {
      demand_qty: 0,
      confirmed_qty: 0,
      arrived_qty: 0,
      in_transit_qty: 0,
      shortage_qty: 0,
      projected_shortage_qty: 0,
      minimum_line_gap_qty: 0,
    },
  );

  return {
    statement_id: `stmt-${view.meta.round_id}-${generatedAt}`,
    record_id: view.meta.record_id,
    round_id: view.meta.round_id,
    as_of_window: view.meta.as_of_window,
    generated_at: generatedAt,
    round_closed: view.closed,
    round_closed_at: view.closed_at,
    totals,
    capacity_lines: capacityLines,
    coverage,
    pending_confirmations: pendingConfirmations,
    corrections,
    emergency_adjustments: view.adjustments.map((a) => ({
      adjustment_id: a.adjustment_id,
      operator_id: a.operator_id,
      reason: a.reason,
      impacts: a.impacts,
      alternatives: a.alternatives,
      new_commitment_ids: a.new_commitment_ids,
      at: a.at,
    })),
    batch_releases: batchReleases,
    scenario_advisory: scenario
      ? {
          suggestion_count: scenario.suggestions.length,
          residual_gap_windows: scenario.windows
            .filter((w) => w.rows.some((r) => r.residual_gap_qty > 0))
            .map((w) => w.window_id),
        }
      : null,
    conservation: {
      ok: checks.every((c) => c.ok),
      checks,
    },
  };
}
