// 短缺情景与承诺协调——只追加事件台账（数据合同 schema v2）。
//
// 迁移说明（v1 → v2，保持既有标识与时间含义）：
//   - 沿用 record_id / domain="supply_report" / occurred_at(ISO-8601 时刻) /
//     revision(正整数，每接收一条事实 +1) / source 五个 v1 字段；
//   - 新增 round_id、as_of_window（当前协调月份窗，判定"未锁定窗口"用）和 events[]；
//   - v1 记录没有 events，视为一轮尚无协调事实的空轮次，round_id 取 record_id；
//   - 任何状态变化都以新事件追加，不覆盖旧事实（履约更正与原承诺并列即源于此）。

export const SCHEMA_VERSION = 2;
export const DOMAIN = 'supply_report';

const WINDOW_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_SEQ = (w) => Number(w.slice(0, 4)) * 12 + Number(w.slice(5, 7));

/** 支持的全部事件类型；新增状态只能新增事件类型，不得改写既有类型含义。 */
export const EVENT_TYPES = Object.freeze({
  CAPACITY_DECLARED: 'capacity_declared', // 企业按工厂/产线/规格/时间窗申报可追溯产能
  CAPACITY_REVISED: 'capacity_revised', // 迟到的产量修订（只作用于未锁定窗口）
  MAINTENANCE_SCHEDULED: 'maintenance_scheduled', // 设备检修
  MAINTENANCE_REVISED: 'maintenance_revised', // 检修调整
  QC_RELEASED: 'qc_released', // 质检放行（可分批）
  QC_DELAYED: 'qc_delayed', // 质检延期（在月份窗之间挪动已登记数量）
  SHIPMENT_REPORTED: 'shipment_reported', // 在途
  SHIPMENT_ARRIVED: 'shipment_arrived', // 在途实际抵达
  SHIPMENT_CANCELLED: 'shipment_cancelled', // 在途取消（数量以事件说明去向）
  DEMAND_SUBMITTED: 'demand_submitted', // 地区分级需求与最低保障线
  COMMITMENT_PROPOSED: 'commitment_proposed', // 专班协调建议（仅供协调，待企业确认）
  COMMITMENT_CONFIRMED: 'commitment_confirmed', // 企业确认 → 锁定可用量
  COMMITMENT_REJECTED: 'commitment_rejected', // 企业拒绝建议
  COMMITMENT_PARTIALLY_WITHDRAWN: 'commitment_partially_withdrawn', // 部分撤回（未来窗）
  EMERGENCY_ADJUSTED: 'emergency_adjusted', // 紧急人工调整（理由+替代安排）
  FULFILLMENT_CORRECTED: 'fulfillment_corrected', // 履约更正（并列留存）
  ROUND_CLOSED: 'round_closed', // 本轮协调结束，台账封存
});

// 企业侧命令必须携带 message_id，重复消息按幂等处理。
const MESSAGE_TYPES = new Set([
  EVENT_TYPES.CAPACITY_DECLARED,
  EVENT_TYPES.CAPACITY_REVISED,
  EVENT_TYPES.MAINTENANCE_SCHEDULED,
  EVENT_TYPES.MAINTENANCE_REVISED,
  EVENT_TYPES.QC_RELEASED,
  EVENT_TYPES.QC_DELAYED,
  EVENT_TYPES.SHIPMENT_REPORTED,
  EVENT_TYPES.SHIPMENT_ARRIVED,
  EVENT_TYPES.SHIPMENT_CANCELLED,
  EVENT_TYPES.DEMAND_SUBMITTED,
  EVENT_TYPES.COMMITMENT_PROPOSED,
  EVENT_TYPES.COMMITMENT_CONFIRMED,
  EVENT_TYPES.COMMITMENT_REJECTED,
  EVENT_TYPES.COMMITMENT_PARTIALLY_WITHDRAWN,
  EVENT_TYPES.EMERGENCY_ADJUSTED,
  EVENT_TYPES.FULFILLMENT_CORRECTED,
]);

function qty(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label}必须是非负整数，收到 ${String(value)}`);
  }
  return value;
}

function positive(value, label) {
  qty(value, label);
  if (value === 0) throw new Error(`${label}必须大于 0`);
  return value;
}

function str(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label}不能为空`);
  }
  return value;
}

