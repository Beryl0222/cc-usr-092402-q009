import {
  CONSTRAINT_KINDS,
  DEMAND_TIERS,
  datePart,
  fail,
  fulfilledTotal,
  isMonth,
  lockedByLot,
  lotDeliverableInMonth,
  monthEnd,
  monthIntersectsWindow,
  monthsInWindow,
  requireFields,
  requireNonEmptyString,
  requireNonNegativeInt,
  requirePositiveInt,
  sumQuantities,
} from './model.js';
import { buildStatement } from './reconciliation.js';

/**
 * 协调账本：事件追加式。所有业务消息经 ingest 入账，按 message_id 去重，
 * 重复消息直接返回原回执、不再改变状态；被拒绝的业务消息记入回执但不入账。
 * 状态由事件投影而来，履约更正、撤回、异常都只追加、不覆盖。
 */
export function createStore() {
  return {
    events: [],
    receipts: new Map(),
    state: {
      lots: {},
      demands: {},
      constraints: {},
      commitments: {},
      rounds: {},
      exceptions: [],
      adjustments: [],
    },
  };
}

/** 当前状态的安全副本（供视图与外部计算使用，改动不影响账本）。 */
export function project(store) {
  return structuredClone(store.state);
}

export function receiptsOf(store) {
  return [...store.receipts.values()].map((receipt) => ({ ...receipt }));
}

export function ingest(store, message) {
  if (!message || typeof message !== 'object') throw new Error('消息格式非法');
  const { message_id, type, occurred_at } = message;
  requireNonEmptyString(message_id, 'message_id');
  requireNonEmptyString(type, 'type');
  requireNonEmptyString(occurred_at, 'occurred_at');
  const prior = store.receipts.get(message_id);
  if (prior) return { ...prior, duplicate: true };
  let receipt;
  try {
    const event = applyMessage(store.state, message);
    event.seq = store.events.length + 1;
    event.message_id = message_id;
    store.events.push(event);
    receipt = { message_id, seq: event.seq, type, status: 'applied' };
  } catch (error) {
    receipt = { message_id, type, status: 'rejected', reason: error.message };
  }
  store.receipts.set(message_id, receipt);
  return receipt;
}

function applyMessage(state, message) {
  const { type, payload = {}, occurred_at } = message;
  switch (type) {
    case 'capacity_declared':
      return declareCapacity(state, payload, occurred_at);
    case 'capacity_revised':
      return reviseCapacity(state, payload, occurred_at);
    case 'demand_declared':
      return declareDemand(state, payload, occurred_at);
    case 'constraint_reported':
      return reportConstraint(state, payload, occurred_at);
    case 'round_opened':
      return openRound(state, payload, occurred_at);
    case 'round_closed':
      return closeRound(state, payload, occurred_at);
    case 'commitment_proposed':
      return proposeCommitment(state, payload, occurred_at);
    case 'commitment_confirmed':
      return confirmCommitment(state, payload, occurred_at);
    case 'commitment_withdrawn':
      return withdrawCommitment(state, payload, occurred_at);
    case 'fulfillment_reported':
      return reportFulfillment(state, payload, occurred_at);
    case 'fulfillment_corrected':
      return correctFulfillment(state, payload, occurred_at);
    case 'manual_adjustment':
      return manualAdjustment(state, payload, occurred_at);
    default:
      fail(`未知消息类型: ${type}`);
  }
}

function addException(state, kind, occurred_at, detail) {
  const exception_id = `ex-${String(state.exceptions.length + 1).padStart(4, '0')}`;
  state.exceptions.push({ exception_id, kind, occurred_at, detail });
  return exception_id;
}

function normalizeWindow(window) {
  if (!window || !window.start || !window.end) fail('窗口缺少起止日期');
  const normalized = { start: datePart(window.start), end: datePart(window.end) };
  if (normalized.start > normalized.end) fail('窗口起止日期颠倒');
  return normalized;
}

