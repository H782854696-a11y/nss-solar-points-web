// 操作审计日志：追加写入 data/audit.log
const fs = require('fs');
const path = require('path');

function nowIso() { return new Date().toISOString(); }

// 超过 2MB 归档，保留 7 代（audit.log.1 ~ audit.log.7）轮转。
// 2026-10-08 审计 M-4：原只保留一代，追溯窗口太短；7 代 ≈ 16MB 文本。
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_GENERATIONS = 7;

// 数据目录。与 lib/store.js 保持同一约定：可用 SP_DATA_DIR 覆盖（仅自动化测试隔离用）。
// 未设置时行为与历史实现完全一致（<项目>/data/audit.log），生产不受影响。
// 为什么要改：以前这里硬编码 path.join(__dirname,'..','data')，忽略 SP_DATA_DIR →
// 沙箱里跑任何命中 auditLog 的测试，审计行都会追加进**真实**的 data/audit.log
// （业务集合不受影响，但真实日志被测试污染，也会让「日志行数」这类断言失去意义）。
const LOG_DIR = process.env.SP_DATA_DIR
  ? path.resolve(process.env.SP_DATA_DIR)
  : path.join(__dirname, '..', 'data');

function auditLog(message) {
  // A deployment validation process may read the shared data directory, but it
  // must never append or rotate audit files. Normal application auditing is
  // unchanged because this flag is only set for the temporary read-only mode.
  if (process.env.SP_DEPLOY_READ_ONLY === '1') return;
  const line = `[${nowIso()}] ${message}\n`;
  const logFile = path.join(LOG_DIR, 'audit.log');
  try {
    if (fs.statSync(logFile).size > MAX_BYTES) {
      // 滚动：最老的 .7 丢弃，.6→.7、.5→.6 … .1→.2，当前→.1
      for (let i = MAX_GENERATIONS; i >= 1; i--) {
        const old = i === 1 ? logFile : `${logFile}.${i - 1}`;
        const neu = `${logFile}.${i}`;
        try { fs.renameSync(old, neu); } catch (e) { /* 该代不存在则跳过 */ }
      }
    }
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
