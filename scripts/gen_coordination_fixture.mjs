// 生成脱敏协调轮次样例 fixtures/coordination_round.json：
//   node scripts/gen_coordination_fixture.mjs
// 所有标识均为人为编码（ent-A/region-N1/spec-001…），不含真实主体信息。

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CoordinationRound,
  run,
  declareCapacity,
  scheduleMaintenance,
  releaseQc,
  delayQc,
  reportShipment,
  arriveShipment,
  submitDemand,
  proposeCommitment,
  confirmCommitment,
  withdrawCommitment,
  emergencyAdjust,
  correctFulfillment,
  closeRound,
} from '../src/coordination.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'fixtures', 'coordination_round.json');

const round = new CoordinationRound({
  record_id: 'sample-020',
  round_id: 'round-2026-09',
  occurred_at: '2026-09-21T09:00:00+08:00',
  source: '脱敏协调样例',
  as_of_window: '2026-09',
});

// 固定 message_id，便于演示网络重发时的幂等去重。
const at = (tag) => `m-${tag}`;

run(round, [
  // 企业按工厂/产线/规格/时间窗申报可追溯产能
  declareCapacity(
    {
      capacity_id: 'cap-A-0901', enterprise_id: 'ent-A', factory_id: 'fac-A1', line_id: 'line-A1',
      spec_id: 'spec-001', window_id: '2026-09', qty: 1000,
    },
    at('cap-a-sep'),
  ),
  declareCapacity(
    {
      capacity_id: 'cap-A-1001', enterprise_id: 'ent-A', factory_id: 'fac-A1', line_id: 'line-A1',
      spec_id: 'spec-001', window_id: '2026-10', qty: 800,
    },
    at('cap-a-oct'),
  ),
  declareCapacity(
    {
      capacity_id: 'cap-B-0901', enterprise_id: 'ent-B', factory_id: 'fac-B1', line_id: 'line-B1',
      spec_id: 'spec-001', window_id: '2026-09', qty: 600,
    },
    at('cap-b-sep'),
  ),

  // 设备检修：同一次检修对 9 月窗 spec-001 扣减 300
  scheduleMaintenance(
    {
      maintenance_id: 'maint-A-09', enterprise_id: 'ent-A', factory_id: 'fac-A1', line_id: 'line-A1',
      window_id: '2026-09', impacts: [{ spec_id: 'spec-001', down_qty: 300 }],
      note: '年度计划检修',
    },
    at('maint-a'),
  ),

  // 质检放行分批登记，随后 100 单位延期至 10 月（总量不变）
  releaseQc(
    {
      batch_id: 'batch-A1', enterprise_id: 'ent-A', factory_id: 'fac-A1',
      spec_id: 'spec-001', window_id: '2026-09', qty: 200,
    },
    at('qc-a1'),
  ),
  delayQc(
    { batch_id: 'batch-A1', from_window_id: '2026-09', to_window_id: '2026-10', qty: 100 },
    at('qc-a1-delay'),
  ),

  // 在途 100，实际抵达 60（剩余 40 仍在途，按预计窗计入情景）
  reportShipment(
    {
      shipment_id: 'ship-A-N1', enterprise_id: 'ent-A', spec_id: 'spec-001',
      destination_region_id: 'region-N1', qty: 100, eta_window_id: '2026-09',
    },
    at('ship-a-n1'),
  ),
  arriveShipment({ shipment_id: 'ship-A-N1', window_id: '2026-09', qty: 60 }, at('ship-a-n1-arr')),

  // 地区分级需求与最低保障线
  submitDemand(
    { region_id: 'region-N1', spec_id: 'spec-001', window_id: '2026-09', tier: 1, qty: 700, minimum_line: 500 },
    at('d-n1-sep'),
  ),
  submitDemand(
    { region_id: 'region-N2', spec_id: 'spec-001', window_id: '2026-09', tier: 2, qty: 600, minimum_line: 300 },
    at('d-n2-sep'),
  ),
  submitDemand(
    { region_id: 'region-N1', spec_id: 'spec-001', window_id: '2026-10', tier: 1, qty: 400, minimum_line: 200 },
    at('d-n1-oct'),
  ),

  // 专班建议（advisory）：企业 A 确认 500；企业 B 确认 400；另一笔 200 尚待 A 确认
  proposeCommitment(
    {
      commitment_id: 'cmt-001', capacity_id: 'cap-A-0901', region_id: 'region-N1',
      spec_id: 'spec-001', qty: 500, slices: [{ window_id: '2026-09', qty: 500 }],
    },
    at('cmt-001-p'),
  ),
  confirmCommitment('cmt-001', at('cmt-001-c')),
  proposeCommitment(
    {
      commitment_id: 'cmt-002', capacity_id: 'cap-B-0901', region_id: 'region-N2',
      spec_id: 'spec-001', qty: 400, slices: [{ window_id: '2026-09', qty: 400 }],
    },
    at('cmt-002-p'),
  ),
  confirmCommitment('cmt-002', at('cmt-002-c')),
  proposeCommitment(
    {
      commitment_id: 'cmt-003', capacity_id: 'cap-A-0901', region_id: 'region-N2',
      spec_id: 'spec-001', qty: 200, slices: [{ window_id: '2026-09', qty: 200 }],
    },
    at('cmt-003-p'),
  ), // 故意不确认：对账单呈现"谁尚未确认"

  // 迟到的产量修订：B 企业 9 月产能 600 → 450（已锁定 400，修订只重算未锁定部分）
  // 该命令用固定 message_id 重发一次以演示幂等（见第二条重复提交，实际由提交方去重）。

  // 跨月交付承诺：10 月 200、11 月 100，切片合计必须等于承诺总量
  proposeCommitment(
    {
      commitment_id: 'cmt-004', capacity_id: 'cap-A-1001', region_id: 'region-N1',
      spec_id: 'spec-001', qty: 300,
      slices: [
        { window_id: '2026-10', qty: 200 },
        { window_id: '2026-11', qty: 100 },
      ],
    },
    at('cmt-004-p'),
  ),
  confirmCommitment('cmt-004', at('cmt-004-c')),

  // 部分撤回：仅未来窗（11 月）50
  withdrawCommitment(
    { commitment_id: 'cmt-004', window_id: '2026-11', qty: 50, reason: '包材排产延后' },
    at('cmt-004-w'),
  ),

  // 紧急人工调整：10 月产能调减 100，附理由与受影响地区替代安排
  emergencyAdjust(
    {
      adjustment_id: 'adj-001', operator_id: 'ops-01', reason: '突发排产管控',
      items: [{ kind: 'capacity_reduce', capacity_id: 'cap-A-1001', qty: 100 }],
      impacts: [{ region_id: 'region-N1', window_id: '2026-10', qty: 100 }],
      alternatives: [
        { region_id: 'region-N1', arrangement: '从商业储备调剂100单位，10月中旬到位', replacement_qty: 100 },
      ],
    },
    at('adj-001'),
  ),

  // 履约更正：与原承诺并列留存
  correctFulfillment(
    { commitment_id: 'cmt-001', window_id: '2026-09', corrected_qty: 480, note: '实际放行短装20' },
    at('cmt-001-fix'),
  ),
]);

// 迟到修订（放在确认之后，演示"只重算未锁定窗口"）；同 message_id 重发一次以演示幂等。
for (const i of [1, 2]) {
  run(round, [
    {
      event_id: `evt-revise-b-${i}`,
      occurred_at: '2026-09-22T10:00:00+08:00',
      message_id: 'm-revise-b',
      type: 'capacity_revised',
      capacity_id: 'cap-B-0901',
      new_qty: 450,
      reason: '原料药到货延迟',
    },
  ]);
}

round.append(closeRound());

await writeFile(out, `${JSON.stringify(round.toJSON(), null, 2)}\n`, 'utf8');
console.log(`written ${out}`);
