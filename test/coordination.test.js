import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { CoordinationRound, EVENT_TYPES, monthCompare } from '../src/ledger.js';
import {
  run,
  submit,
  declareCapacity,
  reviseCapacity,
  scheduleMaintenance,
  releaseQc,
  delayQc,
  reportShipment,
  arriveShipment,
  cancelShipment,
  submitDemand,
  makeSlices,
  proposeCommitment,
  confirmCommitment,
  rejectCommitment,
  withdrawCommitment,
  emergencyAdjust,
  correctFulfillment,
  closeRound,
} from '../src/coordination.js';
import { buildScenario, summarizeGaps } from '../src/scenarios.js';
import { buildStatement } from '../src/reconcile.js';
import { enterpriseView, taskForceView, publicView } from '../src/views.js';

const here = dirname(fileURLToPath(import.meta.url));
const T0 = '2026-09-22T09:00:00+08:00';

function newRound(asOf = '2026-09') {
  return new CoordinationRound({
    record_id: 't-001',
    round_id: 't-round',
    occurred_at: T0,
    source: '测试',
    as_of_window: asOf,
  });
}

function cap(id, qty, { ent = 'ent-A', win = '2026-09', spec = 'spec-001', factory = 'fac-A1', line = 'line-A1' } = {}) {
  return declareCapacity(
    {
      capacity_id: id, enterprise_id: ent, factory_id: factory, line_id: line,
      spec_id: spec, window_id: win, qty,
    },
    `m-${id}`,
  );
}

function demand(region, win, qty, { tier = 1, minimum = 0, spec = 'spec-001' } = {}) {
  return submitDemand(
    { region_id: region, spec_id: spec, window_id: win, tier, qty, minimum_line: minimum },
    `m-d-${region}-${win}`,
  );
}

function propose(id, capacityId, region, qty, slices) {
  return proposeCommitment(
    {
      commitment_id: id, capacity_id: capacityId, region_id: region,
      spec_id: 'spec-001', qty, slices: slices ?? [{ window_id: '2026-09', qty }],
    },
    `m-${id}-p`,
  );
}

function rowFor(scenario, region, win = '2026-09') {
  const rows = scenario.windows.find((w) => w.window_id === win)?.rows ?? [];
  return rows.find((r) => r.region_id === region);
}

test('v1 样例可自动迁移为空轮次（保持 record_id 与 occurred_at）', async () => {
  const record = JSON.parse(
    await readFile(join(here, '..', 'fixtures', 'supply_declaration.json'), 'utf8'),
  );
  const round = CoordinationRound.fromRecord(record);
  assert.equal(round.meta.record_id, 'sample-012');
  assert.equal(round.meta.source, '业务样例');
  assert.equal(round.view().events.length, 0);
  const json = round.toJSON();
  assert.equal(json.schema_version, 2);
  assert.equal(json.revision, 1);
  assert.equal(json.domain, 'supply_report');
});

test('v2 脱敏样例重放后守恒、待确认与更正列正确', async () => {
  const record = JSON.parse(
    await readFile(join(here, '..', 'fixtures', 'coordination_round.json'), 'utf8'),
  );
  const round = CoordinationRound.fromRecord(record);
  const view = round.view();
  assert.equal(view.closed, true);
  const a = view.capacities.find((c) => c.capacity_id === 'cap-A-0901');
  assert.equal(a.current_qty, 1000);
  assert.equal(a.maintenance_qty, 300);
  assert.equal(a.effective_qty, 700);
  assert.equal(a.locked_qty, 500);
  assert.equal(a.free_qty, 200);
  const b = view.capacities.find((c) => c.capacity_id === 'cap-B-0901');
  assert.equal(b.current_qty, 450); // 迟到修订生效
  assert.equal(b.locked_qty, 400);
  assert.equal(b.free_qty, 50);
  const cmt4 = view.commitments.find((c) => c.commitment_id === 'cmt-004');
  assert.equal(cmt4.remaining_qty, 250);
  const statement = buildStatement(view);
  assert.equal(statement.conservation.ok, true);
  assert.deepEqual(
    statement.pending_confirmations.map((p) => p.commitment_id),
    ['cmt-003'],
  );
  const correction = statement.corrections[0];
  assert.equal(correction.original_slice_qty, 500);
  assert.equal(correction.corrected_fulfilled_qty, 480);
  assert.equal(correction.variance_qty, -20);

  // 一次检修应能关联到它影响的交付窗口与地区承诺
  const scenario = buildScenario(view);
  const maint = scenario.maintenance_impacts.find((m) => m.maintenance_id === 'maint-A-09');
  assert.deepEqual(maint.affected_delivery_windows, ['2026-09']);
  assert.ok(
    maint.affected_deliveries.some(
      (d) => d.commitment_id === 'cmt-001' && d.region_id === 'region-N1' && d.window_id === '2026-09',
    ),
  );
});