function windowId(value, label = '时间窗') {
  if (typeof value !== 'string' || !WINDOW_RE.test(value)) {
    throw new Error(`${label}必须是 YYYY-MM 形式，收到 ${String(value)}`);
  }
  return value;
}

export function monthCompare(a, b) {
  return MONTH_SEQ(a) - MONTH_SEQ(b);
}

function freshState() {
  return {
    seq: 0,
    events: [],
    messages: new Map(), // message_id -> event_id（重复消息幂等）
    capacities: new Map(), // capacity_id -> 产能行
    maintenance: new Map(), // maintenance_id -> 检修行
    batches: new Map(), // batch_id -> { 企业/工厂/规格, releases: Map(窗->数量) }
    shipments: new Map(), // shipment_id -> { arrived: Map(窗->数量), cancelled }
    demands: new Map(), // region|spec|window -> 最新分级需求（历史在 events 中）
    commitments: new Map(), // commitment_id -> 承诺
    adjustments: [], // 紧急调整审计线索
    closed: false,
    closedAt: null,
  };
}

function maintenanceDownFor(state, cap) {
  let down = 0;
  for (const m of state.maintenance.values()) {
    if (
      m.enterprise_id === cap.enterprise_id &&
      m.factory_id === cap.factory_id &&
      m.line_id === cap.line_id &&
      m.window_id === cap.window_id
    ) {
      for (const impact of m.impacts) {
        if (impact.spec_id === cap.spec_id) down += impact.down_qty;
      }
    }
  }
  return down;
}

function commitmentRemaining(c) {
  let withdrawn = 0;
  for (const w of c.withdrawals) withdrawn += w.qty;
  for (const r of c.emergency_reductions) withdrawn += r.qty;
  return c.qty - withdrawn;
}

function sliceRemaining(c, window) {
  const slice = c.slices.find((s) => s.window_id === window);
  if (!slice) return 0;
  let used = 0;
  for (const w of c.withdrawals) if (w.window_id === window) used += w.qty;
  for (const r of c.emergency_reductions) if (r.window_id === window) used += r.qty;
  return slice.qty - used;
}

/** 某条产能当前已被确认承诺锁定的数量。锁定的是产能来源，跨月交付同样计入。 */
function lockedByCapacity(state, capacityId) {
  let locked = 0;
  for (const c of state.commitments.values()) {
    if (c.capacity_id === capacityId && c.confirmed_at) locked += commitmentRemaining(c);
  }
  return locked;
}

/** 守恒/锁定不变量：有效产能（已扣检修）不得小于锁定量。 */
function assertCapacityBalance(state, cap) {
  const maintenanceQty = maintenanceDownFor(state, cap);
  const effective = cap.current_qty - maintenanceQty;
  const locked = lockedByCapacity(state, cap.capacity_id);
  if (locked > effective) {
    throw new Error(
      `产能 ${cap.capacity_id} 守恒校验失败：锁定 ${locked} 超过有效产能 ${effective}` +
        `（当前 ${cap.current_qty} - 检修 ${maintenanceQty}）；如需改动已锁定窗口请走紧急调整`,
    );
  }
}

function assertCapacityBalanceAll(state, capacityIds) {
  for (const id of capacityIds) assertCapacityBalance(state, state.capacities.get(id));
}

// ---- 各事件类型的归约：只校验并演进状态，任何失败都不写入 ----

function applyCapacityDeclared(state, e) {
  const id = str(e.capacity_id, 'capacity_id');
  if (state.capacities.has(id)) throw new Error(`产能 ${id} 已申报，修订请发 capacity_revised`);
  const cap = {
    capacity_id: id,
    enterprise_id: str(e.enterprise_id, 'enterprise_id'),
    factory_id: str(e.factory_id, 'factory_id'),
    line_id: str(e.line_id, 'line_id'),
    spec_id: str(e.spec_id, 'spec_id'),
    window_id: windowId(e.window_id, '产能时间窗'),
    declared_qty: positive(e.qty, '申报产能'),
    current_qty: 0,
    revisions: [],
  };
  cap.current_qty = cap.declared_qty;
  state.capacities.set(id, cap);
  assertCapacityBalance(state, cap);
}

