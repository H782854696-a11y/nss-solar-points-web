#!/usr/bin/env node
// SQLite 存储迁移脚本
// ============================================================
// 用法：
//   node scripts/migrate-to-sqlite.js              正式迁移（备份 → 迁移 → 校验 → 切换）
//   node scripts/migrate-to-sqlite.js --dry-run    只迁移+校验，不写切换标记（应用仍走 JSON）
//   node scripts/migrate-to-sqlite.js --rollback   一键回滚到 JSON 模式
//
// 设计要点：
//   · 迁移只做「读 JSON → 写 SQLite」，**绝不修改或删除 JSON 文件**
//     → 因此回滚不需要「恢复数据」，只是「换回原来那条路」，天然无损。
//   · 校验不通过就中止，不写切换标记 —— 应用行为保持原样。
//   · 写切换标记（第 6 步）之前，应用完全感知不到这次迁移。
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 同样支持 SP_DATA_DIR 覆盖（自动化测试用沙箱目录跑迁移，不碰真实数据）
const DATA_DIR = process.env.SP_DATA_DIR
  ? path.resolve(process.env.SP_DATA_DIR)
  : path.join(ROOT, 'data');
const STORAGE_MARKER = path.join(DATA_DIR, '_storage.json');
const DB_FILE = path.join(DATA_DIR, 'solarpoints.db');

const store = require(path.join(ROOT, 'lib', 'store'));
const db = require(path.join(ROOT, 'lib', 'db'));
const { SCHEMAS } = store;

// ---------- 工具 ----------

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** 规范化：递归排序对象键，用于「比内容而不是比书写顺序」 */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}

function deepEqual(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function emptyFor(coll) {
  const s = SCHEMAS[coll];
  return (s && s.id === 'single') ? null : [];
}

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// ---------- 集合清单 ----------

/** 需要迁移的集合 = SCHEMAS 里声明的全部 + data/ 下实际存在的 .json（排除标记文件与 macOS 垃圾文件） */
function listCollections() {
  const set = new Set(Object.keys(SCHEMAS));
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.endsWith('.json')) continue;
      if (f === '_storage.json') continue;
      if (f.startsWith('._')) continue;           // macOS AppleDouble 垃圾文件
      if (f.includes('.corrupt-')) continue;      // 损坏留档
      set.add(f.slice(0, -5));
    }
  } catch (e) { /* data/ 不存在，SCHEMAS 已够 */ }
  return [...set].sort();
}

/** 读取一个集合的 JSON 原始值 */
function readJsonCollection(coll) {
  const file = path.join(DATA_DIR, coll + '.json');
  if (!fs.existsSync(file)) return { exists: false, value: emptyFor(coll) };
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return { exists: true, value: JSON.parse(raw) };
  } catch (e) {
    throw new Error(`集合 ${coll} 的 JSON 解析失败：${e.message}`);
  }
}

// ---------- 第 2 步：备份 ----------

function backupJson() {
  const dir = path.join(DATA_DIR, '_json-backup-' + nowStamp());
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith('.json') || f === '_storage.json') continue;
    const src = path.join(DATA_DIR, f);
    if (!fs.statSync(src).isFile()) continue;
    const dst = path.join(dir, f);
    fs.copyFileSync(src, dst);
    // 逐文件核对字节数
    const a = fs.statSync(src).size;
    const b = fs.statSync(dst).size;
    if (a !== b) throw new Error(`备份校验失败：${f} 源 ${a} 字节 / 副本 ${b} 字节`);
    copied.push({ file: f, bytes: b });
  }
  return { dir, copied };
}

// ---------- 第 5 步：校验 ----------

/** 从 SQLite 读回一个集合 */
function readSqliteCollection(coll) {
  return db.readCollection(coll);
}

/** 业务事实快照：迁移前后应当完全一致 */
function businessFacts(members, transactions) {
  const ms = Array.isArray(members) ? members : [];
  const ts = Array.isArray(transactions) ? transactions : [];
  const byMember = new Map();
  for (const t of ts) {
    if (!t || !t.memberId) continue;
    byMember.set(t.memberId, (byMember.get(t.memberId) || 0) + (Number(t.amount) || 0));
  }
  let ledgerMismatch = 0;
  for (const m of ms) {
    const sum = byMember.get(m.id) || 0;
    if (Math.abs((Number(m.points) || 0) - sum) > 1e-6) ledgerMismatch++;
  }
  return {
    memberCount: ms.length,
    storeCount: 0,
    txCount: ts.length,
    pointsTotal: ms.reduce((s, m) => s + (Number(m.points) || 0), 0),
    spendTotal: Math.round(ms.reduce((s, m) => s + (Number(m.spend) || 0), 0) * 100) / 100,
    earnedTotal: ms.reduce((s, m) => s + (Number(m.earnedTotal) || 0), 0),
    redeemedTotal: ms.reduce((s, m) => s + (Number(m.redeemedTotal) || 0), 0),
    ledgerMismatch,
  };
}

