import {
  DEMAND_TIERS,
  lockedByLot,
  lotDeliverableInMonth,
  monthIntersectsWindow,
  monthOf,
  monthsInWindow,
  sumQuantities,
} from './model.js';

/**
 * 情景比较（纯函数，不改动账本）：检修、质检放行、在途数量、最低保障线
 * 与已锁定产能一同进入计算。输出仅为协调建议，不会锁定任何可用量，
 * 也不会自动成为行政分配；承诺以企业确认为准。
 */
export function computeScenario(state, { drug_id, spec } = {}) {
  const lots = Object.values(state.lots).filter(
    (lot) => (!drug_id || lot.drug_id === drug_id) && (!spec || lot.spec === spec),
  );
  // 需求不因缺少产能申报而隐藏：零供给下的缺口正是专班要协调的对象
  const demands = Object.values(state.demands).filter(
    (demand) => (!drug_id || demand.drug_id === drug_id) && (!spec || demand.spec === spec),
  );

  const locked = lockedByLot(state);
  const maintenances = Object.values(state.constraints).filter((constraint) => constraint.kind === 'maintenance');
  const inTransits = Object.values(state.constraints)
    .filter((constraint) => constraint.kind === 'in_transit')
    .filter((item) => (!drug_id || item.drug_id === drug_id) && (!spec || item.spec === spec));
  const guarantees = Object.values(state.constraints)
    .filter((constraint) => constraint.kind === 'min_guarantee')
    .filter((item) => (!drug_id || item.drug_id === drug_id) && (!spec || item.spec === spec));

  const months = [...new Set(demands.map((demand) => demand.month))].sort();

  const blockedMonthsByLot = {};
  for (const lot of lots) {
    const blocked = new Set();
    for (const maintenance of maintenances) {
      if (maintenance.factory_id !== lot.factory_id || maintenance.line_id !== lot.line_id) continue;
      for (const month of monthsInWindow(lot.window)) {
        if (monthIntersectsWindow(month, maintenance.window)) blocked.add(month);
      }
    }
    blockedMonthsByLot[lot.lot_id] = [...blocked].sort();
  }

  // 批次剩余可用池：当前申报量 - 已锁定量（已确认承诺占用）。提议不占用。
  const pool = {};
  for (const lot of lots) {
    pool[lot.lot_id] = lot.current_quantity - (locked[lot.lot_id] ?? 0);
  }

  // 在途量先冲抵本地区同月需求
  const inTransitCovered = new Map();
  for (const item of inTransits) {
    const key = inTransitKeyOf(item.region_id, monthOf(item.arrives_at));
    inTransitCovered.set(key, (inTransitCovered.get(key) ?? 0) + item.quantity);
  }

  const allocation = [];
  const gaps = [];
  const remaining = new Map(demands.map((demand) => [demand.demand_id, demand.quantity]));

  for (const month of months) {
    const monthDemands = demands
      .filter((demand) => demand.month === month)
      .sort((a, b) => {
        const tierGap = DEMAND_TIERS.indexOf(a.tier) - DEMAND_TIERS.indexOf(b.tier);
        if (tierGap !== 0) return tierGap;
        // 同分级内，距最低保障线缺口越大越优先，其次需求量大者优先
        const aFloor = guaranteeOf(guarantees, a.region_id, month);
        const bFloor = guaranteeOf(guarantees, b.region_id, month);
        const aShortfall = Math.max(0, aFloor - (inTransitCovered.get(inTransitKeyOf(a.region_id, month)) ?? 0));
        const bShortfall = Math.max(0, bFloor - (inTransitCovered.get(inTransitKeyOf(b.region_id, month)) ?? 0));
        if (aShortfall !== bShortfall) return bShortfall - aShortfall;
        return b.quantity - a.quantity;
      });

    for (const demand of monthDemands) {
      let stillNeeded = remaining.get(demand.demand_id);
      const inTransitKey = inTransitKeyOf(demand.region_id, month);
      const inTransit = Math.min(stillNeeded, inTransitCovered.get(inTransitKey) ?? 0);
      // 在途量一次性冲抵，后续同区同月需求不得重复使用
      inTransitCovered.set(inTransitKey, (inTransitCovered.get(inTransitKey) ?? 0) - inTransit);
      stillNeeded -= inTransit;
      const sources = [];
      for (const lot of lots) {
        if (stillNeeded === 0) break;
        if (pool[lot.lot_id] <= 0) continue;
        if (!lotDeliverableInMonth(lot, month, blockedMonthsByLot[lot.lot_id])) continue;
        const take = Math.min(pool[lot.lot_id], stillNeeded);
        if (take > 0) {
          pool[lot.lot_id] -= take;
          stillNeeded -= take;
          sources.push({ lot_id: lot.lot_id, enterprise_id: lot.enterprise_id, quantity: take });
        }
      }
      const allocated = sumQuantities(sources);
      if (allocated > 0) {
        allocation.push({
          region_id: demand.region_id,
          month,
          tier: demand.tier,
          quantity: allocated,
          sources,
          basis: 'advisory',
        });
      }
      const covered = inTransit + allocated;
      const floor = guaranteeOf(guarantees, demand.region_id, month);
      if (covered < demand.quantity || covered < floor) {
        gaps.push({
          region_id: demand.region_id,
          month,
          tier: demand.tier,
          requested: demand.quantity,
          covered_by_in_transit: inTransit,
          allocated,
          gap: demand.quantity - covered,
          min_guarantee: floor,
          below_min_guarantee: covered < floor,
        });
      }
      remaining.set(demand.demand_id, stillNeeded);
    }
  }

  return {
    basis: 'advisory_only',
    notice: '情景结果仅供协调，不自动构成行政分配；可用量以企业确认的承诺锁定为准',
    drug_id: drug_id ?? null,
    spec: spec ?? null,
    months,
    supply: lots.map((lot) => ({
      lot_id: lot.lot_id,
      enterprise_id: lot.enterprise_id,
      factory_id: lot.factory_id,
      line_id: lot.line_id,
      window: lot.window,
      current_quantity: lot.current_quantity,
      locked_quantity: locked[lot.lot_id] ?? 0,
      available_quantity: pool[lot.lot_id],
      qc_release_at: lot.qc_release_at,
      blocked_months: blockedMonthsByLot[lot.lot_id],
    })),
    demand: demands.map((demand) => ({
      demand_id: demand.demand_id,
      region_id: demand.region_id,
      month: demand.month,
      tier: demand.tier,
      quantity: demand.quantity,
      unmet_after_scenario: remaining.get(demand.demand_id),
    })),
    in_transit: inTransits.map((item) => ({
      region_id: item.region_id,
      month: monthOf(item.arrives_at),
      quantity: item.quantity,
    })),
    allocation,
    gaps,
    maintenance_impact: maintenanceImpact(lots, blockedMonthsByLot, maintenances, state),
    pending_commitments: Object.values(state.commitments)
      .filter((commitment) => commitment.status === 'proposed')
      .map((commitment) => ({
        commitment_id: commitment.commitment_id,
        region_id: commitment.region_id,
        quantity: commitment.quantity,
        deliveries: commitment.deliveries,
      })),
  };
}