function applyCapacityRevised(state, e) {
  const cap = state.capacities.get(str(e.capacity_id, 'capacity_id'));
  if (!cap) throw new Error(`产量修订指向未知产能 ${e.capacity_id}`);
  const newQty = qty(e.new_qty, '修订后产能');
  // 迟到的产量修订只重算未锁定窗口：本窗已锁定量必须仍被覆盖。
  const trial = cap.current_qty;
  cap.current_qty = newQty;
  try {
    assertCapacityBalance(state, cap);
  } catch (err) {
    cap.current_qty = trial;
    throw err;
  }
  cap.revisions.push({ new_qty: newQty, reason: e.reason ?? '', at: e.occurred_at });
}

function readImpacts(impacts) {
  if (!Array.isArray(impacts) || impacts.length === 0) {
    throw new Error('检修必须给出 impacts: [{spec_id, down_qty}]');
  }
  return impacts.map((i) => ({
    spec_id: str(i.spec_id, '检修影响规格'),
    down_qty: qty(i.down_qty, '检修扣减产能'),
  }));
}

function applyMaintenanceScheduled(state, e, isRevision) {
  const id = str(e.maintenance_id, 'maintenance_id');
  if (!isRevision && state.maintenance.has(id)) {
    throw new Error(`检修 ${id} 已登记，调整请发 maintenance_revised`);
  }
  if (isRevision && !state.maintenance.has(id)) {
    throw new Error(`检修调整指向未知检修 ${id}`);
  }
  const rec = {
    maintenance_id: id,
    enterprise_id: str(e.enterprise_id, 'enterprise_id'),
    factory_id: str(e.factory_id, 'factory_id'),
    line_id: str(e.line_id, 'line_id'),
    window_id: windowId(e.window_id, '检修时间窗'),
    impacts: readImpacts(e.impacts),
    note: e.note ?? '',
  };
  state.maintenance.set(id, rec);
  // 检修加深后，同厂/线/窗上受影响规格的既有锁定仍须有有效产能支撑。
  const touched = new Set();
  for (const cap of state.capacities.values()) {
    if (
      cap.enterprise_id === rec.enterprise_id &&
      cap.factory_id === rec.factory_id &&
      cap.line_id === rec.line_id &&
      cap.window_id === rec.window_id &&
      rec.impacts.some((i) => i.spec_id === cap.spec_id)
    ) {
      touched.add(cap.capacity_id);
    }
  }
  assertCapacityBalanceAll(state, touched);
}

function applyQcReleased(state, e) {
  const id = str(e.batch_id, 'batch_id');
  const specId = str(e.spec_id, 'spec_id');
  let batch = state.batches.get(id);
  if (!batch) {
    batch = {
      batch_id: id,
      enterprise_id: str(e.enterprise_id, 'enterprise_id'),
      factory_id: str(e.factory_id, 'factory_id'),
      spec_id: specId,
      releases: new Map(),
    };
    state.batches.set(id, batch);
  } else if (batch.spec_id !== specId) {
    throw new Error(`批次 ${id} 规格与既有放行记录不一致（${batch.spec_id} ≠ ${specId}）`);
  }
  const win = windowId(e.window_id, '放行时间窗');
  const n = positive(e.qty, '放行数量');
  batch.releases.set(win, (batch.releases.get(win) ?? 0) + n);
}

function applyQcDelayed(state, e) {
  const batch = state.batches.get(str(e.batch_id, 'batch_id'));
  if (!batch) throw new Error(`质检延期指向未知批次 ${e.batch_id}`);
  const from = windowId(e.from_window_id, '原放行窗');
  const to = windowId(e.to_window_id, '延期放行窗');
  if (from === to) throw new Error('质检延期的目标月份窗必须与原窗不同');
  const n = positive(e.qty, '延期数量');
  const avail = batch.releases.get(from) ?? 0;
  if (n > avail) {
    throw new Error(`批次 ${batch.batch_id} ${from} 窗仅登记放行 ${avail}，不能延期 ${n}`);
  }
  batch.releases.set(from, avail - n);
  batch.releases.set(to, (batch.releases.get(to) ?? 0) + n); // 总量不变，只跨窗
}

function applyShipmentReported(state, e) {
  const id = str(e.shipment_id, 'shipment_id');
  if (state.shipments.has(id)) throw new Error(`在途单 ${id} 已申报`);
  state.shipments.set(id, {
    shipment_id: id,
    enterprise_id: str(e.enterprise_id, 'enterprise_id'),
    spec_id: str(e.spec_id, 'spec_id'),
    destination_region_id: str(e.destination_region_id, 'destination_region_id'),
    qty: positive(e.qty, '在途数量'),
    eta_window_id: windowId(e.eta_window_id, '预计抵达窗'),
    arrived: new Map(),
    cancelled_qty: 0,
  });
}

