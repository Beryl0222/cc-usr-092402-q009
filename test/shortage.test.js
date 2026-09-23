import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createStore, ingest, project, receiptsOf } from '../src/shortage/ledger.js';
import { computeScenario } from '../src/shortage/scenario.js';
import { enterpriseView, taskForceView, publicView } from '../src/shortage/views.js';
import { loadRecord } from '../src/contracts.js';

const here = dirname(fileURLToPath(import.meta.url));
const AT = '2026-09-21T08:00:00+08:00';

function msg(id, type, payload, occurred_at = AT) {
  return { message_id: id, type, occurred_at, payload };
}

function seedStore() {
  const store = createStore();
  ingest(store, msg('s-1', 'round_opened', { round_id: 'rd-1' }));
  ingest(
    store,
    msg('s-2', 'capacity_declared', {
      lot_id: 'lot-1',
      enterprise_id: 'ent-1',
      drug_id: 'drug-A',
      spec: '0.5g',
      factory_id: 'fac-1',
      line_id: 'line-1',
      window: { start: '2026-10-01', end: '2026-11-30' },
      quantity: 1000,
    }),
  );
  return store;
}

function propose(id, overrides = {}) {
  return msg(id, 'commitment_proposed', {
    commitment_id: `cmt-${id}`,
    round_id: 'rd-1',
    enterprise_id: 'ent-1',
    region_id: 'region-1',
    drug_id: 'drug-A',
    spec: '0.5g',
    quantity: 100,
    deliveries: [{ month: '2026-10', quantity: 100 }],
    backing: [{ lot_id: 'lot-1', quantity: 100 }],
    ...overrides,
  });
}

test('确认后可用量被锁定，同一库存不能再承诺给另一地区', () => {
  const store = seedStore();
  assert.equal(ingest(store, propose('a', { quantity: 600, deliveries: [{ month: '2026-10', quantity: 600 }], backing: [{ lot_id: 'lot-1', quantity: 600 }] })).status, 'applied');
  assert.equal(ingest(store, msg('c-1', 'commitment_confirmed', { commitment_id: 'cmt-a', enterprise_id: 'ent-1' })).status, 'applied');
  // 已锁定 600，剩余 400；再承诺 500 给另一地区应被拒绝
  const rejected = ingest(
    store,
    propose('b', {
      region_id: 'region-2',
      quantity: 500,
      deliveries: [{ month: '2026-10', quantity: 500 }],
      backing: [{ lot_id: 'lot-1', quantity: 500 }],
    }),
  );
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.reason, /可用量不足/);
  // 400 以内可以
  assert.equal(
    ingest(
      store,
      propose('c', {
        region_id: 'region-2',
        quantity: 400,
        deliveries: [{ month: '2026-10', quantity: 400 }],
        backing: [{ lot_id: 'lot-1', quantity: 400 }],
      }),
    ).status,
    'applied',
  );
});

test('提议不锁定，确认才占用可用量', () => {
  const store = seedStore();
  assert.equal(ingest(store, propose('a', { quantity: 900, deliveries: [{ month: '2026-10', quantity: 900 }], backing: [{ lot_id: 'lot-1', quantity: 900 }] })).status, 'applied');
  // 未确认前，另一提议仍可申报（协调中允许竞争性提议）
  assert.equal(ingest(store, propose('b', { region_id: 'region-2', quantity: 200, deliveries: [{ month: '2026-10', quantity: 200 }], backing: [{ lot_id: 'lot-1', quantity: 200 }] })).status, 'applied');
  assert.equal(ingest(store, msg('c-1', 'commitment_confirmed', { commitment_id: 'cmt-a', enterprise_id: 'ent-1' })).status, 'applied');
  // cmt-a 确认后锁定 900，cmt-b 确认时只剩 100，应被拒绝
  const rejected = ingest(store, msg('c-2', 'commitment_confirmed', { commitment_id: 'cmt-b', enterprise_id: 'ent-1' }));
  assert.equal(rejected.status, 'rejected');
});