function guaranteeOf(guarantees, regionId, month) {
  const found = guarantees.find((item) => item.region_id === regionId && item.month === month);
  return found ? found.quantity : 0;
}

function inTransitKeyOf(regionId, month) {
  return `${regionId}|${month}`;
}

/** 一次检修影响哪些产能批次、哪些月份窗口、哪些已锁定交付。 */
function maintenanceImpact(lots, blockedMonthsByLot, maintenances, state) {
  return maintenances.map((maintenance) => {
    const blockedLots = lots
      .filter((lot) => lot.factory_id === maintenance.factory_id && lot.line_id === maintenance.line_id)
      .map((lot) => ({ lot_id: lot.lot_id, months: blockedMonthsByLot[lot.lot_id] }))
      .filter((entry) => entry.months.length > 0);
    const affectedCommitments = Object.values(state.commitments)
      .filter((commitment) => commitment.status === 'confirmed')
      .filter((commitment) =>
        commitment.backing.some((slice) =>
          blockedLots.some((entry) => entry.lot_id === slice.lot_id),
        ),
      )
      .filter((commitment) => commitment.deliveries.some((delivery) => monthIntersectsWindow(delivery.month, maintenance.window)))
      .map((commitment) => ({
        commitment_id: commitment.commitment_id,
        region_id: commitment.region_id,
        months: commitment.deliveries
          .filter((delivery) => monthIntersectsWindow(delivery.month, maintenance.window))
          .map((delivery) => delivery.month),
      }));
    return {
      constraint_id: maintenance.constraint_id,
      factory_id: maintenance.factory_id,
      line_id: maintenance.line_id,
      window: maintenance.window,
      blocked_lots: blockedLots,
      affected_commitments: affectedCommitments,
    };
  });
}