function shipmentRemaining(s) {
  let arrived = 0;
  for (const q of s.arrived.values()) arrived += q;
  return s.qty - arrived - s.cancelled_qty;
}

function applyShipmentArrived(state, e) {
  const s = state.shipments.get(str(e.shipment_id, 'shipment_id'));
  if (!s) throw new Error(`抵达指向未知在途单 ${e.shipment_id}`);
  const win = windowId(e.window_id, '抵达时间窗');
  const n = positive(e.qty, '抵达数量');
  if (n > shipmentRemaining(s)) {
    throw new Error(`在途单 ${s.shipment_id} 剩余 ${shipmentRemaining(s)}，不能抵达 ${n}`);
  }
  s.arrived.set(win, (s.arrived.get(win) ?? 0) + n);
}

function applyShipmentCancelled(state, e) {
  const s = state.shipments.get(str(e.shipment_id, 'shipment_id'));
  if (!s) throw new Error(`取消指向未知在途单 ${e.shipment_id}`);
  const n = positive(e.qty, '取消数量');
  if (n > shipmentRemaining(s)) {
    throw new Error(`在途单 ${s.shipment_id} 剩余 ${shipmentRemaining(s)}，不能取消 ${n}`);
  }
  s.cancelled_qty += n; // 以取消事件说明数量去向，保持总量可对账
}

function applyDemandSubmitted(state, e) {
  const region = str(e.region_id, 'region_id');
  const spec = str(e.spec_id, 'spec_id');
  const win = windowId(e.window_id, '需求时间窗');
  const qtyTotal = positive(e.qty, '需求量');
  const minLine = qty(e.minimum_line ?? 0, '最低保障线');
  if (minLine > qtyTotal) throw new Error('最低保障线不能超过分级需求总量');
  const tier = e.tier;
  if (!Number.isInteger(tier) || tier < 1 || tier > 3) {
    throw new Error('需求分级 tier 必须是 1（最高）至 3');
  }
  state.demands.set(`${region}|${spec}|${win}`, {
    region_id: region,
    spec_id: spec,
    window_id: win,
    tier,
    qty: qtyTotal,
    minimum_line: minLine,
    at: e.occurred_at,
  });
}

function readSlices(slices, total) {
  if (!Array.isArray(slices) || slices.length === 0) {
    throw new Error('承诺必须给出跨月交付切片 slices: [{window_id, qty}]');
  }
  const out = slices.map((s) => ({
    window_id: windowId(s.window_id, '交付时间窗'),
    qty: positive(s.qty, '切片数量'),
  }));
  const sum = out.reduce((a, s) => a + s.qty, 0);
  if (sum !== total) {
    throw new Error(`承诺切片合计 ${sum} 与承诺总量 ${total} 不一致（跨月交付必须守恒）`);
  }
  const wins = new Set(out.map((s) => s.window_id));
  if (wins.size !== out.length) throw new Error('同一承诺在同一交付窗只能有一条切片');
  return out;
}

function applyCommitmentProposed(state, e) {
  const id = str(e.commitment_id, 'commitment_id');
  if (state.commitments.has(id)) throw new Error(`承诺 ${id} 已存在`);
  const cap = state.capacities.get(str(e.capacity_id, 'capacity_id'));
  if (!cap) throw new Error(`承诺指向未知产能 ${e.capacity_id}`);
  const spec = str(e.spec_id, 'spec_id');
  if (spec !== cap.spec_id) throw new Error(`承诺规格 ${spec} 与产能规格 ${cap.spec_id} 不一致`);
  const total = positive(e.qty, '承诺总量');
  state.commitments.set(id, {
    commitment_id: id,
    capacity_id: cap.capacity_id,
    enterprise_id: cap.enterprise_id,
    region_id: str(e.region_id, 'region_id'),
    spec_id: spec,
    qty: total,
    slices: readSlices(e.slices, total),
    status: 'proposed',
    origin: 'coordination',
    proposed_at: e.occurred_at,
    confirmed_at: null,
    withdrawals: [],
    emergency_reductions: [],
    corrections: [],
  });
  // 建议阶段不锁定；两条待确认建议可能同时指向同一产能，确认时再做强校验。
}