test('迟到的产量修订只重算未锁定部分，低于锁定量时记录异常', () => {
  const store = seedStore();
  ingest(store, propose('a', { quantity: 600, deliveries: [{ month: '2026-10', quantity: 600 }], backing: [{ lot_id: 'lot-1', quantity: 600 }] }));
  ingest(store, msg('c-1', 'commitment_confirmed', { commitment_id: 'cmt-a', enterprise_id: 'ent-1' }));
  // 修订到 500 < 已锁定 600：锁定量保持 600，未锁定部分归零，记录异常
  const receipt = ingest(store, msg('r-1', 'capacity_revised', { lot_id: 'lot-1', new_quantity: 500, reason: '设备故障减产' }));
  assert.equal(receipt.status, 'applied');
  const state = project(store);
  assert.equal(state.lots['lot-1'].current_quantity, 600);
  assert.equal(state.exceptions.length, 1);
  assert.equal(state.exceptions[0].kind, 'revision_below_locked');
  assert.equal(state.exceptions[0].detail.locked, 600);
  // 已确认承诺不受修订影响
  assert.equal(state.commitments['cmt-a'].quantity, 600);
});

test('高于锁定量的迟到修订正常生效', () => {
  const store = seedStore();
  ingest(store, propose('a', { quantity: 600, deliveries: [{ month: '2026-10', quantity: 600 }], backing: [{ lot_id: 'lot-1', quantity: 600 }] }));
  ingest(store, msg('c-1', 'commitment_confirmed', { commitment_id: 'cmt-a', enterprise_id: 'ent-1' }));
  assert.equal(ingest(store, msg('r-1', 'capacity_revised', { lot_id: 'lot-1', new_quantity: 800, reason: '排产调整' })).status, 'applied');
  const state = project(store);
  assert.equal(state.lots['lot-1'].current_quantity, 800);
  assert.equal(state.exceptions.length, 0);
});

test('重复消息按 message_id 去重，状态不变', () => {
  const store = seedStore();
  const first = msg('dup-1', 'capacity_revised', { lot_id: 'lot-1', new_quantity: 900, reason: '口径更新' });
  const a = ingest(store, first);
  const b = ingest(store, first);
  assert.equal(a.status, 'applied');
  assert.equal(b.duplicate, true);
  assert.equal(project(store).lots['lot-1'].current_quantity, 900);
  assert.equal(store.events.filter((event) => event.message_id === 'dup-1').length, 1);
});

test('跨月交付与部分撤回保持总量一致', () => {
  const store = seedStore();
  ingest(
    store,
    propose('a', {
      quantity: 500,
      deliveries: [
        { month: '2026-10', quantity: 300 },
        { month: '2026-11', quantity: 200 },
      ],
      backing: [{ lot_id: 'lot-1', quantity: 500 }],
    }),
  );
  ingest(store, msg('c-1', 'commitment_confirmed', { commitment_id: 'cmt-a', enterprise_id: 'ent-1' }));
  // 部分撤回 11 月的 80
  const receipt = ingest(
    store,
    msg('w-1', 'commitment_withdrawn', {
      commitment_id: 'cmt-a',
      quantity: 80,
      deliveries: [{ month: '2026-11', quantity: 80 }],
      reason: '需求调减',
    }),
  );
  assert.equal(receipt.status, 'applied');
  const commitment = project(store).commitments['cmt-a'];
  assert.equal(commitment.quantity, 420);
  assert.equal(commitment.deliveries.reduce((total, row) => total + row.quantity, 0), 420);
  assert.equal(commitment.backing.reduce((total, row) => total + row.quantity, 0), 420);
  assert.equal(commitment.status, 'confirmed');
  // 撤回的量重新可用
  const scenario = computeScenario(project(store));
  assert.equal(scenario.supply[0].available_quantity, 580);
});