test('重复消息（相同 message_id）幂等，相同消息原样重发同样折叠为 duplicate', () => {
  const round = newRound();
  const command = cap('cap-x', 100);
  const first = submit(round, command);
  assert.equal(first.duplicate, false);
  const second = submit(round, { ...command });
  assert.equal(second.duplicate, true);
  // 原样重发（连 event_id 都相同）也必须折叠，不能报 event_id 冲突
  const third = submit(round, command);
  assert.equal(third.duplicate, true);
  assert.equal(round.view().events.length, 1);
});

test('同一库存确认给两个地区时，第二个确认因超锁定被拒', () => {
  const round = newRound();
  run(round, [
    cap('c1', 100),
    demand('region-N1', '2026-09', 100),
    demand('region-N2', '2026-09', 100),
    propose('x1', 'c1', 'region-N1', 100),
    confirmCommitment('x1', 'm-x1-c'),
    propose('x2', 'c1', 'region-N2', 100),
  ]);
  // 建议阶段允许并存（专班可见排队），但确认必须失败
  assert.throws(
    () => submit(round, confirmCommitment('x2', 'm-x2-c')),
    /锁定 200 超过有效产能 100/,
  );
  const view = round.view();
  assert.equal(view.commitments.find((c) => c.commitment_id === 'x2').status, 'proposed');
  assert.equal(view.capacities[0].locked_qty, 100);
});

test('迟到的产量修订只重算未锁定窗口；低于锁定量被拒', () => {
  const round = newRound();
  run(round, [
    cap('c2', 500),
    demand('region-N1', '2026-09', 500),
    propose('p2', 'c2', 'region-N1', 400),
    confirmCommitment('p2', 'm-p2-c'),
  ]);
  // 420 >= 锁定 400：未锁定的 100 变为 20，成功
  submit(round, reviseCapacity({ capacity_id: 'c2', new_qty: 420, reason: '原料延迟' }, 'm-rev-ok'));
  assert.equal(round.view().capacities.find((c) => c.capacity_id === 'c2').current_qty, 420);
  // 399 < 锁定 400：拒绝
  assert.throws(
    () => submit(round, reviseCapacity({ capacity_id: 'c2', new_qty: 399 }, 'm-rev-bad')),
    /锁定 400 超过有效产能 399/,
  );
  assert.equal(round.view().capacities.find((c) => c.capacity_id === 'c2').current_qty, 420);
});

test('检修登记后有效产能与锁定联动；过深检修在有锁定时被拒', () => {
  const round = newRound();
  run(round, [
    cap('c3', 1000),
    propose('p3', 'c3', 'region-N1', 800),
    confirmCommitment('p3', 'm-p3-c'),
  ]);
  assert.throws(
    () =>
      submit(
        round,
        scheduleMaintenance(
          {
            maintenance_id: 'mnt-1', enterprise_id: 'ent-A', factory_id: 'fac-A1', line_id: 'line-A1',
            window_id: '2026-09', impacts: [{ spec_id: 'spec-001', down_qty: 300 }],
          },
          'm-mnt-1',
        ),
      ),
    /守恒校验失败/,
  );
  submit(
    round,
    scheduleMaintenance(
      {
        maintenance_id: 'mnt-1', enterprise_id: 'ent-A', factory_id: 'fac-A1', line_id: 'line-A1',
        window_id: '2026-09', impacts: [{ spec_id: 'spec-001', down_qty: 150 }],
      },
      'm-mnt-2',
    ),
  );
  const c = round.view().capacities.find((x) => x.capacity_id === 'c3');
  assert.equal(c.maintenance_qty, 150);
  assert.equal(c.effective_qty, 850);
  assert.equal(c.free_qty, 50);
});