function applyCommitmentConfirmed(state, e) {
  const c = state.commitments.get(str(e.commitment_id, 'commitment_id'));
  if (!c) throw new Error(`确认指向未知承诺 ${e.commitment_id}`);
  if (c.status !== 'proposed') throw new Error(`承诺 ${c.commitment_id} 当前状态 ${c.status}，不能确认`);
  c.status = 'confirmed';
  c.confirmed_at = e.occurred_at;
  try {
    assertCapacityBalance(state, state.capacities.get(c.capacity_id));
  } catch (err) {
    c.status = 'proposed';
    c.confirmed_at = null;
    throw err;
  }
}

function applyCommitmentRejected(state, e) {
  const c = state.commitments.get(str(e.commitment_id, 'commitment_id'));
  if (!c) throw new Error(`拒绝指向未知承诺 ${e.commitment_id}`);
  if (c.status !== 'proposed') throw new Error(`承诺 ${c.commitment_id} 已处理，不能拒绝`);
  c.status = 'rejected';
  c.reject_reason = e.reason ?? '';
}

function applyCommitmentPartiallyWithdrawn(state, e, asOfWindow) {
  const c = state.commitments.get(str(e.commitment_id, 'commitment_id'));
  if (!c) throw new Error(`撤回指向未知承诺 ${e.commitment_id}`);
  if (c.status !== 'proposed' && c.status !== 'confirmed') {
    throw new Error(`承诺 ${c.commitment_id} 状态 ${c.status}，不能撤回`);
  }
  const win = windowId(e.window_id, '撤回交付窗');
  const n = positive(e.qty, '撤回数量');
  const remainSlice = sliceRemaining(c, win);
  if (n > remainSlice) {
    throw new Error(`承诺 ${c.commitment_id} ${win} 窗剩余 ${remainSlice}，不能撤回 ${n}`);
  }
  if (c.status === 'confirmed' && asOfWindow && monthCompare(win, asOfWindow) <= 0) {
    throw new Error(
      `承诺 ${c.commitment_id} ${win} 窗已到/已过且已锁定，部分撤回不允许；请走紧急调整并附替代安排`,
    );
  }
  c.withdrawals.push({ window_id: win, qty: n, reason: e.reason ?? '', at: e.occurred_at });
  if (commitmentRemaining(c) === 0) c.status = 'withdrawn';
}