test('撤回量与交付明细不一致时拒绝', () => {
  const store = seedStore();
  ingest(store, propose('a'));
  const receipt = ingest(
    store,
    msg('w-1', 'commitment_withdrawn', {
      commitment_id: 'cmt-a',
      quantity: 50,
      deliveries: [{ month: '2026-10', quantity: 30 }],
      reason: '测试',
    }),
  );
  assert.equal(receipt.status, 'rejected');
  assert.match(receipt.reason, /不一致/);
});

test('质检延期不改变总量，但撞上已锁定交付月要记录异常', () => {
  const store = seedStore();
  ingest(store, propose('a'));
  ingest(store, msg('c-1', 'commitment_confirmed', { commitment_id: 'cmt-a', enterprise_id: 'ent-1' }));
  // 质检放行推迟到 11 月中旬，10 月交付月已锁定
  const receipt = ingest(
    store,
    msg('q-1', 'constraint_reported', {
      constraint_id: 'qc-1',
      kind: 'qc_release',
      lot_id: 'lot-1',
      release_at: '2026-11-15',
    }),
  );
  assert.equal(receipt.status, 'applied');
  const state = project(store);
  assert.equal(state.commitments['cmt-a'].quantity, 100);
  assert.equal(state.lots['lot-1'].current_quantity, 1000);
  assert.equal(state.exceptions.some((exception) => exception.kind === 'qc_delay_conflicts_lock'), true);
});

test('提议后发生检修或质检延期的，确认时被拦截', () => {
  const store = seedStore();
  ingest(store, propose('a'));
  ingest(
    store,
    msg('q-1', 'constraint_reported', {
      constraint_id: 'qc-1',
      kind: 'qc_release',
      lot_id: 'lot-1',
      release_at: '2026-11-15',
    }),
  );
  const receipt = ingest(store, msg('c-1', 'commitment_confirmed', { commitment_id: 'cmt-a', enterprise_id: 'ent-1' }));
  assert.equal(receipt.status, 'rejected');
  assert.match(receipt.reason, /不可交付/);
});

test('紧急人工调整必须附理由和受影响地区的替代安排', () => {
  const store = seedStore();
  ingest(store, propose('a', { quantity: 300, deliveries: [{ month: '2026-10', quantity: 300 }], backing: [{ lot_id: 'lot-1', quantity: 300 }] }));
  ingest(store, msg('c-1', 'commitment_confirmed', { commitment_id: 'cmt-a', enterprise_id: 'ent-1' }));
  // 缺替代安排：拒绝
  const missing = ingest(
    store,
    msg('adj-1', 'manual_adjustment', {
      adjustment_id: 'adj-1',
      reason: '紧急调配',
      operations: [{ type: 'force_withdraw', commitment_id: 'cmt-a', quantity: 100, deliveries: [{ month: '2026-10', quantity: 100 }] }],
      alternatives: [],
    }),
  );
  assert.equal(missing.status, 'rejected');
  assert.match(missing.reason, /替代安排/);
  // 缺理由：拒绝
  const noReason = ingest(
    store,
    msg('adj-2', 'manual_adjustment', {
      adjustment_id: 'adj-2',
      reason: '',
      operations: [{ type: 'force_withdraw', commitment_id: 'cmt-a', quantity: 100, deliveries: [{ month: '2026-10', quantity: 100 }] }],
      alternatives: [{ region_id: 'region-1', arrangement: '储备补足' }],
    }),
  );
  assert.equal(noReason.status, 'rejected');
  // 齐全：放行并释放锁定量
  const ok = ingest(
    store,
    msg('adj-3', 'manual_adjustment', {
      adjustment_id: 'adj-3',
      reason: '紧急调配',
      operations: [{ type: 'force_withdraw', commitment_id: 'cmt-a', quantity: 100, deliveries: [{ month: '2026-10', quantity: 100 }] }],
      alternatives: [{ region_id: 'region-1', arrangement: '由区域储备 10 月 15 日前补足 100' }],
    }),
  );
  assert.equal(ok.status, 'applied');
  const state = project(store);
  assert.equal(state.commitments['cmt-a'].quantity, 200);
  assert.equal(state.adjustments.length, 1);
  assert.equal(state.adjustments[0].alternatives[0].region_id, 'region-1');
});

