// SQLite 存储引擎（基于 Node 内置 node:sqlite，零新增依赖）
// ============================================================
// 本文件只负责「怎么把数据存进 SQLite」，不认识任何业务逻辑。
// 由 lib/store.js 注入集合结构（SCHEMAS），避免循环依赖。
//
// 设计方案（与 store.js 的 JSON 驱动完全等价）：
//   数组集合 → 一张表：(_seq, id, _json)
//     · _seq  保留原 JSON 数组的顺序（transactions 靠 unshift 保证最新在前，顺序有意义）
//     · _json 存完整原始记录（权威数据源，保证往返零丢失）
//   单例集合 → 一张表：(id, _json)，固定 id='singleton'
//   _meta    → 内部记账：schemaVersion / dataVersion / lastWrite:<集合>
//
// ⚠️ 关于 dataVersion（云同步的变更信号）
//   原则：**任何会影响云同步业务数据的成功写操作，都必须让 dataVersion 变化。**
//   实现上采用「排除法」而不是「列举法」——只排除元数据集合，其余全部计入。
//   这样将来新增 leads / tasks / alerts 等任意集合，都会自动被覆盖，
//   不会再出现「数据变了但版本没变」的静默问题。
//
//   被排除的元数据集合（写入它们不推进版本号）：
//     · sheets        —— 同步引擎自己的状态。若计入，同步写状态会触发下一次同步 → 死循环
//     · _seeded       —— 首次种子标记，内部记账
//     · expiry-state  —— 积分到期扫描状态，内部记账（真正变化的是 members/transactions，会正常计入）
//
//   原子性保证：版本号在事务内、写完数据之后、COMMIT 之前递增。
//     成功 → 一起提交；写入失败或事务回滚 → 版本号随之回滚，绝不留下错误递增。
// ============================================================

const fs = require('fs');
const path = require('path');

// 数据目录。可用环境变量 SP_DATA_DIR 覆盖（仅供自动化测试隔离使用；
// 生产环境不设置该变量 → 行为与之前完全一致）。
const DATA_DIR = process.env.SP_DATA_DIR
  ? path.resolve(process.env.SP_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'solarpoints.db');

/** 元数据集合：写入它们不推进 dataVersion（见文件头说明） */
const META_COLLECTIONS = ['sheets', '_seeded', 'expiry-state'];

/** 当前 schema 版本，将来改表结构时递增 */
const SCHEMA_VERSION = 1;

let schemas = null;   // 由 store.js 注入
let db = null;        // DatabaseSync 实例（惰性打开）

// ---------- 内部工具 ----------

