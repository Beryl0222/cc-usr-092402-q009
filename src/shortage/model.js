/**
 * 短缺情景与承诺协调的领域常量、窗口/月份工具与不变量校验。
 *
 * 时间语义与既有申报合同一致：occurred_at 为带时区的 ISO 8601 时间戳；
 * 产能/检修窗口为闭区间日期（YYYY-MM-DD），交付与需求按月份（YYYY-MM）对齐。
 */

export const MESSAGE_TYPES = Object.freeze([
  'capacity_declared',
  'capacity_revised',
  'demand_declared',
  'constraint_reported',
  'round_opened',
  'round_closed',
  'commitment_proposed',
  'commitment_confirmed',
  'commitment_withdrawn',
  'fulfillment_reported',
  'fulfillment_corrected',
  'manual_adjustment',
]);

/** 需求分级：紧急 / 重点 / 常规，情景比较按此顺序分配。 */
export const DEMAND_TIERS = Object.freeze(['urgent', 'priority', 'routine']);

/** 进入情景比较的约束类型：检修、质检放行、在途数量、最低保障线。 */
export const CONSTRAINT_KINDS = Object.freeze(['maintenance', 'qc_release', 'in_transit', 'min_guarantee']);

/**
 * 承诺状态机：proposed → confirmed →（部分撤回）→ withdrawn。
 * 履约更正不改动承诺状态，以履约记录的版本链并列留存。
 */
export const COMMITMENT_STATUS = Object.freeze(['proposed', 'confirmed', 'withdrawn']);

export function datePart(value) {
  return String(value).slice(0, 10);
}

export function isMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function monthStart(month) {
  return `${month}-01`;
}

export function monthEnd(month) {
  const [year, mon] = month.split('-').map(Number);
  return new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);
}

export function monthOf(dateValue) {
  return datePart(dateValue).slice(0, 7);
}

export function monthIntersectsWindow(month, window) {
  return monthStart(month) <= datePart(window.end) && monthEnd(month) >= datePart(window.start);
}

/** 窗口覆盖的全部月份（含首尾月），用于跨月交付与检修影响分析。 */
export function monthsInWindow(window) {
  const endMonth = monthOf(window.end);
  const months = [];
  let [year, mon] = monthOf(window.start).split('-').map(Number);
  for (;;) {
    const current = `${year}-${String(mon).padStart(2, '0')}`;
    months.push(current);
    if (current === endMonth) return months;
    mon += 1;
    if (mon === 13) {
      mon = 1;
      year += 1;
    }
    if (months.length > 240) throw new Error('窗口跨度过大');
  }
}

export function fail(reason) {
  throw new Error(reason);
}

export function requireFields(payload, fields, label) {
  for (const field of fields) {
    if (payload[field] === undefined || payload[field] === null) {
      fail(`${label}缺少字段: ${field}`);
    }
  }
}

export function requirePositiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail(`${label}必须为正整数`);
}

export function requireNonNegativeInt(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label}必须为非负整数`);
}

export function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label}不能为空`);
}

export function sumQuantities(rows) {
  return rows.reduce((total, row) => total + row.quantity, 0);
}

/** 各产能批次当前被锁定的数量：仅已确认承诺占用可用量，提议不锁定。 */
export function lockedByLot(state) {
  const locked = {};
  for (const commitment of Object.values(state.commitments)) {
    if (commitment.status !== 'confirmed') continue;
    for (const slice of commitment.backing) {
      locked[slice.lot_id] = (locked[slice.lot_id] ?? 0) + slice.quantity;
    }
  }
  return locked;
}

/** 批次在某月是否可交付：与窗口相交、未被检修阻塞、不早于质检放行日。 */
export function lotDeliverableInMonth(lot, month, blockedMonths = []) {
  if (!monthIntersectsWindow(month, lot.window)) return false;
  if (blockedMonths.includes(month)) return false;
  if (lot.qc_release_at && monthEnd(month) < lot.qc_release_at) return false;
  return true;
}

/**
 * 承诺的当前履约总量：每条履约记录链取最新版本（更正覆盖旧值的口径），
 * 但所有版本都在承诺上并列留存，不物理覆盖。
 */
export function fulfilledTotal(commitment) {
  const latest = new Map();
  for (const entry of commitment.fulfillments) {
    const root = entry.corrects ?? entry.fulfillment_id;
    const prior = latest.get(root);
    if (!prior || entry.version > prior.version) latest.set(root, entry);
  }
  return [...latest.values()].reduce((total, entry) => total + sumQuantities(entry.delivered), 0);
}