/** 企业按工厂、产线、规格、时间窗申报可追溯产能。 */
function declareCapacity(state, payload, occurred_at) {
  requireFields(
    payload,
    ['lot_id', 'enterprise_id', 'drug_id', 'spec', 'factory_id', 'line_id', 'window', 'quantity'],
    '产能申报',
  );
  if (state.lots[payload.lot_id]) fail(`产能批次已存在: ${payload.lot_id}`);
  requirePositiveInt(payload.quantity, '申报数量');
  const window = normalizeWindow(payload.window);
  state.lots[payload.lot_id] = {
    lot_id: payload.lot_id,
    enterprise_id: payload.enterprise_id,
    drug_id: payload.drug_id,
    spec: payload.spec,
    factory_id: payload.factory_id,
    line_id: payload.line_id,
    window,
    declared_quantity: payload.quantity,
    current_quantity: payload.quantity,
    qc_release_at: null,
    revisions: [],
  };
  return { type: 'capacity_declared', occurred_at, payload };
}

/**
 * 迟到的产量修订只重算未锁定部分：已锁定量保持不变；
 * 修订量低于锁定量时，未锁定部分归零并记录异常，等待人工调整。
 */
function reviseCapacity(state, payload, occurred_at) {
  requireFields(payload, ['lot_id', 'new_quantity', 'reason'], '产量修订');
  const lot = state.lots[payload.lot_id];
  if (!lot) fail(`产能批次不存在: ${payload.lot_id}`);
  requireNonNegativeInt(payload.new_quantity, '修订数量');
  requireNonEmptyString(payload.reason, '修订理由');
  const locked = lockedByLot(state)[payload.lot_id] ?? 0;
  const notes = [];
  let applied = payload.new_quantity;
  if (applied < locked) {
    applied = locked;
    const exceptionId = addException(state, 'revision_below_locked', occurred_at, {
      lot_id: lot.lot_id,
      requested: payload.new_quantity,
      locked,
    });
    notes.push(`修订量低于已锁定量，仅重算未锁定部分并记录异常 ${exceptionId}`);
  }
  lot.current_quantity = applied;
  lot.revisions.push({
    new_quantity: payload.new_quantity,
    applied_quantity: applied,
    reason: payload.reason,
    occurred_at,
  });
  return { type: 'capacity_revised', occurred_at, payload, notes };
}

/** 地区分级需求。同一 demand_id 再次申报视为需求修订，按最新覆盖。 */
function declareDemand(state, payload, occurred_at) {
  requireFields(payload, ['demand_id', 'region_id', 'drug_id', 'spec', 'month', 'tier', 'quantity'], '需求申报');
  if (!DEMAND_TIERS.includes(payload.tier)) fail(`需求分级非法: ${payload.tier}`);
  if (!isMonth(payload.month)) fail(`需求月份非法: ${payload.month}`);
  requirePositiveInt(payload.quantity, '需求数量');
  state.demands[payload.demand_id] = {
    demand_id: payload.demand_id,
    region_id: payload.region_id,
    drug_id: payload.drug_id,
    spec: payload.spec,
    month: payload.month,
    tier: payload.tier,
    quantity: payload.quantity,
    declared_at: occurred_at,
  };
  return { type: 'demand_declared', occurred_at, payload };
}