test('履约更正与原记录并列留存而非覆盖', () => {
  const store = seedStore();
  ingest(store, propose('a'));
  ingest(store, msg('c-1', 'commitment_confirmed', { commitment_id: 'cmt-a', enterprise_id: 'ent-1' }));
  ingest(store, msg('f-1', 'fulfillment_reported', { fulfillment_id: 'ful-1', commitment_id: 'cmt-a', delivered: [{ month: '2026-10', quantity: 60 }] }));
  ingest(
    store,
    msg('f-2', 'fulfillment_corrected', {
      correction_id: 'ful-1-c1',
      fulfillment_id: 'ful-1',
      delivered: [{ month: '2026-10', quantity: 75 }],
      reason: '入库复核更正',
    }),
  );
  const commitment = project(store).commitments['cmt-a'];
  assert.equal(commitment.fulfillments.length, 2);
  assert.equal(commitment.fulfillments[0].quantity ?? commitment.fulfillments[0].delivered[0].quantity, 60);
  assert.equal(commitment.fulfillments[1].corrects, 'ful-1');
  assert.equal(commitment.fulfillments[1].version, 2);
});

test('情景比较输出建议与检修影响，且不改动账本状态', () => {
  const store = seedStore();
  ingest(store, msg('d-1', 'demand_declared', { demand_id: 'dem-1', region_id: 'region-1', drug_id: 'drug-A', spec: '0.5g', month: '2026-11', tier: 'urgent', quantity: 500 }));
  ingest(
    store,
    msg('m-1', 'constraint_reported', {
      constraint_id: 'mt-1',
      kind: 'maintenance',
      factory_id: 'fac-1',
      line_id: 'line-1',
      window: { start: '2026-11-10', end: '2026-11-20' },
    }),
  );
  const before = JSON.stringify(project(store));
  const scenario = computeScenario(project(store));
  assert.equal(JSON.stringify(project(store)), before);
  assert.equal(scenario.basis, 'advisory_only');
  assert.equal(scenario.supply[0].blocked_months.includes('2026-11'), true);
  // 11 月被检修阻塞，无法分配，缺口 500
  assert.equal(scenario.gaps.length, 1);
  assert.equal(scenario.gaps[0].gap, 500);
  assert.equal(scenario.maintenance_impact[0].blocked_lots[0].lot_id, 'lot-1');
});

test('情景比较尊重最低保障线与在途冲抵', () => {  const store = seedStore();
  ingest(store, msg('d-1', 'demand_declared', { demand_id: 'dem-1', region_id: 'region-1', drug_id: 'drug-A', spec: '0.5g', month: '2026-10', tier: 'urgent', quantity: 800 }));
  ingest(store, msg('d-2', 'demand_declared', { demand_id: 'dem-2', region_id: 'region-2', drug_id: 'drug-A', spec: '0.5g', month: '2026-10', tier: 'urgent', quantity: 200 }));
  ingest(store, msg('it-1', 'constraint_reported', { constraint_id: 'it-1', kind: 'in_transit', enterprise_id: 'ent-1', drug_id: 'drug-A', spec: '0.5g', region_id: 'region-2', quantity: 100, arrives_at: '2026-10-03' }));
  ingest(store, msg('mg-1', 'constraint_reported', { constraint_id: 'mg-1', kind: 'min_guarantee', region_id: 'region-2', drug_id: 'drug-A', spec: '0.5g', month: '2026-10', quantity: 200 }));
  const scenario = computeScenario(project(store));
  // region-2 在途 100 + 分配 100 满足保障线 200；region-1 需求 800 全部分得
  const r2 = scenario.allocation.find((row) => row.region_id === 'region-2');
  const r1 = scenario.allocation.find((row) => row.region_id === 'region-1');
  assert.equal(r2.quantity, 100);
  assert.equal(r1.quantity, 800);
  assert.equal(scenario.gaps.length, 0);
});