// ---------- 迁移主流程 ----------

function migrate({ dryRun = false, verbose = true } = {}) {
  const log = (...a) => { if (verbose) console.log(...a); };
  const report = { ok: false, dryRun, steps: [], collections: [], checks: [], facts: null };

  // ── 第 1 步：前置检查 ──
  const marker = store.readMarker();
  if (marker && marker.driver === 'sqlite') {
    throw new Error('当前已是 SQLite 模式（data/_storage.json 的 driver=sqlite）。如需重跑请先执行 --rollback。');
  }
  if (!fs.existsSync(DATA_DIR)) throw new Error('data/ 目录不存在');
  const probe = path.join(DATA_DIR, '.write-probe');
  try { fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); }
  catch (e) { throw new Error('data/ 目录不可写：' + e.message); }
  const collections = listCollections();
  log(`\n① 前置检查通过 —— 待迁移集合 ${collections.length} 个：`);
  log('   ' + collections.join(', '));
  report.steps.push({ step: 1, name: '前置检查', ok: true, detail: `${collections.length} 个集合` });

  // ── 第 2 步：自动备份 ──
  const backup = backupJson();
  log(`\n② 已自动备份 ${backup.copied.length} 个文件 → ${path.relative(ROOT, backup.dir)}`);
  log(`   合计 ${humanSize(backup.copied.reduce((s, c) => s + c.bytes, 0))}`);
  report.steps.push({ step: 2, name: '自动备份', ok: true, detail: path.basename(backup.dir), files: backup.copied.length });

  // ── 第 3 步：建库建表 ──
  db.ensureTables();
  log(`\n③ 已建表：${Object.keys(SCHEMAS).length} 张业务表 + _meta`);
  report.steps.push({ step: 3, name: '建库建表', ok: true, detail: `${Object.keys(SCHEMAS).length} + _meta` });

  // ── 第 4 步：逐集合迁移（单事务，任一失败整体回滚） ──
  const sources = new Map();
  const entries = [];
  for (const coll of collections) {
    const { exists, value } = readJsonCollection(coll);
    sources.set(coll, { exists, value });
    entries.push({ coll, data: value });
  }
  db.writeAllInTransaction(entries);
  log(`\n④ 已迁移 ${collections.length} 个集合（单事务提交）`);
  report.steps.push({ step: 4, name: '逐集合迁移', ok: true, detail: `${collections.length} 个集合` });

  // ── 第 5 步：逐项校验 ──
  log('\n⑤ 逐项校验');
  let allPass = true;
  for (const coll of collections) {
    const { exists, value } = sources.get(coll);
    const got = readSqliteCollection(coll);
    const equal = deepEqual(value, got);

    const srcCount = Array.isArray(value) ? value.length : (value === null ? 0 : 1);
    const gotCount = Array.isArray(got) ? got.length : (got === null ? 0 : 1);
    const countOk = srcCount === gotCount;

    // 数组顺序（deepEqual 已含顺序，这里单独再报一次便于阅读）
    const orderOk = Array.isArray(value) ? deepEqual(value.map(x => x && x.id), got.map(x => x && x.id)) : true;

    const pass = equal && countOk && orderOk;
    if (!pass) allPass = false;
    report.collections.push({
      coll, exists, srcCount, gotCount,
      deepEqual: equal, countOk, orderOk, pass,
    });
    const flag = pass ? '✅' : '❌';
    log(`   ${flag} ${coll.padEnd(16)} 条数 ${String(gotCount).padStart(4)}  深度一致 ${equal ? '是' : '否'}  顺序 ${Array.isArray(value) ? (orderOk ? '一致' : '不一致') : '—'}`);
  }

  // 业务事实核对（迁移前后必须一致）
  const srcMembers = sources.get('members') ? sources.get('members').value : [];
  const srcTx = sources.get('transactions') ? sources.get('transactions').value : [];
  const srcStores = sources.get('stores') ? sources.get('stores').value : [];
  const before = businessFacts(srcMembers, srcTx);
  before.storeCount = Array.isArray(srcStores) ? srcStores.length : 0;
  const after = businessFacts(readSqliteCollection('members'), readSqliteCollection('transactions'));
  after.storeCount = (readSqliteCollection('stores') || []).length;
  const factsOk = deepEqual(before, after);
  if (!factsOk) allPass = false;
  report.facts = { before, after, ok: factsOk };

  log('\n   业务事实核对：');
  log(`     会员数 ${after.memberCount} · 门店数 ${after.storeCount} · 流水数 ${after.txCount}`);
  log(`     积分余额合计 ${after.pointsTotal} · 累计消费合计 ₱${after.spendTotal}`);
  log(`     累计获得 ${after.earnedTotal} · 累计核销 ${after.redeemedTotal}`);
  log(`     ${factsOk ? '✅ 迁移前后完全一致' : '❌ 迁移前后不一致'}`);
  if (after.ledgerMismatch > 0) {
    log(`     ⚠ 注：有 ${after.ledgerMismatch} 位会员的「余额 ≠ 流水汇总」—— 这是迁移前就存在的数据状态，迁移未改变它（前后对比一致）`);
  }
  report.checks.push({ name: '逐集合深度一致', ok: allPass });
  report.steps.push({ step: 5, name: '逐项校验', ok: allPass });

  if (!allPass) {
    report.ok = false;
    report.aborted = true;
    log('\n❌ 校验未通过 —— 已中止，未写切换标记。应用行为保持不变。');
    return report;
  }

  // ── 第 6 步：写切换标记 ──
  if (dryRun) {
    log('\n⑥ --dry-run：跳过写切换标记（应用仍走 JSON 驱动）');
    report.steps.push({ step: 6, name: '切换标记', ok: true, detail: 'dry-run 跳过' });
  } else {
    const payload = {
      driver: 'sqlite',
      schemaVersion: db.SCHEMA_VERSION,
      migratedAt: new Date().toISOString(),
      jsonBackupDir: path.basename(backup.dir),
      note: '回滚：node scripts/migrate-to-sqlite.js --rollback',
    };
    const tmp = STORAGE_MARKER + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, STORAGE_MARKER);
    store.resetDriverCache();   // 同进程内后续读取立即按 sqlite 走（进程外仍需重启）
    log(`\n⑥ 已写入切换标记 → data/_storage.json（driver=sqlite）`);
    log('   ⚠ 需要重启进程（pm2 restart）才会生效');
    report.steps.push({ step: 6, name: '切换标记', ok: true, detail: 'driver=sqlite' });
  }

  report.ok = true;
  const size = db.dbFileSize();
  log(`\n⑦ 完成 —— 数据库文件 ${path.relative(ROOT, DB_FILE)}（${humanSize(size)}）`);
  report.steps.push({ step: 7, name: '输出报告', ok: true, detail: humanSize(size) });
  report.dbSize = size;
  report.backupDir = backup.dir;
  return report;
}