function applyEmergencyAdjusted(state, e) {
  const adjustmentId = str(e.adjustment_id, 'adjustment_id');
  if (state.adjustments.some((a) => a.adjustment_id === adjustmentId)) {
    throw new Error(`紧急调整 ${adjustmentId} 重复`);
  }
  const reason = str(e.reason, '调整理由');
  str(e.operator_id, 'operator_id');
  const items = Array.isArray(e.items) ? e.items : [];
  if (items.length === 0) throw new Error('紧急调整必须至少包含一条 item');

  // 受影响地区与替代安排：每一个被波及地区都必须有替代安排说明。
  const impacts = Array.isArray(e.impacts) ? e.impacts : [];
  const alternatives = Array.isArray(e.alternatives) ? e.alternatives : [];
  const altByRegion = new Map();
  for (const a of alternatives) {
    const region = str(a.region_id, '替代安排地区');
    str(a.arrangement, '替代安排内容');
    altByRegion.set(region, {
      region_id: region,
      arrangement: a.arrangement,
      replacement_qty: qty(a.replacement_qty ?? 0, '替代数量'),
    });
  }
  const impactedRegions = new Set();
  for (const i of impacts) {
    impactedRegions.add(str(i.region_id, '受影响地区'));
    qty(i.qty, '受影响数量');
    windowId(i.window_id, '受影响时间窗');
  }
  for (const region of impactedRegions) {
    if (!altByRegion.has(region)) {
      throw new Error(`紧急调整缺少受影响地区 ${region} 的替代安排`);
    }
  }

  const touchedCaps = new Set();
  for (const item of items) {
    if (item.kind === 'capacity_reduce') {
      const cap = state.capacities.get(str(item.capacity_id, 'capacity_id'));
      if (!cap) throw new Error('紧急调整指向未知产能');
      const n = positive(item.qty, '产能调减数量');
      if (n > cap.current_qty) throw new Error(`产能 ${cap.capacity_id} 调减超过当前产量`);
      cap.current_qty -= n;
      touchedCaps.add(cap.capacity_id);
    } else if (item.kind === 'commitment_reduce') {
      const c = state.commitments.get(str(item.commitment_id, 'commitment_id'));
      if (!c || !c.confirmed_at) throw new Error('紧急调减只能作用于已确认承诺');
      const win = windowId(item.window_id, '调减交付窗');
      const n = positive(item.qty, '承诺调减数量');
      if (n > sliceRemaining(c, win)) {
        throw new Error(`承诺 ${c.commitment_id} ${win} 窗剩余不足，无法紧急调减 ${n}`);
      }
      c.emergency_reductions.push({ window_id: win, qty: n, at: e.occurred_at });
      if (commitmentRemaining(c) === 0) c.status = 'withdrawn';
      touchedCaps.add(c.capacity_id);
    } else {
      throw new Error(`未知紧急调整条目类型 ${item.kind}`);
    }
  }

  // 人工调整可直接把腾出/其他产能重新锁定给地区（commitment_relocate 的落地形式），
  // 新承诺以本调整为权威来源，全程可追溯。
  for (const nc of e.new_commitments ?? []) {
    const id = str(nc.commitment_id, '新承诺编号');
    if (state.commitments.has(id)) throw new Error(`新承诺 ${id} 已存在`);
    const cap = state.capacities.get(str(nc.capacity_id, 'capacity_id'));
    if (!cap) throw new Error(`紧急调整新承诺指向未知产能 ${nc.capacity_id}`);
    const spec = str(nc.spec_id, 'spec_id');
    if (spec !== cap.spec_id) throw new Error('紧急调整新承诺规格与产能不一致');
    const total = positive(nc.qty, '新承诺总量');
    state.commitments.set(id, {
      commitment_id: id,
      capacity_id: cap.capacity_id,
      enterprise_id: cap.enterprise_id,
      region_id: str(nc.region_id, '新承诺地区'),
      spec_id: spec,
      qty: total,
      slices: readSlices(nc.slices, total),
      status: 'confirmed',
      origin: `emergency:${adjustmentId}`,
      proposed_at: e.occurred_at,
      confirmed_at: e.occurred_at,
      withdrawals: [],
      emergency_reductions: [],
      corrections: [],
    });
    touchedCaps.add(cap.capacity_id);
  }

  // 人工权威也要满足最终守恒：全部条目落地后，锁定不得超过有效产能。
  try {
    assertCapacityBalanceAll(state, touchedCaps);
  } catch (err) {
    throw new Error(`紧急调整 ${adjustmentId} 落地后总量失衡：${err.message}`);
  }

  state.adjustments.push({
    adjustment_id: adjustmentId,
    operator_id: e.operator_id,
    reason,
    items: items.map((i) => ({ ...i })),
    impacts: impacts.map((i) => ({ ...i })),
    alternatives: [...altByRegion.values()],
    new_commitment_ids: (e.new_commitments ?? []).map((c) => c.commitment_id),
    at: e.occurred_at,
  });
}

function applyFulfillmentCorrected(state, e) {
  const c = state.commitments.get(str(e.commitment_id, 'commitment_id'));
  if (!c) throw new Error(`履约更正指向未知承诺 ${e.commitment_id}`);
  if (!c.confirmed_at) throw new Error(`承诺 ${c.commitment_id} 尚未确认，无履约可更正`);
  const win = windowId(e.window_id, '履约交付窗');
  if (!c.slices.some((s) => s.window_id === win)) {
    throw new Error(`承诺 ${c.commitment_id} 没有 ${win} 窗的交付切片`);
  }
  // 更正只追加：原承诺切片永不改写，对账单中并列展示。
  c.corrections.push({
    window_id: win,
    corrected_qty: qty(e.corrected_qty, '更正后履约量'),
    note: e.note ?? '',
    at: e.occurred_at,
  });
}