test('质检延期只跨窗挪动、总量不变；超额延期被拒', () => {
  const round = newRound();
  run(round, [
    cap('c4', 100),
    releaseQc(
      { batch_id: 'b1', enterprise_id: 'ent-A', factory_id: 'fac-A1', spec_id: 'spec-001', window_id: '2026-09', qty: 200 },
      'm-b1',
    ),
    delayQc({ batch_id: 'b1', from_window_id: '2026-09', to_window_id: '2026-10', qty: 80 }, 'm-b1-d'),
  ]);
  const batches = round.view().batches;
  assert.equal(batches[0].released_total, 200);
  assert.deepEqual(
    batches[0].releases,
    [{ window_id: '2026-09', qty: 120 }, { window_id: '2026-10', qty: 80 }],
  );
  assert.throws(
    () =>
      submit(
        round,
        delayQc({ batch_id: 'b1', from_window_id: '2026-09', to_window_id: '2026-11', qty: 200 }, 'm-b1-d2'),
      ),
    /不能延期 200/,
  );
});

test('在途：抵达 + 取消 + 剩余 = 申报总量，超额抵达/取消被拒', () => {
  const round = newRound();
  run(round, [
    cap('c5', 100),
    reportShipment(
      {
        shipment_id: 's1', enterprise_id: 'ent-A', spec_id: 'spec-001',
        destination_region_id: 'region-N1', qty: 100, eta_window_id: '2026-09',
      },
      'm-s1',
    ),
    arriveShipment({ shipment_id: 's1', window_id: '2026-09', qty: 60 }, 'm-s1-a'),
    cancelShipment({ shipment_id: 's1', qty: 30 }, 'm-s1-c'),
  ]);
  const s = round.view().shipments[0];
  assert.equal(s.arrived_total, 60);
  assert.equal(s.cancelled_qty, 30);
  assert.equal(s.remaining_qty, 10);
  assert.throws(
    () => submit(round, arriveShipment({ shipment_id: 's1', window_id: '2026-09', qty: 50 }, 'm-s1-a2')),
    /不能抵达 50/,
  );
});

test('跨月交付切片合计必须等于承诺总量', () => {
  const round = newRound();
  run(round, [cap('c6', 500), demand('region-N1', '2026-10', 300)]);
  assert.throws(
    () =>
      submit(
        round,
        proposeCommitment(
          {
            commitment_id: 'p6', capacity_id: 'c6', region_id: 'region-N1', spec_id: 'spec-001', qty: 300,
            slices: [
              { window_id: '2026-10', qty: 150 },
              { window_id: '2026-11', qty: 100 },
            ],
          },
          'm-p6',
        ),
      ),
    /切片合计 250 与承诺总量 300 不一致/,
  );
});

test('makeSlices 从起始月生成跨月切片', () => {
  assert.deepEqual(makeSlices('2026-12', [10, 20, 30]), [
    { window_id: '2026-12', qty: 10 },
    { window_id: '2027-01', qty: 20 },
    { window_id: '2027-02', qty: 30 },
  ]);
});

test('部分撤回仅限未来窗；到期锁定窗改走紧急调整', () => {
  const round = newRound('2026-09');
  run(round, [
    cap('c7', 500),
    propose('p7', 'c7', 'region-N1', 300, [
      { window_id: '2026-09', qty: 200 },
      { window_id: '2026-11', qty: 100 },
    ]),
    confirmCommitment('p7', 'm-p7-c'),
  ]);
  // 当前协调窗为 9 月：9 月切片已到期，普通撤回被拒
  assert.throws(
    () => submit(round, withdrawCommitment({ commitment_id: 'p7', window_id: '2026-09', qty: 50 }, 'm-p7-w0')),
    /请走紧急调整/,
  );
  // 11 月是未来窗：允许
  submit(
    round,
    withdrawCommitment({ commitment_id: 'p7', window_id: '2026-11', qty: 40, reason: '包材' }, 'm-p7-w1'),
  );
  const cmt = round.view().commitments.find((c) => c.commitment_id === 'p7');
  assert.equal(cmt.remaining_qty, 260);
  assert.equal(cmt.slices.find((s) => s.window_id === '2026-11').remaining_qty, 60);
});

