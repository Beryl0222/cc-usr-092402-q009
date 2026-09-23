import { readFile } from 'node:fs/promises';

/** 读取项目已经确认的最小数据合同，不包含业务流程实现。 */
export async function loadRecord(path) {
  const payload = JSON.parse(await readFile(path, 'utf8'));
  if (!Number.isInteger(payload.schema_version) || !payload.record_id) {
    throw new Error('数据合同缺少必要标识');
  }
  return Object.freeze(payload);
}