const REDUCERS = {
  [EVENT_TYPES.CAPACITY_DECLARED]: (s, e) => applyCapacityDeclared(s, e),
  [EVENT_TYPES.CAPACITY_REVISED]: (s, e) => applyCapacityRevised(s, e),
  [EVENT_TYPES.MAINTENANCE_SCHEDULED]: (s, e) => applyMaintenanceScheduled(s, e, false),
  [EVENT_TYPES.MAINTENANCE_REVISED]: (s, e) => applyMaintenanceScheduled(s, e, true),
  [EVENT_TYPES.QC_RELEASED]: (s, e) => applyQcReleased(s, e),
  [EVENT_TYPES.QC_DELAYED]: (s, e) => applyQcDelayed(s, e),
  [EVENT_TYPES.SHIPMENT_REPORTED]: (s, e) => applyShipmentReported(s, e),
  [EVENT_TYPES.SHIPMENT_ARRIVED]: (s, e) => applyShipmentArrived(s, e),
  [EVENT_TYPES.SHIPMENT_CANCELLED]: (s, e) => applyShipmentCancelled(s, e),
  [EVENT_TYPES.DEMAND_SUBMITTED]: (s, e) => applyDemandSubmitted(s, e),
  [EVENT_TYPES.COMMITMENT_PROPOSED]: (s, e) => applyCommitmentProposed(s, e),
  [EVENT_TYPES.COMMITMENT_CONFIRMED]: (s, e) => applyCommitmentConfirmed(s, e),
  [EVENT_TYPES.COMMITMENT_REJECTED]: (s, e) => applyCommitmentRejected(s, e),
  [EVENT_TYPES.COMMITMENT_PARTIALLY_WITHDRAWN]: (s, e, ctx) =>
    applyCommitmentPartiallyWithdrawn(s, e, ctx.as_of_window),
  [EVENT_TYPES.EMERGENCY_ADJUSTED]: (s, e) => applyEmergencyAdjusted(s, e),
  [EVENT_TYPES.FULFILLMENT_CORRECTED]: (s, e) => applyFulfillmentCorrected(s, e),
  [EVENT_TYPES.ROUND_CLOSED]: (s, e) => {
    s.closed = true;
    s.closedAt = e.occurred_at;
  },
};

/**
 * 一轮短缺协调的只追加台账。
 * 用法：new CoordinationRound(meta) → append(event) 逐条提交；或 fromRecord(record) 载入。
 */
export class CoordinationRound {
  constructor(meta = {}) {
    this.meta = {
      record_id: str(meta.record_id ?? meta.round_id, 'record_id'),
      round_id: str(meta.round_id ?? meta.record_id, 'round_id'),
      occurred_at: str(meta.occurred_at ?? new Date().toISOString(), 'occurred_at'),
      source: str(meta.source ?? '协调轮次', 'source'),
      as_of_window: meta.as_of_window ? windowId(meta.as_of_window, '当前协调窗') : null,
    };
    this.state = freshState();
  }

  static fromRecord(record) {
    if (!record || !Number.isInteger(record.schema_version) || !record.record_id) {
      throw new Error('数据合同缺少必要标识');
    }
    if (record.schema_version === 1) {
      // 旧样例：没有任何协调事实，作为空轮次迁移。
      const round = new CoordinationRound({
        record_id: record.record_id,
        round_id: record.record_id,
        occurred_at: record.occurred_at,
        source: record.source,
      });
      return round;
    }
    if (record.schema_version !== SCHEMA_VERSION) {
      throw new Error(`未知 schema_version ${record.schema_version}`);
    }
    const round = new CoordinationRound({
      record_id: record.record_id,
      round_id: record.round_id ?? record.record_id,
      occurred_at: record.occurred_at,
      source: record.source,
      as_of_window: record.as_of_window,
    });
    for (const event of record.events ?? []) round.append(event);
    return round;
  }

