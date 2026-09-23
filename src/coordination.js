// 协调命令层：把业务动作构造成可追加到 CoordinationRound 的事件。
// 所有命令都是纯对象，可序列化重放；网络重发时沿用同一 message_id 即幂等。

import {
  CoordinationRound,
  EVENT_TYPES as T,
  monthCompare,
} from './ledger.js';

let counter = 0;
/** 生成消息/事件标识（测试与调用方也可显式传入，便于重放去重）。 */
export function newId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function event(type, fields, messageId) {
  return {
    event_id: newId('evt'),
    occurred_at: new Date().toISOString(),
    ...(messageId ? { message_id: messageId } : {}),
    type,
    ...fields,
  };
}

/** 提交命令并把重复消息折叠为 {duplicate:true}，调用方无需自己判重。 */
export function submit(round, command) {
  const result = round.append(command);
  return result.status === 'duplicate'
    ? { duplicate: true, original_event_id: result.original_event_id }
    : { duplicate: false, event: result.event };
}

// ---- 企业：可追溯产能与供应事实 ----

export function declareCapacity(input, messageId) {
  return event(
    T.CAPACITY_DECLARED,
    {
      capacity_id: input.capacity_id,
      enterprise_id: input.enterprise_id,
      factory_id: input.factory_id,
      line_id: input.line_id,
      spec_id: input.spec_id,
      window_id: input.window_id,
      qty: input.qty,
    },
    messageId ?? newId('msg'),
  );
}

/** 迟到的产量修订。命令层不再额外限定窗口——台账以"已锁定量仍被覆盖"保证只影响未锁定部分。 */
export function reviseCapacity(input, messageId) {
  return event(
    T.CAPACITY_REVISED,
    {
      capacity_id: input.capacity_id,
      new_qty: input.new_qty,
      reason: input.reason ?? '',
    },
    messageId ?? newId('msg'),
  );
}

export function scheduleMaintenance(input, messageId) {
  return event(
    T.MAINTENANCE_SCHEDULED,
    {
      maintenance_id: input.maintenance_id,
      enterprise_id: input.enterprise_id,
      factory_id: input.factory_id,
      line_id: input.line_id,
      window_id: input.window_id,
      impacts: input.impacts,
      note: input.note ?? '',
    },
    messageId ?? newId('msg'),
  );
}

export function reviseMaintenance(input, messageId) {
  return event(
    T.MAINTENANCE_REVISED,
    {
      maintenance_id: input.maintenance_id,
      enterprise_id: input.enterprise_id,
      factory_id: input.factory_id,
      line_id: input.line_id,
      window_id: input.window_id,
      impacts: input.impacts,
      note: input.note ?? '',
    },
    messageId ?? newId('msg'),
  );
}

export function releaseQc(input, messageId) {
  return event(
    T.QC_RELEASED,
    {
      batch_id: input.batch_id,
      enterprise_id: input.enterprise_id,
      factory_id: input.factory_id,
      spec_id: input.spec_id,
      window_id: input.window_id,
      qty: input.qty,
    },
    messageId ?? newId('msg'),
  );
}

/** 质检延期：把已登记放行数量从 from 窗挪到 to 窗，总量不变。 */
export function delayQc(input, messageId) {
  return event(
    T.QC_DELAYED,
    {
      batch_id: input.batch_id,
      from_window_id: input.from_window_id,
      to_window_id: input.to_window_id,
      qty: input.qty,
    },
    messageId ?? newId('msg'),
  );
}

export function reportShipment(input, messageId) {
  return event(
    T.SHIPMENT_REPORTED,
    {
      shipment_id: input.shipment_id,
      enterprise_id: input.enterprise_id,
      spec_id: input.spec_id,
      destination_region_id: input.destination_region_id,
      qty: input.qty,
      eta_window_id: input.eta_window_id,
    },
    messageId ?? newId('msg'),
  );
}

export function arriveShipment(input, messageId) {
  return event(
    T.SHIPMENT_ARRIVED,
    { shipment_id: input.shipment_id, window_id: input.window_id, qty: input.qty },
    messageId ?? newId('msg'),
  );
}

export function cancelShipment(input, messageId) {
  return event(
    T.SHIPMENT_CANCELLED,
    { shipment_id: input.shipment_id, qty: input.qty },
    messageId ?? newId('msg'),
  );
}