test('零供给时需求缺口仍然可见', () => {
  const store = createStore();
  ingest(store, msg('d-1', 'demand_declared', { demand_id: 'dem-1', region_id: 'region-1', drug_id: 'drug-B', spec: '1g', month: '2026-10', tier: 'urgent', quantity: 300 }));
  const scenario = computeScenario(project(store));
  assert.equal(scenario.supply.length, 0);
  assert.equal(scenario.gaps.length, 1);
  assert.equal(scenario.gaps[0].gap, 300);
});

test('轮次关闭冻结对账单：产能-承诺映射、缺口、未确认方齐全', () => {
  const store = seedStore();
  ingest(store, msg('d-1', 'demand_declared', { demand_id: 'dem-1', region_id: 'region-1', drug_id: 'drug-A', spec: '0.5g', month: '2026-10', tier: 'urgent', quantity: 250 }));
  ingest(store, propose('a'));
  ingest(store, msg('c-1', 'commitment_confirmed', { commitment_id: 'cmt-a', enterprise_id: 'ent-1' }));
  ingest(store, propose('b', { region_id: 'region-1', quantity: 50, deliveries: [{ month: '2026-10', quantity: 50 }], backing: [{ lot_id: 'lot-1', quantity: 50 }] }));
  ingest(store, msg('f-1', 'fulfillment_reported', { fulfillment_id: 'ful-1', commitment_id: 'cmt-a', delivered: [{ month: '2026-10', quantity: 60 }] }));
  ingest(store, msg('f-2', 'fulfillment_corrected', { correction_id: 'ful-1-c1', fulfillment_id: 'ful-1', delivered: [{ month: '2026-10', quantity: 70 }], reason: '复核更正' }));
  assert.equal(ingest(store, msg('rc-1', 'round_closed', { round_id: 'rd-1' })).status, 'applied');
  const statement = project(store).rounds['rd-1'].statement;
  // 哪笔产能支撑哪项承诺
  const entryA = statement.entries.find((entry) => entry.commitment_id === 'cmt-a');
  assert.equal(entryA.backing[0].lot_id, 'lot-1');
  assert.equal(entryA.backing[0].quantity, 100);
  // 履约更正并列
  assert.equal(entryA.fulfillments.length, 2);
  assert.equal(entryA.fulfilled_quantity, 70);
  // 缺口：需求 250，已确认交付 100
  const gap = statement.demand_gaps.find((row) => row.demand_id === 'dem-1');
  assert.equal(gap.gap, 150);
  // 谁尚未确认：cmt-b 仍停留提议
  assert.equal(statement.pending_confirmations.length, 1);
  assert.equal(statement.pending_confirmations[0].commitment_id, 'cmt-b');
  assert.equal(statement.totals.confirmed_quantity, 100);
});