test('紧急人工调整必须附理由与每个受影响地区的替代安排', () => {
  const round = newRound();
  run(round, [
    cap('c8', 500),
    propose('p8', 'c8', 'region-N1', 300),
    confirmCommitment('p8', 'm-p8-c'),
  ]);
  // 缺替代安排 → 拒绝
  assert.throws(
    () =>
      submit(
        round,
        emergencyAdjust(
          {
            adjustment_id: 'adj-bad', operator_id: 'ops-1', reason: '突发管控',
            items: [{ kind: 'commitment_reduce', commitment_id: 'p8', window_id: '2026-09', qty: 100 }],
            impacts: [{ region_id: 'region-N1', window_id: '2026-09', qty: 100 }],
            alternatives: [],
          },
          'm-adj-bad',
        ),
      ),
    /缺少受影响地区 region-N1 的替代安排/,
  );
  // 齐备 → 成功，锁定量同步释放
  submit(
    round,
    emergencyAdjust(
      {
        adjustment_id: 'adj-ok', operator_id: 'ops-1', reason: '突发管控',
        items: [{ kind: 'commitment_reduce', commitment_id: 'p8', window_id: '2026-09', qty: 100 }],
        impacts: [{ region_id: 'region-N1', window_id: '2026-09', qty: 100 }],
        alternatives: [
          { region_id: 'region-N1', arrangement: '商业储备调剂100', replacement_qty: 100 },
        ],
      },
      'm-adj-ok',
    ),
  );
  const cmt = round.view().commitments.find((c) => c.commitment_id === 'p8');
  assert.equal(cmt.remaining_qty, 200);
  assert.equal(round.view().capacities[0].locked_qty, 200);
  assert.equal(round.view().adjustments.length, 1);
});

test('紧急调整可把腾出产能以新承诺重配给另一地区且保持守恒', () => {
  const round = newRound();
  run(round, [
    cap('c9', 300),
    demand('region-N1', '2026-09', 300),
    demand('region-N2', '2026-09', 200),
    propose('p9a', 'c9', 'region-N1', 300),
    confirmCommitment('p9a', 'm-p9a-c'),
  ]);
  submit(
    round,
    emergencyAdjust(
      {
        adjustment_id: 'adj-move', operator_id: 'ops-1', reason: 'N2 更紧急',
        items: [{ kind: 'commitment_reduce', commitment_id: 'p9a', window_id: '2026-09', qty: 150 }],
        impacts: [{ region_id: 'region-N1', window_id: '2026-09', qty: 150 }],
        alternatives: [{ region_id: 'region-N1', arrangement: '下月补足150', replacement_qty: 150 }],
        new_commitments: [
          {
            commitment_id: 'p9b', capacity_id: 'c9', region_id: 'region-N2', spec_id: 'spec-001',
            qty: 150, slices: [{ window_id: '2026-09', qty: 150 }],
          },
        ],
      },
      'm-adj-move',
    ),
  );
  const view = round.view();
  assert.equal(view.capacities[0].locked_qty, 300);
  const n1 = view.commitments.find((c) => c.commitment_id === 'p9a').remaining_qty;
  const n2 = view.commitments.find((c) => c.commitment_id === 'p9b').remaining_qty;
  assert.equal(n1, 150);
  assert.equal(n2, 150);
});

test('情景试算：先保最低保障线、再按分级补缺口，且建议全部可追溯到产能', () => {
  const round = newRound();
  run(round, [
    cap('ca', 300, { ent: 'ent-A' }),
    cap('cb', 200, { ent: 'ent-B' }),
    demand('region-N1', '2026-09', 300, { tier: 2, minimum: 200 }),
    demand('region-N2', '2026-09', 300, { tier: 1, minimum: 200 }),
  ]);
  const scenario = buildScenario(round.view());
  assert.equal(scenario.advisory, true);
  const n1 = rowFor(scenario, 'region-N1');
  const n2 = rowFor(scenario, 'region-N2');
  // 总自由产能 500；第一遍各保 200 最低线（400），第二遍 tier1 的 N2 再吃 100
  assert.equal(n2.covered_by_suggestion_qty, 300);
  assert.equal(n1.covered_by_suggestion_qty, 200);
  assert.equal(n1.residual_gap_qty, 100);
  for (const s of scenario.suggestions) {
    assert.ok(s.capacity_id.startsWith('cap-') || s.capacity_id.startsWith('c'));
    assert.equal(s.source_type, 'free_capacity');
  }
  const summary = summarizeGaps(scenario);
  assert.equal(summary.total.shortage_qty, 600);
  assert.equal(summary.total.covered_by_suggestion_qty, 500);
  assert.equal(summary.total.residual_gap_qty, 100);
});