/** 检修、质检放行、在途数量、最低保障线统一作为约束进入情景比较。 */
function reportConstraint(state, payload, occurred_at) {
  requireFields(payload, ['constraint_id', 'kind'], '约束上报');
  if (!CONSTRAINT_KINDS.includes(payload.kind)) fail(`未知约束类型: ${payload.kind}`);
  const notes = [];
  let record;
  if (payload.kind === 'maintenance') {
    requireFields(payload, ['factory_id', 'line_id', 'window'], '检修计划');
    record = {
      constraint_id: payload.constraint_id,
      kind: payload.kind,
      factory_id: payload.factory_id,
      line_id: payload.line_id,
      window: normalizeWindow(payload.window),
      reported_at: occurred_at,
    };
  } else if (payload.kind === 'qc_release') {
    requireFields(payload, ['lot_id', 'release_at'], '质检放行');
    const lot = state.lots[payload.lot_id];
    if (!lot) fail(`产能批次不存在: ${payload.lot_id}`);
    record = {
      constraint_id: payload.constraint_id,
      kind: payload.kind,
      lot_id: payload.lot_id,
      release_at: datePart(payload.release_at),
      reported_at: occurred_at,
    };
    // 质检延期不改变任何数量，但若撞上已锁定交付月需记录异常供专班协调
    lot.qc_release_at = record.release_at;
    for (const commitment of Object.values(state.commitments)) {
      if (commitment.status !== 'confirmed') continue;
      if (!commitment.backing.some((slice) => slice.lot_id === lot.lot_id)) continue;
      const months = qcConflictMonths(lot, commitment);
      if (months.length > 0) {
        const exceptionId = addException(state, 'qc_delay_conflicts_lock', occurred_at, {
          constraint_id: record.constraint_id,
          lot_id: lot.lot_id,
          commitment_id: commitment.commitment_id,
          months,
        });
        notes.push(`质检放行晚于已锁定交付月，记录异常 ${exceptionId}`);
      }
    }
  } else if (payload.kind === 'in_transit') {
    requireFields(payload, ['enterprise_id', 'drug_id', 'spec', 'region_id', 'quantity', 'arrives_at'], '在途上报');
    requirePositiveInt(payload.quantity, '在途数量');
    record = {
      constraint_id: payload.constraint_id,
      kind: payload.kind,
      enterprise_id: payload.enterprise_id,
      drug_id: payload.drug_id,
      spec: payload.spec,
      region_id: payload.region_id,
      quantity: payload.quantity,
      arrives_at: datePart(payload.arrives_at),
      reported_at: occurred_at,
    };
  } else {
    requireFields(payload, ['region_id', 'drug_id', 'spec', 'month', 'quantity'], '最低保障线');
    if (!isMonth(payload.month)) fail(`保障线月份非法: ${payload.month}`);
    requirePositiveInt(payload.quantity, '保障线数量');
    record = {
      constraint_id: payload.constraint_id,
      kind: payload.kind,
      region_id: payload.region_id,
      drug_id: payload.drug_id,
      spec: payload.spec,
      month: payload.month,
      quantity: payload.quantity,
      reported_at: occurred_at,
    };
  }
  state.constraints[record.constraint_id] = record;
  if (record.kind === 'maintenance') {
    for (const commitment of Object.values(state.commitments)) {
      if (commitment.status !== 'confirmed') continue;
      const months = maintenanceConflictMonths(state, commitment);
      if (months.length > 0) {
        const exceptionId = addException(state, 'maintenance_conflicts_lock', occurred_at, {
          constraint_id: record.constraint_id,
          commitment_id: commitment.commitment_id,
          months,
        });
        notes.push(`检修窗口撞上已锁定交付月，记录异常 ${exceptionId}`);
      }
    }
  }
  return { type: 'constraint_reported', occurred_at, payload, notes };
}

/** 承诺的交付月中，落在其支撑批次产线检修窗口内的月份。 */
function maintenanceConflictMonths(state, commitment) {
  const months = new Set();
  for (const slice of commitment.backing) {
    const lot = state.lots[slice.lot_id];
    if (!lot) continue;
    for (const constraint of Object.values(state.constraints)) {
      if (constraint.kind !== 'maintenance') continue;
      if (constraint.factory_id !== lot.factory_id || constraint.line_id !== lot.line_id) continue;
      for (const delivery of commitment.deliveries) {
        if (monthIntersectsWindow(delivery.month, constraint.window)) months.add(delivery.month);
      }
    }
  }
  return [...months].sort();
}

/** 承诺的交付月中，早于批次质检放行日的月份。 */
function qcConflictMonths(lot, commitment) {
  if (!lot.qc_release_at) return [];
  return commitment.deliveries
    .filter((delivery) => monthEnd(delivery.month) < lot.qc_release_at)
    .map((delivery) => delivery.month);
}

function openRound(state, payload, occurred_at) {
  requireFields(payload, ['round_id'], '轮次开启');
  if (state.rounds[payload.round_id]) fail(`协调轮次已存在: ${payload.round_id}`);
  state.rounds[payload.round_id] = {
    round_id: payload.round_id,
    status: 'open',
    opened_at: occurred_at,
    closed_at: null,
    statement: null,
  };
  return { type: 'round_opened', occurred_at, payload };
}