// ---- 地区：分级需求 ----

export function submitDemand(input, messageId) {
  return event(
    T.DEMAND_SUBMITTED,
    {
      region_id: input.region_id,
      spec_id: input.spec_id,
      window_id: input.window_id,
      tier: input.tier,
      qty: input.qty,
      minimum_line: input.minimum_line ?? 0,
    },
    messageId ?? newId('msg'),
  );
}

// ---- 专班：协调建议（仅供协调，不自动成为行政分配）----

/** 由若干月数量生成跨月交付切片。 */
export function makeSlices(startWindow, monthlyQuantities) {
  const [y, m] = startWindow.split('-').map(Number);
  return monthlyQuantities.map((q, i) => {
    const total = (y - 1) * 12 + (m - 1) + i;
    return {
      window_id: `${String(Math.floor(total / 12) + 1)}-${String((total % 12) + 1).padStart(2, '0')}`,
      qty: q,
    };
  });
}

export function proposeCommitment(input, messageId) {
  return event(
    T.COMMITMENT_PROPOSED,
    {
      commitment_id: input.commitment_id,
      capacity_id: input.capacity_id,
      region_id: input.region_id,
      spec_id: input.spec_id,
      qty: input.qty,
      slices: input.slices,
      advisory: true, // 计算结果只供协调；未经企业确认不锁定、不构成分配
    },
    messageId ?? newId('msg'),
  );
}

/** 把情景试算给出的建议直接转成承诺建议事件。 */
export function proposalFromSuggestion(suggestion, messageId) {
  return proposeCommitment(
    {
      commitment_id: suggestion.commitment_id ?? newId('cmt'),
      capacity_id: suggestion.capacity_id,
      region_id: suggestion.region_id,
      spec_id: suggestion.spec_id,
      qty: suggestion.qty,
      slices: suggestion.slices,
    },
    messageId,
  );
}

// ---- 企业：确认/拒绝/撤回 ----

export function confirmCommitment(commitmentId, messageId) {
  return event(T.COMMITMENT_CONFIRMED, { commitment_id: commitmentId }, messageId ?? newId('msg'));
}

export function rejectCommitment(commitmentId, reason, messageId) {
  return event(
    T.COMMITMENT_REJECTED,
    { commitment_id: commitmentId, reason: reason ?? '' },
    messageId ?? newId('msg'),
  );
}

/** 部分撤回：仅限未来交付窗；已锁定且到期窗口必须改走紧急调整。 */
export function withdrawCommitment(input, messageId) {
  return event(
    T.COMMITMENT_PARTIALLY_WITHDRAWN,
    {
      commitment_id: input.commitment_id,
      window_id: input.window_id,
      qty: input.qty,
      reason: input.reason ?? '',
    },
    messageId ?? newId('msg'),
  );
}

/**
 * 紧急人工调整：必须附理由、操作人、受影响地区及各自的替代安排。
 * 可同时调减产产能/承诺，并以新承诺把腾出的量重配给受影响地区。
 */
export function emergencyAdjust(input, messageId) {
  return event(
    T.EMERGENCY_ADJUSTED,
    {
      adjustment_id: input.adjustment_id,
      operator_id: input.operator_id,
      reason: input.reason,
      items: input.items,
      impacts: input.impacts ?? [],
      alternatives: input.alternatives ?? [],
      new_commitments: input.new_commitments ?? [],
    },
    messageId ?? newId('msg'),
  );
}

// ---- 企业：履约更正（并列留存）----

export function correctFulfillment(input, messageId) {
  return event(
    T.FULFILLMENT_CORRECTED,
    {
      commitment_id: input.commitment_id,
      window_id: input.window_id,
      corrected_qty: input.corrected_qty,
      note: input.note ?? '',
    },
    messageId ?? newId('msg'),
  );
}

export function closeRound() {
  return { event_id: newId('evt'), occurred_at: new Date().toISOString(), type: T.ROUND_CLOSED };
}

/** 把一段命令依次提交；任一命令非法即整体抛出（已成功的事件保留在台账中）。 */
export function run(round, commands) {
  return commands.map((command) => submit(round, command));
}

export { CoordinationRound, monthCompare };
