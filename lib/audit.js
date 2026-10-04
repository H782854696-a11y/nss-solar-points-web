// 操作审计日志：追加写入 data/audit.log
const fs = require('fs');
const path = require('path');

function nowIso() { return new Date().toISOString(); }

// 超过 2MB 归档成 audit.log.1（只保留一代）。不轮转的话文件会无限增长，
// 而「数据主库」页每次打开都要整表读它来统计行数。
const MAX_BYTES = 2 * 1024 * 1024;

// 数据目录。与 lib/store.js 保持同一约定：可用 SP_DATA_DIR 覆盖（仅自动化测试隔离用）。
// 未设置时行为与历史实现完全一致（<项目>/data/audit.log），生产不受影响。
// 为什么要改：以前这里硬编码 path.join(__dirname,'..','data')，忽略 SP_DATA_DIR →
// 沙箱里跑任何命中 auditLog 的测试，审计行都会追加进**真实**的 data/audit.log
// （业务集合不受影响，但真实日志被测试污染，也会让「日志行数」这类断言失去意义）。
const LOG_DIR = process.env.SP_DATA_DIR
  ? path.resolve(process.env.SP_DATA_DIR)
  : path.join(__dirname, '..', 'data');

function auditLog(message) {
  const line = `[${nowIso()}] ${message}\n`;
  const logFile = path.join(LOG_DIR, 'audit.log');
  try {
    if (fs.statSync(logFile).size > MAX_BYTES) fs.renameSync(logFile, logFile + '.1');
  } catch (e) { /* 文件还不存在，继续写即可 */ }
  try { fs.appendFileSync(logFile, line); } catch (e) { /* 日志不可写不应影响业务 */ }
}

/**
 * 读取审计日志（**只读**，供「审计日志」页使用）。
 *
 * 返回 [{ at, message }]，**按时间倒序**（最新在前）。
 *
 * ⚠️ 关于字段解析的重要说明：
 *   审计日志是历史累积的**自由文本**（`[ISO时间] 一段说明`），
 *   除了时间戳之外**没有结构化的「用户 / 操作 / 对象 / 结果」字段** ——
 *   每种事件的措辞都不一样（`login: admin`、`create manager: X for Y by Z`、
 *   `transaction: A redeem +10 by B`、`staff.assign rejected (self-target): …`…）。
 *   因此这里**只可靠解析时间戳**，其余原样返回 message。
 *   需要按内容筛选时由调用方对 message 做关键词匹配 ——
 *   不要在这里猜字段：猜错比不解析更糟（会给出误导性的「用户/结果」列）。
 *
 * 与本模块的写入共用同一个 LOG_DIR，所以沙箱（SP_DATA_DIR）下读到的
 * 也是沙箱日志，而不是真实 data/audit.log。
 */
function readAuditLog() {
  const logFile = path.join(LOG_DIR, 'audit.log');
  let raw = '';
  try { raw = fs.readFileSync(logFile, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const m = line.match(/^\[([^\]]+)\]\s?([\s\S]*)$/);
    if (m) out.push({ at: m[1], message: m[2] });
    else out.push({ at: null, message: line });   // 极少数非标准行也照原样给出，不丢数据
  }
  return out.reverse();
}

module.exports = { auditLog, readAuditLog, nowIso, LOG_DIR };