/** 轮次关闭时生成对账单并冻结在轮次上，后续事件不回写该对账单。 */
function closeRound(state, payload, occurred_at) {
  requireFields(payload, ['round_id'], '轮次关闭');
  const round = state.rounds[payload.round_id];
  if (!round) fail(`协调轮次不存在: ${payload.round_id}`);
  if (round.status !== 'open') fail(`协调轮次已关闭: ${payload.round_id}`);
  round.status = 'closed';
  round.closed_at = occurred_at;
  round.statement = buildStatement(state, payload.round_id);
  return { type: 'round_closed', occurred_at, payload };
}

/**
 * 承诺申报：明确哪笔产能支撑哪项承诺、各交付月数量。
 * 提议不锁定可用量，确认时才锁定。
 */
function proposeCommitment(state, payload, occurred_at) {
  requireFields(
    payload,
    ['commitment_id', 'round_id', 'enterprise_id', 'region_id', 'drug_id', 'spec', 'quantity', 'deliveries', 'backing'],
    '承诺申报',
  );
  if (state.commitments[payload.commitment_id]) fail(`承诺已存在: ${payload.commitment_id}`);
  const round = state.rounds[payload.round_id];
  if (!round) fail(`协调轮次不存在: ${payload.round_id}`);
  if (round.status !== 'open') fail('协调轮次已关闭，不能再申报承诺');
  const shape = validateCommitmentShape(state, payload);
  checkAvailability(state, payload.backing);
  state.commitments[payload.commitment_id] = {
    commitment_id: payload.commitment_id,
    round_id: payload.round_id,
    enterprise_id: payload.enterprise_id,
    region_id: payload.region_id,
    drug_id: payload.drug_id,
    spec: payload.spec,
    original_quantity: payload.quantity,
    quantity: payload.quantity,
    deliveries: shape.deliveries,
    backing: shape.backing,
    status: 'proposed',
    proposed_at: occurred_at,
    confirmed_at: null,
    withdrawals: [],
    fulfillments: [],
  };
  return { type: 'commitment_proposed', occurred_at, payload };
}

function validateCommitmentShape(state, payload) {
  requirePositiveInt(payload.quantity, '承诺数量');
  if (!Array.isArray(payload.deliveries) || payload.deliveries.length === 0) fail('交付明细不能为空');
  if (!Array.isArray(payload.backing) || payload.backing.length === 0) fail('产能支撑明细不能为空');
  const deliveries = payload.deliveries.map((row) => {
    requireFields(row, ['month', 'quantity'], '交付明细');
    if (!isMonth(row.month)) fail(`交付月份非法: ${row.month}`);
    requirePositiveInt(row.quantity, '交付数量');
    return { month: row.month, quantity: row.quantity };
  });
  if (sumQuantities(deliveries) !== payload.quantity) fail('承诺总量与交付明细不一致');
  const backing = payload.backing.map((row) => {
    requireFields(row, ['lot_id', 'quantity'], '产能支撑');
    const lot = state.lots[row.lot_id];
    if (!lot) fail(`产能批次不存在: ${row.lot_id}`);
    requirePositiveInt(row.quantity, '支撑数量');
    if (lot.enterprise_id !== payload.enterprise_id) fail('承诺只能占用本企业产能');
    if (lot.drug_id !== payload.drug_id || lot.spec !== payload.spec) fail('承诺与产能批次的药品或规格不一致');
    return { lot_id: row.lot_id, quantity: row.quantity };
  });
  if (sumQuantities(backing) !== payload.quantity) fail('承诺总量与产能支撑明细不一致');
  for (const delivery of deliveries) {
    const deliverable = backing.some((slice) => lotDeliverableInMonth(state.lots[slice.lot_id], delivery.month));
    if (!deliverable) fail(`交付月份超出产能窗口或质检放行时间: ${delivery.month}`);
  }
  return { deliveries, backing };
}