test('企业视图只见自身明细，公开视图只含脱敏结论', () => {
  const store = seedStore();
  ingest(
    store,
    msg('s-3', 'capacity_declared', {
      lot_id: 'lot-2',
      enterprise_id: 'ent-2',
      drug_id: 'drug-A',
      spec: '0.5g',
      factory_id: 'fac-9',
      line_id: 'line-9',
      window: { start: '2026-10-01', end: '2026-10-31' },
      quantity: 300,
    }),
  );
  ingest(store, msg('d-1', 'demand_declared', { demand_id: 'dem-1', region_id: 'region-1', drug_id: 'drug-A', spec: '0.5g', month: '2026-10', tier: 'urgent', quantity: 500 }));
  ingest(store, propose('a'));
  ingest(store, msg('c-1', 'commitment_confirmed', { commitment_id: 'cmt-a', enterprise_id: 'ent-1' }));

  const entView = enterpriseView(project(store), 'ent-1');
  assert.equal(entView.lots.length, 1);
  assert.equal(entView.lots[0].lot_id, 'lot-1');
  assert.equal(entView.commitments.length, 1);
  assert.equal(entView.gap_summary[0].requested, 500);
  // 汇总缺口不含其他企业批次标识
  assert.equal(JSON.stringify(entView.gap_summary).includes('lot-2'), false);

  const pub = publicView(project(store));
  const leaked = JSON.stringify(pub);
  for (const marker of ['ent-1', 'ent-2', 'region-1', 'fac-', 'line-', 'lot-']) {
    assert.equal(leaked.includes(marker), false, `公开视图不应包含 ${marker}`);
  }
  assert.equal(pub.conclusions[0].gap, 400);
  // 覆盖率 100/500 = 0.2，低于 0.8 阈值，判定为短缺
  assert.equal(pub.conclusions[0].shortage_level, 'shortage');

  const tf = taskForceView(project(store), receiptsOf(store));
  assert.equal(tf.commitments.length, 1);
  assert.ok(tf.receipts.length > 0);
  assert.equal(tf.scenario.basis, 'advisory_only');
});

test('样例消息序列全流程回放保持总量一致', async () => {
  const record = await loadRecord(join(here, '..', 'fixtures', 'coordination_messages.json'));
  assert.equal(record.domain, 'shortage_coordination');
  const store = createStore();
  const receipts = record.messages.map((message) => ingest(store, message));
  const duplicates = receipts.filter((receipt) => receipt.duplicate);
  const rejected = receipts.filter((receipt) => receipt.status === 'rejected');
  assert.equal(duplicates.length, 1, '样例中的重复消息应被去重');
  assert.equal(rejected.length, 0, `样例不应有被拒消息: ${JSON.stringify(rejected)}`);

  const state = project(store);
  // 总量一致：承诺量 = 交付明细合计 = 产能占用合计
  for (const commitment of Object.values(state.commitments)) {
    const delivered = commitment.deliveries.reduce((total, row) => total + row.quantity, 0);
    const backed = commitment.backing.reduce((total, row) => total + row.quantity, 0);
    assert.equal(delivered, commitment.quantity, `${commitment.commitment_id} 交付合计不一致`);
    assert.equal(backed, commitment.quantity, `${commitment.commitment_id} 占用合计不一致`);
  }
  // 锁定量不超过当前申报量
  for (const lot of Object.values(state.lots)) {
    const locked = Object.values(state.commitments)
      .filter((commitment) => commitment.status === 'confirmed')
      .flatMap((commitment) => commitment.backing)
      .filter((slice) => slice.lot_id === lot.lot_id)
      .reduce((total, slice) => total + slice.quantity, 0);
    assert.ok(locked <= lot.current_quantity, `${lot.lot_id} 锁定量超限`);
  }
  // 对账单已冻结且三方信息齐全
  const statement = state.rounds['rd-2026-09'].statement;
  assert.ok(statement);
  assert.equal(statement.entries.length, 3);
  assert.equal(statement.pending_confirmations.length, 1);
  assert.equal(statement.pending_confirmations[0].commitment_id, 'cmt-C3');
  // 人工调整留下记录，受影响地区有替代安排
  assert.equal(statement.adjustments.length, 1);
  assert.equal(statement.adjustments[0].alternatives[0].region_id, 'region-R1');
  // 履约更正并列：cmt-C2 两条履约记录
  const c2 = statement.entries.find((entry) => entry.commitment_id === 'cmt-C2');
  assert.equal(c2.fulfillments.length, 2);
  assert.equal(c2.fulfilled_quantity, 350);
  // 检修异常被记录
  assert.equal(state.exceptions.some((exception) => exception.kind === 'maintenance_conflicts_lock'), true);
});
