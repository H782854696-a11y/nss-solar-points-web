// ============================================================
// P3 针对性测试：lib/audit.js 必须尊重 SP_DATA_DIR（沙箱隔离）
// ============================================================
// 修复前：lib/audit.js 硬编码 path.join(__dirname,'..','data','audit.log')，
//   忽略 SP_DATA_DIR → 任何命中 auditLog 的测试都会把审计行追加进**真实**的
//   data/audit.log（业务集合不受影响，但真实日志被测试污染）。
// 修复后：与 lib/store.js 同一约定 —— SP_DATA_DIR 优先，未设置时行为与原来完全一致。
//
// 本测试用「真实日志文件的 md5 + size」作为对照：跑完必须一字未改。
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.join(__dirname, '..');
const REAL_LOG = path.join(APP, 'data', 'audit.log');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const statOf = (f) => { try { const s = fs.statSync(f); return { size: s.size, mtime: s.mtimeMs }; } catch (e) { return { size: -1, mtime: -1 }; } };
const readOf = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
const md5 = (s) => require('crypto').createHash('md5').update(s == null ? '\u0000missing' : s).digest('hex');

console.log('\n══════ P3 审计日志沙箱隔离 针对性测试 ══════\n');

const realBefore = statOf(REAL_LOG);
const realBeforeMd5 = md5(readOf(REAL_LOG));
console.log('【前置】真实 data/audit.log 基线：size=' + realBefore.size + '  md5=' + realBeforeMd5);

// ── 在设置沙箱之后再 require，模块加载时就会锁定 LOG_DIR ──
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-p3-'));
process.env.SP_DATA_DIR = SANDBOX;

console.log('\n【1】设置 SP_DATA_DIR 后，审计写入必须落在沙箱');
const { auditLog } = require(APP + '/lib/audit');
const PROBE = 'P3 sandbox probe ' + Date.now();
auditLog(PROBE);
const sandboxLog = path.join(SANDBOX, 'audit.log');
ok('沙箱里生成了 audit.log', fs.existsSync(sandboxLog), sandboxLog);
const sandboxContent = readOf(sandboxLog) || '';
ok('沙箱日志里包含本次探测内容', sandboxContent.indexOf(PROBE) !== -1, sandboxContent.slice(0, 160));
ok('沙箱日志行格式正确（[ISO时间] 内容）', /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] P3 sandbox probe/.test(sandboxContent), sandboxContent.slice(0, 80));

console.log('\n【2】同时，真实 data/audit.log 必须**一字未改**');
const realAfter = statOf(REAL_LOG);
const realAfterMd5 = md5(readOf(REAL_LOG));
ok('★ 真实日志 size 未变', realAfter.size === realBefore.size, { before: realBefore.size, after: realAfter.size });
ok('★ 真实日志 md5 未变（逐字节一致）', realAfterMd5 === realBeforeMd5, { before: realBeforeMd5, after: realAfterMd5 });
ok('★ 真实日志里不含本次探测内容', (readOf(REAL_LOG) || '').indexOf(PROBE) === -1);

console.log('\n【3】默认分支（未设 SP_DATA_DIR）保持历史行为');
// 说明：这里用**源码断言**而不是真的去写 —— 实际写会污染真实日志（等于把要修的问题再犯一次）。
//   行为上已由【2】证明：设置沙箱时真实日志零变化；未设置时按同一表达式落回 <项目>/data。
const SRC = fs.readFileSync(APP + '/lib/audit.js', 'utf8');
ok('源码使用 process.env.SP_DATA_DIR 覆盖', SRC.indexOf('process.env.SP_DATA_DIR') !== -1);
ok('源码保留了与原来完全一致的兜底路径 <项目>/data',
  SRC.indexOf("path.join(__dirname, '..', 'data')") !== -1);
ok('与 lib/store.js 的 DATA_DIR 约定一致（都是 SP_DATA_DIR 优先）',
  fs.readFileSync(APP + '/lib/store.js', 'utf8').indexOf('process.env.SP_DATA_DIR') !== -1);
ok('不再存在硬编码的 path.join(__dirname, \'..\', \'data\', \'audit.log\') 直接拼接',
  SRC.indexOf("path.join(__dirname, '..', 'data', 'audit.log')") === -1);

console.log('\n【4】多次写入仍只落在沙箱（不串到真实）');
auditLog('P3 second probe');
const c2 = readOf(sandboxLog) || '';
ok('沙箱日志累加（两次都在）', c2.indexOf(PROBE) !== -1 && c2.indexOf('P3 second probe') !== -1);
ok('真实日志 size 依然未变', statOf(REAL_LOG).size === realBefore.size, statOf(REAL_LOG).size);

console.log(`\n══════ P3 测试 ${pass} passed, ${fail} failed ══════`);
if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