function configure(injectedSchemas) {
  schemas = injectedSchemas || {};
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 惰性打开：JSON 模式下完全不碰 SQLite（连 require 都不发生） */
function getDb() {
  if (db) return db;
  ensureDataDir();
  // 惰性 require：避免 JSON 模式下也加载 node:sqlite（少一行 ExperimentalWarning）
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = DELETE');  // 单文件，不产生 -wal/-shm，备份脚本零改动
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** 集合名要拼进 SQL，做一次白名单校验，防注入/防拼错 */
function assertSafeName(coll) {
  if (typeof coll !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(coll)) {
    throw new Error(`[db] 非法集合名: ${JSON.stringify(coll)}`);
  }
  return coll;
}

function isSingleton(coll) {
  const s = schemas && schemas[coll];
  return !!(s && s.id === 'single');
}

/** 集合为空时的返回值：与 store.js 的 empty() 保持一致 */
function emptyFor(coll) {
  return isSingleton(coll) ? null : [];
}

function tableExists(coll) {
  assertSafeName(coll);
  const row = getDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(coll);
  return !!row;
}

/** 惰性建表（对应 JSON 驱动「读一个不存在的集合会自动创建该文件」的行为） */
function ensureTable(coll) {
  const d = getDb();
  assertSafeName(coll);
  if (isSingleton(coll)) {
    d.exec(`CREATE TABLE IF NOT EXISTS "${coll}" (id TEXT PRIMARY KEY, _json TEXT NOT NULL)`);
  } else {
    d.exec(`CREATE TABLE IF NOT EXISTS "${coll}" (_seq INTEGER NOT NULL, id TEXT PRIMARY KEY, _json TEXT NOT NULL)`);
    d.exec(`CREATE INDEX IF NOT EXISTS "idx_${coll}_seq" ON "${coll}"(_seq)`);
  }
}

/** 幂等建表：_meta + 全部集合 */
function ensureTables() {
  const d = getDb();
  d.exec(`CREATE TABLE IF NOT EXISTS "_meta" (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const coll of Object.keys(schemas || {})) ensureTable(coll);
  if (getMeta('schemaVersion') == null) setMeta('schemaVersion', String(SCHEMA_VERSION));
  if (getMeta('dataVersion') == null) setMeta('dataVersion', '0');
}

// ---------- _meta 读写 ----------

function getMeta(key) {
  const row = getDb().prepare(`SELECT value FROM "_meta" WHERE key = ?`).get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  getDb().prepare(`INSERT OR REPLACE INTO "_meta" (key, value) VALUES (?, ?)`).run(key, String(value));
}

// ---------- 数据版本号 ----------

/**
 * 在事务内推进版本号。必须在「数据已写入、尚未 COMMIT」时调用，
 * 这样写入失败/回滚时版本号会一起回滚。
 */
function bumpDataVersion(coll, d) {
  d = d || getDb();
  const now = new Date().toISOString();
  // 任何集合都记录最后写入时间（数据主库页要用）
  d.prepare(`INSERT OR REPLACE INTO "_meta" (key, value) VALUES (?, ?)`).run('lastWrite:' + coll, now);
  // 元数据集合不推进同步版本号
  if (META_COLLECTIONS.indexOf(coll) !== -1) return;
  const cur = Number(getMeta('dataVersion') || 0) || 0;
  d.prepare(`INSERT OR REPLACE INTO "_meta" (key, value) VALUES (?, ?)`).run('dataVersion', String(cur + 1));
}

function dataVersion() {
  return Number(getMeta('dataVersion') || 0) || 0;
}

/** 迁移完成后设定版本号初值（不需要逐个 +1） */
function setDataVersion(n) {
  setMeta('dataVersion', String(Number(n) || 0));
}

// ---------- 集合读写 ----------

function readCollection(coll) {
  assertSafeName(coll);
  const d = getDb();
  ensureTable(coll);
  if (isSingleton(coll)) {
    const row = d.prepare(`SELECT _json FROM "${coll}" WHERE id = ?`).get('singleton');
    return row ? JSON.parse(row._json) : null;   // 与 empty() 返回 null 一致
  }
  return d.prepare(`SELECT _json FROM "${coll}" ORDER BY _seq`).all().map(r => JSON.parse(r._json));
}

/** 只负责「把数据写进表」，不管理事务（由调用方决定事务边界） */
function applyWrite(coll, data, d) {
  if (isSingleton(coll)) {
    d.prepare(`INSERT OR REPLACE INTO "${coll}" (id, _json) VALUES (?, ?)`)
      .run('singleton', JSON.stringify(data === undefined ? null : data));
    return;
  }
  d.exec(`DELETE FROM "${coll}"`);
  const ins = d.prepare(`INSERT INTO "${coll}" (_seq, id, _json) VALUES (?, ?, ?)`);
  const arr = Array.isArray(data) ? data : [];
  for (let i = 0; i < arr.length; i++) {
    const rec = arr[i];
    const rawId = rec && rec.id != null ? String(rec.id) : '';
    ins.run(i, rawId !== '' ? rawId : `__seq_${i}`, JSON.stringify(rec));
  }
}

function writeCollection(coll, data) {
  assertSafeName(coll);
  const d = getDb();
  ensureTable(coll);

  d.exec('BEGIN IMMEDIATE');
  try {
    applyWrite(coll, data, d);
    bumpDataVersion(coll, d);   // 成功路径才递增；异常会随 ROLLBACK 一起撤销
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (e2) { /* 已回滚 */ }
    throw e;
  }
}

/**
 * 在**同一个事务**里写入多个集合（迁移脚本专用）。
 * 任一集合失败则整体回滚 —— 不会留下「迁移了一半」的中间状态。
 */
function writeAllInTransaction(entries) {
  const d = getDb();
  const list = Array.isArray(entries) ? entries : [];
  for (const e of list) { assertSafeName(e.coll); ensureTable(e.coll); }

  d.exec('BEGIN IMMEDIATE');
  try {
    for (const e of list) {
      applyWrite(e.coll, e.data, d);
      bumpDataVersion(e.coll, d);
    }
    d.exec('COMMIT');
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch (e2) { /* 已回滚 */ }
    throw err;
  }
}

// ---------- 统计（供「数据主库」页显示真实状态） ----------

function stats(coll) {
  assertSafeName(coll);
  const d = getDb();
  if (!tableExists(coll)) return { size: 0, updatedAt: null };
  const updatedAt = getMeta('lastWrite:' + coll) || null;
  if (isSingleton(coll)) {
    const row = d.prepare(`SELECT _json FROM "${coll}" WHERE id = ?`).get('singleton');
    const size = row ? Buffer.byteLength(row._json, 'utf8') : 0;
    return { size, updatedAt };
  }
  const r = d.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(_json AS BLOB))), 0) AS bytes FROM "${coll}"`
  ).get();
  return { size: Number(r.bytes) || 0, updatedAt };
}

// ---------- 文件信息 ----------

function dbFilePath() { return DB_FILE; }

function dbFileSize() {
  try { return fs.statSync(DB_FILE).size; } catch (e) { return 0; }
}

function close() {
  if (db) { try { db.close(); } catch (e) {} db = null; }
}

module.exports = {
  configure,
  getDb,
  ensureTables,
  readCollection,
  writeCollection,
  writeAllInTransaction,
  dataVersion,
  setDataVersion,
  bumpDataVersion,
  stats,
  getMeta,
  setMeta,
  isSingleton,
  tableExists,
  ensureTable,
  dbFilePath,
  dbFileSize,
  close,
  META_COLLECTIONS,
  SCHEMA_VERSION,
  DB_FILE,
};