/** 可用量校验：同一批次已锁定量 + 本次占用不得超过当前申报量。 */
function checkAvailability(state, backing) {
  const locked = lockedByLot(state);
  const need = {};
  for (const slice of backing) {
    need[slice.lot_id] = (need[slice.lot_id] ?? 0) + slice.quantity;
  }
  for (const [lotId, quantity] of Object.entries(need)) {
    const lot = state.lots[lotId];
    const available = lot.current_quantity - (locked[lotId] ?? 0);
    if (quantity > available) fail(`产能批次可用量不足: ${lotId}（可用 ${available}，需要 ${quantity}）`);
  }
}

/** 承诺各交付月当前是否仍可交付（考虑检修阻塞与质检放行）。 */
function commitmentDeliverable(state, commitment) {
  const blocked = {};
  for (const slice of commitment.backing) {
    const lot = state.lots[slice.lot_id];
    blocked[slice.lot_id] ??= maintenanceBlockedMonths(state, lot);
  }
  for (const delivery of commitment.deliveries) {
    const ok = commitment.backing.some((slice) =>
      lotDeliverableInMonth(state.lots[slice.lot_id], delivery.month, blocked[slice.lot_id]),
    );
    if (!ok) return delivery.month;
  }
  return null;
}

function maintenanceBlockedMonths(state, lot) {
  const months = [];
  for (const constraint of Object.values(state.constraints)) {
    if (constraint.kind !== 'maintenance') continue;
    if (constraint.factory_id !== lot.factory_id || constraint.line_id !== lot.line_id) continue;
    for (const month of monthsInWindow(lot.window)) {
      if (monthIntersectsWindow(month, constraint.window) && !months.includes(month)) months.push(month);
    }
  }
  return months.sort();
}

/** 企业确认承诺：对应可用量即被锁定，不能再分给另一地区。 */
function confirmCommitment(state, payload, occurred_at) {
  requireFields(payload, ['commitment_id', 'enterprise_id'], '承诺确认');
  const commitment = state.commitments[payload.commitment_id];
  if (!commitment) fail(`承诺不存在: ${payload.commitment_id}`);
  if (commitment.enterprise_id !== payload.enterprise_id) fail('只能由申报企业确认本企业承诺');
  if (commitment.status !== 'proposed') fail(`承诺状态不允许确认: ${commitment.status}`);
  // 提议之后若发生检修或质检延期，确认时按最新情景拦截
  const blockedMonth = commitmentDeliverable(state, commitment);
  if (blockedMonth) fail(`交付月份已不可交付（检修或质检放行限制）: ${blockedMonth}`);
  checkAvailability(state, commitment.backing);
  commitment.status = 'confirmed';
  commitment.confirmed_at = occurred_at;
  const notes = [];
  const months = maintenanceConflictMonths(state, commitment);
  if (months.length > 0) {
    const exceptionId = addException(state, 'maintenance_conflicts_lock', occurred_at, {
      commitment_id: commitment.commitment_id,
      months,
    });
    notes.push(`承诺交付月与检修窗口冲突，记录异常 ${exceptionId}`);
  }
  return { type: 'commitment_confirmed', occurred_at, payload, notes };
}

/** 部分撤回：按交付月减少承诺量并释放对应产能占用，总量保持一致。 */
function withdrawCommitment(state, payload, occurred_at) {
  requireFields(payload, ['commitment_id', 'quantity', 'deliveries', 'reason'], '承诺撤回');
  const commitment = state.commitments[payload.commitment_id];
  if (!commitment) fail(`承诺不存在: ${payload.commitment_id}`);
  if (!['proposed', 'confirmed'].includes(commitment.status)) fail(`承诺状态不允许撤回: ${commitment.status}`);
  validateWithdrawal(commitment, payload.quantity, payload.deliveries);
  applyWithdrawal(commitment, payload.quantity, payload.deliveries, payload.reason, occurred_at);
  return { type: 'commitment_withdrawn', occurred_at, payload };
}

function validateWithdrawal(commitment, quantity, deliveries) {
  requirePositiveInt(quantity, '撤回数量');
  if (!Array.isArray(deliveries) || deliveries.length === 0) fail('撤回需指明交付月份');
  if (sumQuantities(deliveries) !== quantity) fail('撤回总量与交付明细不一致');
  if (quantity > commitment.quantity) fail(`撤回数量超过承诺剩余量: ${commitment.commitment_id}`);
  for (const row of deliveries) {
    if (!isMonth(row.month)) fail(`交付月份非法: ${row.month}`);
    requirePositiveInt(row.quantity, '撤回数量');
    const existing = commitment.deliveries.find((delivery) => delivery.month === row.month);
    if (!existing || existing.quantity < row.quantity) fail(`交付月份撤回量超过剩余量: ${row.month}`);
  }
}