  /**
   * 追加一条事实。
   * @returns {{status:'accepted', event:object} | {status:'duplicate', original_event_id:string}}
   * 重复 message_id 直接幂等忽略，不产生任何数量变化。
   */
  append(event) {
    if (this.state.closed) throw new Error('本轮协调已封存，不能再追加事件；请开启新一轮');
    if (!event || typeof event !== 'object') throw new Error('事件必须是对象');
    const type = str(event.type, 'event.type');
    const reducer = REDUCERS[type];
    if (!reducer) throw new Error(`未知事件类型 ${type}`);
    // 同一消息原样重发（event_id 与 message_id 都相同）时先按 message_id 判重，
    // 必须早于 event_id 唯一性检查，否则重发会被误判为事件冲突。
    if (MESSAGE_TYPES.has(type)) {
      const mid = str(event.message_id, 'message_id（企业侧命令必须携带，用于重复消息去重）');
      const seen = this.state.messages.get(mid);
      if (seen) return { status: 'duplicate', original_event_id: seen };
    }
    str(event.event_id, 'event_id');
    if (this.state.events.some((x) => x.event_id === event.event_id)) {
      throw new Error(`event_id ${event.event_id} 重复`);
    }
    str(event.occurred_at, 'event.occurred_at');

    const stored = Object.freeze({ ...event, type, seq: this.state.seq + 1 });
    const trial = this.#cloneState();
    try {
      reducer(trial, stored, { as_of_window: this.meta.as_of_window });
    } catch (err) {
      throw new Error(`事件 ${stored.event_id}(${type}) 被拒：${err.message}`);
    }
    reducer(this.state, stored, { as_of_window: this.meta.as_of_window });
    this.state.seq += 1;
    this.state.events.push(stored);
    if (stored.message_id) this.state.messages.set(stored.message_id, stored.event_id);
    return { status: 'accepted', event: stored };
  }

  // 供 append 先试算后提交：结构化克隆内部状态（Map 可被结构化克隆）。
  #cloneState() {
    return structuredClone(this.state);
  }

  get closed() {
    return this.state.closed;
  }

  /** 供试算/对账单/视图使用的只读快照（数组形式，脱离内部 Map）。 */
  view() {
    return stateView(this.state, this.meta);
  }

  toJSON() {
    return {
      schema_version: SCHEMA_VERSION,
      record_id: this.meta.record_id,
      domain: DOMAIN,
      round_id: this.meta.round_id,
      occurred_at: this.meta.occurred_at,
      as_of_window: this.meta.as_of_window,
      // revision 沿用 v1 语义：正整数、单调递增；每接收一条事实 +1。
      revision: 1 + this.state.events.length,
      source: this.meta.source,
      events: this.state.events.map(({ seq, ...rest }) => ({ seq, ...rest })),
    };
  }
}

/** 把内部归约状态展开为对账/视图层使用的只读扁平结构。 */
export function stateView(state, meta) {
  const capacities = [...state.capacities.values()].map((cap) => {
    const maintenance_qty = maintenanceDownFor(state, cap);
    const effective_qty = cap.current_qty - maintenance_qty;
    const locked_qty = lockedByCapacity(state, cap.capacity_id);
    return {
      ...cap,
      revisions: cap.revisions.map((r) => ({ ...r })),
      maintenance_qty,
      effective_qty,
      locked_qty,
      free_qty: effective_qty - locked_qty,
    };
  });

  const batches = [...state.batches.values()].map((b) => ({
    ...b,
    releases: [...b.releases.entries()].map(([window_id, q]) => ({ window_id, qty: q })),
    released_total: [...b.releases.values()].reduce((a, q) => a + q, 0),
  }));

  const shipments = [...state.shipments.values()].map(({ arrived, ...s }) => {
    const arrivedTotal = [...arrived.values()].reduce((a, q) => a + q, 0);
    return {
      ...s,
      arrivals: [...arrived.entries()].map(([window_id, q]) => ({ window_id, qty: q })),
      arrived_total: arrivedTotal,
      remaining_qty: s.qty - arrivedTotal - s.cancelled_qty,
    };
  });

  const commitments = [...state.commitments.values()].map((c) => ({
    ...c,
    slices: c.slices.map((s) => ({
      ...s,
      withdrawn_qty:
        c.withdrawals.filter((w) => w.window_id === s.window_id).reduce((a, w) => a + w.qty, 0) +
        c.emergency_reductions.filter((w) => w.window_id === s.window_id).reduce((a, w) => a + w.qty, 0),
      corrections: c.corrections.filter((x) => x.window_id === s.window_id).map((x) => ({ ...x })),
      remaining_qty: sliceRemaining(c, s.window_id),
    })),
    remaining_qty: commitmentRemaining(c),
  }));

  return {
    meta: { ...meta },
    closed: state.closed,
    closed_at: state.closedAt,
    capacities,
    maintenance: [...state.maintenance.values()].map((m) => ({
      ...m,
      impacts: m.impacts.map((i) => ({ ...i })),
    })),
    batches,
    shipments,
    demands: [...state.demands.values()],
    commitments,
    adjustments: state.adjustments.map((a) => ({ ...a })),
    events: state.events.slice(),
  };
}