// ---------- 回滚 ----------

function rollback() {
  const marker = store.readMarker();
  const payload = Object.assign({}, marker || {}, {
    driver: 'json',
    rolledBackAt: new Date().toISOString(),
    note: '已回滚到 JSON 驱动。JSON 原始文件全程未被修改，回滚无损。',
  });
  const tmp = STORAGE_MARKER + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, STORAGE_MARKER);
  store.resetDriverCache();   // 同进程内后续读取立即按 json 走（进程外仍需重启）
  return {
    ok: true,
    markerPath: STORAGE_MARKER,
    dbFileKept: fs.existsSync(DB_FILE),
    message: '已回滚到 JSON 驱动。需重启进程生效（pm2 restart）。JSON 原始文件全程未被修改，回滚无损。',
  };
}

// ---------- CLI ----------

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const doRollback = args.includes('--rollback');

  if (doRollback) {
    console.log('\n══════ 回滚到 JSON 驱动 ══════\n');
    const r = rollback();
    console.log('  ✅ ' + r.message);
    console.log('  数据库文件保留：' + (r.dbFileKept ? 'data/solarpoints.db（未删除，可随时切回）' : '不存在'));
    console.log('\n══════ 回滚完成 ══════\n');
    return 0;
  }

  console.log('\n══════ SQLite 存储迁移 ══════');
  if (dryRun) console.log('（--dry-run 模式：不会写切换标记）');
  try {
    const r = migrate({ dryRun });
    if (r.ok) {
      console.log('\n══════ 迁移成功 ══════');
      if (!dryRun) console.log('下一步：重启进程让切换生效 —— pm2 restart solarpoints\n');
      return 0;
    }
    console.log('\n══════ 迁移未完成（校验未通过）══════\n');
    return 1;
  } catch (e) {
    console.error('\n❌ 迁移失败：' + e.message);
    console.error('   JSON 原始文件未被修改，系统仍可正常运行。\n');
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { migrate, rollback, listCollections, backupJson, canon, deepEqual, businessFacts, readJsonCollection };