test('情景试算不会重复分配已锁定产能；在途未抵达按预计窗缓冲', () => {
  const round = newRound();
  run(round, [
    cap('clock', 200),
    demand('region-N1', '2026-09', 300, { tier: 1, minimum: 100 }),
    propose('pl', 'clock', 'region-N1', 120),
    confirmCommitment('pl', 'm-pl-c'),
    reportShipment(
      {
        shipment_id: 'slt', enterprise_id: 'ent-A', spec_id: 'spec-001',
        destination_region_id: 'region-N1', qty: 80, eta_window_id: '2026-09',
      },
      'm-slt',
    ),
  ]);
  const scenario = buildScenario(round.view());
  const row = rowFor(scenario, 'region-N1');
  assert.equal(row.confirmed_qty, 120);
  assert.equal(row.in_transit_qty, 80); // 在途单列缓冲，供专班比较
  assert.equal(row.shortage_qty, 180); // 保守口径：300 - 120 - 0 已抵达，不计在途
  assert.equal(row.projected_gap_qty, 100); // 预计口径：在途如期到货后的缺口
  assert.equal(row.covered_by_suggestion_qty, 80); // 自由产能只剩 80，按预计缺口补
  assert.equal(row.residual_gap_qty, 100); // 180 - 80；在途若按期抵达则实际可闭合
});

test('情景试算：同一笔产能跨交付窗不会被重复建议', () => {
  const round = newRound();
  run(round, [
    cap('cx', 100),
    demand('region-N1', '2026-09', 80, { tier: 1 }),
    demand('region-N1', '2026-10', 80, { tier: 1 }),
  ]);
  const scenario = buildScenario(round.view());
  const sep = rowFor(scenario, 'region-N1', '2026-09');
  const oct = rowFor(scenario, 'region-N1', '2026-10');
  assert.equal(sep.covered_by_suggestion_qty, 80);
  assert.equal(oct.covered_by_suggestion_qty, 20); // 9 月产能只剩 20 可再建议
  assert.equal(oct.residual_gap_qty, 60);
  const totalSuggested = scenario.suggestions
    .filter((s) => s.capacity_id === 'cx')
    .reduce((a, s) => a + s.qty, 0);
  assert.equal(totalSuggested, 100);
});

test('对账单：产能支撑承诺、缺口、未确认方、履约更正并列与守恒检查', () => {
  const round = newRound();
  run(round, [
    cap('cst', 500),
    demand('region-N1', '2026-09', 450, { minimum: 400 }),
    propose('pcst', 'cst', 'region-N1', 400),
    confirmCommitment('pcst', 'm-pcst-c'),
    correctFulfillment(
      { commitment_id: 'pcst', window_id: '2026-09', corrected_qty: 390, note: '短装' },
      'm-pcst-fix',
    ),
  ]);
  const view = round.view();
  const statement = buildStatement(view, buildScenario(view));
  assert.equal(statement.conservation.ok, true);
  const line = statement.capacity_lines.find((l) => l.capacity_id === 'cst');
  assert.equal(line.supported_commitments[0].commitment_id, 'pcst');
  assert.equal(line.locked_qty, 400);
  const cov = statement.coverage.find((c) => c.region_id === 'region-N1');
  assert.equal(cov.shortage_qty, 50);
  assert.equal(cov.minimum_line_gap_qty, 0);
  assert.deepEqual(
    statement.pending_confirmations.map((p) => p.commitment_id),
    [],
  );
  const corr = statement.corrections.find((c) => c.commitment_id === 'pcst');
  assert.equal(corr.original_slice_qty, 400);
  assert.equal(corr.corrected_fulfilled_qty, 390);
});

test('封存后不能再追加事件；reject 后释放可锁定量', () => {
  const round = newRound();
  run(round, [cap('cend', 100), propose('pend', 'cend', 'region-N1', 100)]);
  submit(round, rejectCommitment('pend', '来不及'));
  assert.equal(round.view().commitments[0].status, 'rejected');
  assert.equal(round.view().capacities[0].locked_qty, 0);
  round.append(closeRound());
  assert.throws(() => submit(round, cap('cend2', 10)), /已封存/);
});