/** 校验通过后统一变更：交付明细、承诺量、产能占用（自末位释放）。 */
function applyWithdrawal(commitment, quantity, deliveries, reason, occurred_at) {
  for (const row of deliveries) {
    const existing = commitment.deliveries.find((delivery) => delivery.month === row.month);
    existing.quantity -= row.quantity;
  }
  commitment.deliveries = commitment.deliveries.filter((delivery) => delivery.quantity > 0);
  commitment.quantity -= quantity;
  let toRelease = quantity;
  for (let index = commitment.backing.length - 1; index >= 0 && toRelease > 0; index -= 1) {
    const take = Math.min(commitment.backing[index].quantity, toRelease);
    commitment.backing[index].quantity -= take;
    toRelease -= take;
  }
  commitment.backing = commitment.backing.filter((slice) => slice.quantity > 0);
  commitment.withdrawals.push({
    quantity,
    deliveries: deliveries.map((row) => ({ ...row })),
    reason,
    occurred_at,
  });
  if (commitment.quantity === 0) commitment.status = 'withdrawn';
}

function normalizeDelivered(delivered) {
  if (!Array.isArray(delivered) || delivered.length === 0) fail('履约明细不能为空');
  return delivered.map((row) => {
    requireFields(row, ['month', 'quantity'], '履约明细');
    if (!isMonth(row.month)) fail(`履约月份非法: ${row.month}`);
    requirePositiveInt(row.quantity, '履约数量');
    return { month: row.month, quantity: row.quantity };
  });
}

function reportFulfillment(state, payload, occurred_at) {
  requireFields(payload, ['fulfillment_id', 'commitment_id', 'delivered'], '履约登记');
  const commitment = state.commitments[payload.commitment_id];
  if (!commitment) fail(`承诺不存在: ${payload.commitment_id}`);
  if (commitment.status !== 'confirmed') fail('仅已确认承诺可登记履约');
  if (commitment.fulfillments.some((entry) => entry.fulfillment_id === payload.fulfillment_id)) {
    fail(`履约记录已存在: ${payload.fulfillment_id}`);
  }
  const delivered = normalizeDelivered(payload.delivered);
  if (fulfilledTotal(commitment) + sumQuantities(delivered) > commitment.quantity) {
    fail('履约总量超过承诺剩余量');
  }
  commitment.fulfillments.push({
    fulfillment_id: payload.fulfillment_id,
    version: 1,
    corrects: null,
    delivered,
    reason: payload.reason ?? null,
    occurred_at,
  });
  return { type: 'fulfillment_reported', occurred_at, payload };
}

/** 履约更正：作为新版本追加并与原记录并列留存，不覆盖原承诺与原记录。 */
function correctFulfillment(state, payload, occurred_at) {
  requireFields(payload, ['correction_id', 'fulfillment_id', 'delivered', 'reason'], '履约更正');
  requireNonEmptyString(payload.reason, '更正理由');
  const commitment = Object.values(state.commitments).find((item) =>
    item.fulfillments.some((entry) => entry.fulfillment_id === payload.fulfillment_id),
  );
  if (!commitment) fail(`履约记录不存在: ${payload.fulfillment_id}`);
  const original = commitment.fulfillments.find((entry) => entry.fulfillment_id === payload.fulfillment_id);
  if (original.corrects) fail('只能对原始履约记录发起更正');
  if (commitment.fulfillments.some((entry) => entry.fulfillment_id === payload.correction_id)) {
    fail(`更正记录已存在: ${payload.correction_id}`);
  }
  const delivered = normalizeDelivered(payload.delivered);
  const chain = commitment.fulfillments.filter(
    (entry) => entry.fulfillment_id === original.fulfillment_id || entry.corrects === original.fulfillment_id,
  );
  const tipVersion = Math.max(...chain.map((entry) => entry.version));
  const tip = chain.find((entry) => entry.version === tipVersion);
  // 更正替换本链当前口径：总量 = 其他链履约 + 新交付量，不得超过承诺剩余量
  const base = fulfilledTotal(commitment) - sumQuantities(tip.delivered);
  if (base + sumQuantities(delivered) > commitment.quantity) fail('更正后履约总量超过承诺剩余量');
  commitment.fulfillments.push({
    fulfillment_id: payload.correction_id,
    version: tipVersion + 1,
    corrects: original.fulfillment_id,
    delivered,
    reason: payload.reason,
    occurred_at,
  });
  return { type: 'fulfillment_corrected', occurred_at, payload };
}

