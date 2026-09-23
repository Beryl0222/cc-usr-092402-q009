import { computeScenario } from './scenario.js';
import { fulfilledTotal } from './model.js';

/**
 * 三类可见性视图，均为只读派生：
 * - 企业视图：本企业产能与承诺明细 + 跨地区汇总缺口（不含其他企业与地区标识）；
 * - 专班视图：全局情景、承诺、回执、异常、冻结对账单与人工调整；
 * - 公开视图：只呈现脱敏后的结论性数字，不含企业、地区、工厂、产线标识。
 */

export function enterpriseView(state, enterpriseId) {
  const lots = Object.values(state.lots)
    .filter((lot) => lot.enterprise_id === enterpriseId)
    .map((lot) => ({
      lot_id: lot.lot_id,
      drug_id: lot.drug_id,
      spec: lot.spec,
      factory_id: lot.factory_id,
      line_id: lot.line_id,
      window: { ...lot.window },
      declared_quantity: lot.declared_quantity,
      current_quantity: lot.current_quantity,
      qc_release_at: lot.qc_release_at,
      revisions: lot.revisions.map((record) => ({ ...record })),
    }));

  const commitments = Object.values(state.commitments)
    .filter((commitment) => commitment.enterprise_id === enterpriseId)
    .map((commitment) => ({
      commitment_id: commitment.commitment_id,
      round_id: commitment.round_id,
      region_id: commitment.region_id,
      drug_id: commitment.drug_id,
      spec: commitment.spec,
      status: commitment.status,
      original_quantity: commitment.original_quantity,
      quantity: commitment.quantity,
      deliveries: commitment.deliveries.map((delivery) => ({ ...delivery })),
      backing: commitment.backing.map((slice) => ({ ...slice })),
      confirmed_at: commitment.confirmed_at,
      fulfilled_quantity: fulfilledTotal(commitment),
      fulfillments: commitment.fulfillments.map((record) => ({
        fulfillment_id: record.fulfillment_id,
        version: record.version,
        corrects: record.corrects,
        quantity: record.delivered.reduce((total, row) => total + row.quantity, 0),
        reason: record.reason,
        occurred_at: record.occurred_at,
      })),
    }));

  return {
    basis: 'self_detail_and_aggregated_gap',
    enterprise_id: enterpriseId,
    lots,
    commitments,
    gap_summary: aggregateGaps(state),
  };
}

/** 汇总缺口：按药品、规格、月份、分级聚合，不列地区与其他企业明细。 */
function aggregateGaps(state) {
  const confirmed = Object.values(state.commitments).filter((commitment) => commitment.status === 'confirmed');
  const rows = new Map();
  const keyOf = (row) => [row.drug_id, row.spec, row.month, row.tier ?? ''].join('|');
  for (const demand of Object.values(state.demands)) {
    const key = keyOf(demand);
    const row = rows.get(key) ?? {
      drug_id: demand.drug_id,
      spec: demand.spec,
      month: demand.month,
      tier: demand.tier,
      requested: 0,
      covered: 0,
      gap: 0,
      regions: 0,
    };
    row.requested += demand.quantity;
    row.regions += 1;
    rows.set(key, row);
  }
  for (const commitment of confirmed) {
    for (const demand of Object.values(state.demands)) {
      if (
        demand.region_id !== commitment.region_id ||
        demand.drug_id !== commitment.drug_id ||
        demand.spec !== commitment.spec
      ) {
        continue;
      }
      for (const delivery of commitment.deliveries) {
        if (delivery.month !== demand.month) continue;
        const row = rows.get(keyOf(demand));
        if (row) row.covered = Math.min(row.requested, row.covered + delivery.quantity);
      }
    }
  }
  for (const inTransit of Object.values(state.constraints).filter((item) => item.kind === 'in_transit')) {
    const month = inTransit.arrives_at.slice(0, 7);
    for (const row of rows.values()) {
      if (row.drug_id === inTransit.drug_id && row.spec === inTransit.spec && row.month === month) {
        row.covered = Math.min(row.requested, row.covered + inTransit.quantity);
      }
    }
  }
  return [...rows.values()]
    .map((row) => ({ ...row, gap: Math.max(0, row.requested - row.covered), regions: row.regions }))
    .sort((a, b) => a.month.localeCompare(b.month) || b.gap - a.gap);
}

export function taskForceView(state, receipts = [], options = {}) {
  const scenario = computeScenario(state, options);
  return {
    basis: 'full_coordination',
    scenario,
    commitments: Object.values(state.commitments).map((commitment) => ({
      commitment_id: commitment.commitment_id,
      round_id: commitment.round_id,
      enterprise_id: commitment.enterprise_id,
      region_id: commitment.region_id,
      drug_id: commitment.drug_id,
      spec: commitment.spec,
      status: commitment.status,
      original_quantity: commitment.original_quantity,
      quantity: commitment.quantity,
      deliveries: commitment.deliveries.map((delivery) => ({ ...delivery })),
      backing: commitment.backing.map((slice) => ({ ...slice })),
      withdrawals: commitment.withdrawals.map((record) => ({
        quantity: record.quantity,
        reason: record.reason,
        occurred_at: record.occurred_at,
      })),
      fulfilled_quantity: fulfilledTotal(commitment),
    })),
    receipts: receipts.map((receipt) => ({ ...receipt })),
    exceptions: state.exceptions.map((exception) => structuredClone(exception)),
    adjustments: state.adjustments.map((adjustment) => structuredClone(adjustment)),
    rounds: Object.values(state.rounds).map((round) => ({
      round_id: round.round_id,
      status: round.status,
      opened_at: round.opened_at,
      closed_at: round.closed_at,
      statement: round.statement ? structuredClone(round.statement) : null,
    })),
  };
}

/** 公开页面：脱敏结论，仅药品/规格/月份维度的供需结论与短缺状态。 */
export function publicView(state) {
  const summary = aggregateGaps(state);
  const conclusions = summary.map((row) => {
    const coverage = row.requested === 0 ? 1 : row.covered / row.requested;
    return {
      drug_id: row.drug_id,
      spec: row.spec,
      month: row.month,
      tier: row.tier,
      requested: row.requested,
      covered: row.covered,
      gap: row.gap,
      coverage_ratio: Number(coverage.toFixed(4)),
      shortage_level: coverage >= 1 ? 'balanced' : coverage >= 0.8 ? 'tight' : 'shortage',
      affected_region_count: row.regions,
    };
  });
  return {
    basis: 'desensitized_conclusion_only',
    notice: '公开结论不包含企业、地区、工厂、产线及批次标识，明细以协调专班口径为准',
    conclusions,
    totals: {
      requested: conclusions.reduce((total, row) => total + row.requested, 0),
      covered: conclusions.reduce((total, row) => total + row.covered, 0),
      gap: conclusions.reduce((total, row) => total + row.gap, 0),
      shortage_items: conclusions.filter((row) => row.shortage_level === 'shortage').length,
    },
  };
}