test('企业/专班/公开三视图：数据边界与脱敏', () => {
  const round = newRound();
  run(round, [
    cap('cpub', 400, { ent: 'ent-A' }),
    cap('cpub2', 200, { ent: 'ent-B' }),
    demand('region-N1', '2026-09', 500, { tier: 1, minimum: 300 }),
    propose('ppub', 'cpub', 'region-N1', 300),
    confirmCommitment('ppub', 'm-ppub-c'),
  ]);
  const view = round.view();

  const entA = enterpriseView(view, 'ent-A');
  assert.equal(entA.viewer, 'enterprise');
  assert.deepEqual(
    entA.capacities.map((c) => c.capacity_id),
    ['cpub'],
  );
  assert.equal(entA.commitments.length, 1);
  assert.equal(entA.gap_rows[0].shortage_qty, 200); // 500-300 确认
  // 企业视图不出现其他企业的产能明细
  const serialized = JSON.stringify(entA);
  assert.ok(!serialized.includes('cpub2'));
  assert.ok(!serialized.includes('ent-B'));

  const tf = taskForceView(view);
  assert.equal(tf.viewer, 'task_force');
  assert.equal(tf.scenario.advisory, true);
  assert.ok(tf.statement.conservation.ok);
  assert.equal(tf.pending_confirmations.length, 0);
  assert.ok(tf.receipts.some((r) => r.message_id === 'm-ppub-c'));

  const pub = publicView(view);
  assert.equal(pub.viewer, 'public');
  const text = JSON.stringify(pub);
  for (const secret of ['ent-A', 'ent-B', 'cpub', 'ppub', 'fac-A1', 'line-A1', 'ops-']) {
    assert.ok(!text.includes(secret), `公开视图泄露 ${secret}`);
  }
  assert.equal(pub.conclusions[0].shortage_qty, 200);
  assert.equal(pub.conclusions[0].regions_with_gap_count, 1);
  assert.equal(pub.conservation_ok, true);
});

test('月份窗工具：比较与边界', () => {
  assert.ok(monthCompare('2026-09', '2026-10') < 0);
  assert.ok(monthCompare('2027-01', '2026-12') > 0);
  assert.ok(monthCompare('2026-09', '2026-09') === 0);
});

test('台账可序列化往返：toJSON → fromRecord 状态一致，view 无内部 Map 残留', () => {
  const round = newRound();
  run(round, [
    cap('crt', 300),
    demand('region-N1', '2026-09', 300),
    propose('pcrt', 'crt', 'region-N1', 200),
    confirmCommitment('pcrt', 'm-pcrt-c'),
  ]);
  const json = round.toJSON();
  assert.equal(json.schema_version, 2);
  assert.equal(json.revision, json.events.length + 1);
  const restored = CoordinationRound.fromRecord(JSON.parse(JSON.stringify(json)));
  const a = round.view();
  const b = restored.view();
  assert.equal(b.events.length, a.events.length);
  assert.equal(b.capacities[0].locked_qty, 200);
  assert.deepEqual(
    b.commitments.map((c) => [c.commitment_id, c.status, c.remaining_qty]),
    a.commitments.map((c) => [c.commitment_id, c.status, c.remaining_qty]),
  );
  // 视图必须是干净 JSON（内部 Map 不应残留在输出里）
  const serialized = JSON.stringify(restored.view());
  assert.ok(serialized.includes('"capacities"'));
  assert.ok(serialized.includes('"commitments"'));
});

test('含在途/放行的视图序列化无内部 Map 残留（arrived 不变成 {}）', async () => {
  const record = JSON.parse(
    await readFile(join(here, '..', 'fixtures', 'coordination_round.json'), 'utf8'),
  );
  const view = CoordinationRound.fromRecord(record).view();
  const serialized = JSON.stringify(view);
  assert.ok(serialized.includes('"arrivals"'));
  assert.ok(serialized.includes('"releases"'));
  assert.ok(!/"arrived":\{\}/.test(serialized));
  assert.ok(!/"releases":\{\}/.test(serialized));
  const ship = view.shipments.find((s) => s.shipment_id === 'ship-A-N1');
  assert.equal(ship.arrived_total + ship.cancelled_qty + ship.remaining_qty, ship.qty);
});