/**
 * 紧急人工调整：唯一可释放已锁定量的途径。
 * 必须附理由，并为每个被影响地区给出替代安排，否则拒绝入账。
 */
function manualAdjustment(state, payload, occurred_at) {
  requireFields(payload, ['adjustment_id', 'reason', 'operations', 'alternatives'], '紧急人工调整');
  requireNonEmptyString(payload.reason, '调整理由');
  if (!Array.isArray(payload.operations) || payload.operations.length === 0) fail('调整操作不能为空');
  if (!Array.isArray(payload.alternatives)) fail('替代安排必须为数组');
  if (state.adjustments.some((item) => item.adjustment_id === payload.adjustment_id)) {
    fail(`调整已存在: ${payload.adjustment_id}`);
  }
  const plans = payload.operations.map((operation) => {
    requireFields(operation, ['type', 'commitment_id', 'quantity', 'deliveries'], '调整操作');
    if (operation.type !== 'force_withdraw') fail(`不支持的调整操作: ${operation.type}`);
    const commitment = state.commitments[operation.commitment_id];
    if (!commitment) fail(`承诺不存在: ${operation.commitment_id}`);
    if (commitment.status !== 'confirmed') fail('紧急调整只能作用于已确认承诺');
    validateWithdrawal(commitment, operation.quantity, operation.deliveries);
    return { operation, commitment };
  });
  // 同一承诺被多个操作命中时，按合计量校验，避免逐项通过后总量超限
  const aggregate = {};
  for (const { operation, commitment } of plans) {
    const entry = (aggregate[commitment.commitment_id] ??= { quantity: 0, months: {} });
    entry.quantity += operation.quantity;
    for (const row of operation.deliveries) {
      entry.months[row.month] = (entry.months[row.month] ?? 0) + row.quantity;
    }
  }
  for (const [commitmentId, entry] of Object.entries(aggregate)) {
    const commitment = state.commitments[commitmentId];
    if (entry.quantity > commitment.quantity) fail(`调整总量超过承诺剩余量: ${commitmentId}`);
    for (const [month, quantity] of Object.entries(entry.months)) {
      const existing = commitment.deliveries.find((delivery) => delivery.month === month);
      if (!existing || existing.quantity < quantity) fail(`调整交付月超过剩余量: ${commitmentId} ${month}`);
    }
  }
  const affectedRegions = new Set(plans.map(({ commitment }) => commitment.region_id));
  const coveredRegions = new Set(payload.alternatives.map((item) => item.region_id));
  for (const region of affectedRegions) {
    if (!coveredRegions.has(region)) fail(`紧急人工调整必须为受影响地区提供替代安排: ${region}`);
  }
  for (const alternative of payload.alternatives) {
    requireFields(alternative, ['region_id', 'arrangement'], '替代安排');
    requireNonEmptyString(alternative.arrangement, '替代安排');
  }
  for (const { operation, commitment } of plans) {
    applyWithdrawal(commitment, operation.quantity, operation.deliveries, payload.reason, occurred_at);
  }
  state.adjustments.push({
    adjustment_id: payload.adjustment_id,
    reason: payload.reason,
    operations: payload.operations.map((operation) => ({
      ...operation,
      deliveries: operation.deliveries.map((row) => ({ ...row })),
    })),
    alternatives: payload.alternatives.map((item) => ({ ...item })),
    occurred_at,
  });
  return { type: 'manual_adjustment', occurred_at, payload };
}
