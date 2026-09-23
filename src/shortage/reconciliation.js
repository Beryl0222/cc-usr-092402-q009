import { fulfilledTotal, monthOf, sumQuantities } from './model.js';

/**
 * 轮次对账单：轮次关闭时冻结。明确哪笔产能支撑哪项承诺、
 * 仍有多少缺口、谁尚未确认；履约更正与原记录并列留存而非覆盖。
 */
export function buildStatement(state, roundId) {
  const commitments = Object.values(state.commitments).filter((commitment) => commitment.round_id === roundId);
  const commitmentIds = new Set(commitments.map((commitment) => commitment.commitment_id));
  const demands = Object.values(state.demands);
  const inTransits = Object.values(state.constraints).filter((constraint) => constraint.kind === 'in_transit');

  const entries = commitments.map((commitment) => {
    const lotById = state.lots;
    return {
      commitment_id: commitment.commitment_id,
      enterprise_id: commitment.enterprise_id,
      region_id: commitment.region_id,
      drug_id: commitment.drug_id,
      spec: commitment.spec,
      status: commitment.status,
      original_quantity: commitment.original_quantity,
      quantity: commitment.quantity,
      withdrawn_quantity: commitment.original_quantity - commitment.quantity,
      deliveries: commitment.deliveries.map((delivery) => ({ ...delivery })),
      // 哪笔产能支撑哪项承诺：逐条列示批次与占用量（跨月交付合并在批次行）
      backing: commitment.backing.map((slice) => ({
        lot_id: slice.lot_id,
        quantity: slice.quantity,
        enterprise_id: lotById[slice.lot_id]?.enterprise_id,
        factory_id: lotById[slice.lot_id]?.factory_id,
        line_id: lotById[slice.lot_id]?.line_id,
        window: lotById[slice.lot_id] ? { ...lotById[slice.lot_id].window } : null,
      })),
      confirmed_at: commitment.confirmed_at,
      withdrawals: commitment.withdrawals.map((record) => ({ ...record, deliveries: record.deliveries.map((row) => ({ ...row })) })),
      fulfilled_quantity: fulfilledTotal(commitment),
      // 原始履约与每次更正并列，按版本链排列
      fulfillments: commitment.fulfillments.map((record) => ({
        fulfillment_id: record.fulfillment_id,
        version: record.version,
        corrects: record.corrects,
        delivered: record.delivered.map((row) => ({ ...row })),
        quantity: sumQuantities(record.delivered),
        reason: record.reason,
        occurred_at: record.occurred_at,
      })),
    };
  });

  const confirmed = commitments.filter((commitment) => commitment.status === 'confirmed');
  const demandGaps = demands.map((demand) => {
    const coveredByCommitments = confirmed
      .filter(
        (commitment) =>
          commitment.region_id === demand.region_id &&
          commitment.drug_id === demand.drug_id &&
          commitment.spec === demand.spec,
      )
      .reduce(
        (total, commitment) =>
          total +
          commitment.deliveries
            .filter((delivery) => delivery.month === demand.month)
            .reduce((subtotal, delivery) => subtotal + delivery.quantity, 0),
        0,
      );
    const coveredByInTransit = inTransits
      .filter(
        (item) =>
          item.region_id === demand.region_id &&
          item.drug_id === demand.drug_id &&
          item.spec === demand.spec &&
          monthOf(item.arrives_at) === demand.month,
      )
      .reduce((total, item) => total + item.quantity, 0);
    return {
      demand_id: demand.demand_id,
      region_id: demand.region_id,
      drug_id: demand.drug_id,
      spec: demand.spec,
      month: demand.month,
      tier: demand.tier,
      requested: demand.quantity,
      covered_by_commitments: coveredByCommitments,
      covered_by_in_transit: coveredByInTransit,
      gap: Math.max(0, demand.quantity - coveredByCommitments - coveredByInTransit),
    };
  });

  const round = state.rounds[roundId];
  return {
    statement_id: `stmt-${roundId}`,
    round_id: roundId,
    frozen_at: round?.closed_at ?? null,
    totals: {
      commitments: commitments.length,
      confirmed: confirmed.length,
      proposed: commitments.filter((commitment) => commitment.status === 'proposed').length,
      withdrawn: commitments.filter((commitment) => commitment.status === 'withdrawn').length,
      confirmed_quantity: confirmed.reduce((total, commitment) => total + commitment.quantity, 0),
      fulfilled_quantity: confirmed.reduce((total, commitment) => total + fulfilledTotal(commitment), 0),
      requested_quantity: demands.reduce((total, demand) => total + demand.quantity, 0),
      gap_quantity: demandGaps.reduce((total, row) => total + row.gap, 0),
    },
    entries,
    demand_gaps: demandGaps,
    // 谁尚未确认：仍停留在提议状态的承诺及其企业
    pending_confirmations: commitments
      .filter((commitment) => commitment.status === 'proposed')
      .map((commitment) => ({
        commitment_id: commitment.commitment_id,
        enterprise_id: commitment.enterprise_id,
        region_id: commitment.region_id,
        quantity: commitment.quantity,
        proposed_at: commitment.proposed_at,
      })),
    adjustments: state.adjustments
      .filter((adjustment) => adjustment.operations.some((operation) => commitmentIds.has(operation.commitment_id)))
      .map((adjustment) => ({
        adjustment_id: adjustment.adjustment_id,
        reason: adjustment.reason,
        alternatives: adjustment.alternatives.map((item) => ({ ...item })),
        occurred_at: adjustment.occurred_at,
      })),
    exceptions: state.exceptions
      .filter((exception) => referencesCommitment(exception, commitmentIds))
      .map((exception) => ({ ...exception, detail: structuredClone(exception.detail) })),
  };
}

function referencesCommitment(exception, commitmentIds) {
  return typeof exception.detail === 'object' && exception.detail !== null && commitmentIds.has(exception.detail.commitment_id);
}
