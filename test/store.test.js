// 存储层测试（JSON / SQLite 双驱动）
// ============================================================
// 为什么需要这个文件：
//   现有 5 个测试（lookup / reports / points-engine / approvals / mall）全是
//   **纯函数测试、fixture 内联**，根本不加载 lib/store.js。
//   所以「261 条全绿」只能证明业务逻辑没被改坏，**不能证明存储层是对的**。
//   本文件专门补上这一块。
//
// 测试隔离：全程在临时目录里跑（环境变量 SP_DATA_DIR），绝不碰 data/ 真实数据。
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠ 必须在 require store/db 之前设置，它们会在模块加载时读取该变量
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-store-test-'));
process.env.SP_DATA_DIR = SANDBOX;

const store = require('../lib/store');
const db = require('../lib/db');
const migrate = require('../scripts/migrate-to-sqlite');

const DATA_DIR = SANDBOX;
const MARKER = path.join(DATA_DIR, '_storage.json');
const { SCHEMAS } = store;

let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('    ✅ ' + name); }
  else { fail++; fails.push(name); console.log('    ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(name, actual, expected) {
  ok(`${name}（期望 ${JSON.stringify(expected)}）`, JSON.stringify(actual) === JSON.stringify(expected), actual);
}

/** 规范化深度比较（递归排序对象键，比内容不比书写顺序） */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {}; for (const k of Object.keys(v).sort()) o[k] = canon(v[k]); return o;
  }
  return v;
}
function deepEq(a, b) { return JSON.stringify(canon(a)) === JSON.stringify(canon(b)); }

/** 重置沙箱到指定驱动 */
function resetEnv(driver) {
  db.close();
  store.resetDriverCache();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (driver === 'sqlite') {
    fs.writeFileSync(MARKER, JSON.stringify({ driver: 'sqlite', schemaVersion: 1, migratedAt: new Date().toISOString() }));
  }
  store.resetDriverCache();
  if (driver === 'sqlite') db.ensureTables();
}

function makeMember(i, extra) {
  return Object.assign({
    id: 'm' + i,
    name: '会员' + i,
    phone: '0917 000 ' + String(1000 + i),
    type: i % 2 ? 'b2b' : 'retail',
    level: 'silver',
    points: i * 10,
    spend: i * 100.5,
    storeId: 's1',
    storeName: '马尼拉旗舰店',
    status: 'active',
    createdAt: '2026-09-21T00:00:0' + (i % 10) + '.000Z',
    updatedAt: '2026-09-21T00:00:0' + (i % 10) + '.000Z',
    notes: 'note-' + i,
    pointsExpireAt: null, lastEarnAt: null, lastPurchaseAt: null,
    earnedTotal: i * 10, redeemedTotal: 0,
  }, extra || {});
}

/* ============================================================
 * 15 项存储层测试（两个驱动各跑一遍）
 * ============================================================ */
function runSuite(driver) {
  const L = (s) => console.log(`\n  【${driver.toUpperCase()} 驱动】${s}`);
  resetEnv(driver);
  const isSqlite = driver === 'sqlite';

  // T1 数据库初始化
  L('T1 初始化');
  if (isSqlite) {
    db.ensureTables(); db.ensureTables();           // 幂等：跑两次不报错
    const need = Object.keys(SCHEMAS).concat(['_meta']);
    const missing = need.filter(c => !db.tableExists(c));
    ok('建表幂等且 11 张业务表 + _meta 全部存在', missing.length === 0, missing);
  } else {
    store.writeCollection('members', [makeMember(1)]);
    ok('数据目录可用且写入后可读', fs.existsSync(path.join(DATA_DIR, 'members.json')));
  }

  // T2 写入后读取
  L('T2 写入后读取');
  const one = makeMember(1);
  store.writeCollection('members', [one]);
  ok('单条写入后读回内容一致', deepEq(store.readCollection('members'), [one]));

  // T3 复杂对象往返
  L('T3 复杂对象往返');
  const complex = makeMember(2, { nested: { a: [1, 2, { b: '深' }], c: null }, flag: true, num: 1e15 });
  store.writeCollection('members', [complex]);
  ok('含嵌套/大数/布尔/null 的记录往返一致', deepEq(store.readCollection('members'), [complex]));

  // T4 数组顺序保持
  L('T4 数组顺序保持');
  const shuffled = [makeMember(9), makeMember(3), makeMember(7), makeMember(1), makeMember(5)];
  store.writeCollection('members', shuffled);
  const backIds = store.readCollection('members').map(m => m.id);
  eq('读回顺序与写入顺序完全一致', backIds, shuffled.map(m => m.id));

  // T5 单例集合
  L('T5 单例集合');
  eq('未写入的单例集合读回 null', store.readCollection('rules'), null);
  const rules = { spendPerPoint: 10, welcomeBonus: 500, levels: [{ key: 'silver', threshold: 0 }] };
  store.writeCollection('rules', rules);
  ok('单例写入后读回一致', deepEq(store.readCollection('rules'), rules));
  const rules2 = Object.assign({}, rules, { spendPerPoint: 20 });
  store.writeCollection('rules', rules2);
  eq('单例覆盖写入生效', store.readCollection('rules').spendPerPoint, 20);

  // T6 空集合
  L('T6 空集合');
  store.writeCollection('pending', []);
  ok('写入空数组后读回 [] 而不是 null', deepEq(store.readCollection('pending'), []));

  // T7 缺失集合
  L('T7 缺失集合');
  ok('未写过的已声明数组集合读回 []', deepEq(store.readCollection('redemptions'), []));
  ok('未写过的已声明单例集合读回 null', store.readCollection('expiry-state') === null);
  ok('未注册的集合名读回 [] 且不报错', deepEq(store.readCollection('not_declared_anywhere'), []));

  // T8 多次读写一致性
  L('T8 多次读写一致性');
  let consistent = true;
  for (let r = 1; r <= 10; r++) {
    const batch = [makeMember(r), makeMember(r + 100)];
    store.writeCollection('members', batch);
    const got = store.readCollection('members');
    if (!deepEq(got, batch)) { consistent = false; break; }
  }
  ok('连续 10 轮「写→读→覆盖写→读」结果始终一致', consistent);

  // T9 特殊字符
  L('T9 特殊字符');
  const tricky = [{
    id: 'x1', name: "O'Brien \"双引号\" 换行\n第二行", emoji: '🌞☀️', cjk: '中文测试',
    backslash: 'C:\\path\\to', nullv: null, emptystr: '', zero: 0, falsy: false,
    arr: [null, '', 0, false], deep: { a: { b: { c: '深嵌套' } } },
  }];
  store.writeCollection('transactions', tricky);
  ok('中文/emoji/引号/换行/反斜杠/null/空串/0/false 往返一致', deepEq(store.readCollection('transactions'), tricky));

  // T10 大数组
  L('T10 大数组（1000 条）');
  const big = []; for (let i = 0; i < 1000; i++) big.push(makeMember(i));
  const t0 = Date.now();
  store.writeCollection('members', big);
  const gotBig = store.readCollection('members');
  const cost = Date.now() - t0;
  ok(`1000 条写入+读回内容一致（${cost}ms）`, deepEq(gotBig, big));
  eq('读回条数正确', gotBig.length, 1000);

  // T11 未注册集合的兜底写入
  L('T11 未注册集合兜底');
  store.writeCollection('ad_hoc_collection', [{ id: 'a1' }, { id: 'a2' }]);
  ok('未注册集合也能正常读写（兜底为数组）', deepEq(store.readCollection('ad_hoc_collection'), [{ id: 'a1' }, { id: 'a2' }]));

  // T12 dataVersion：任何业务写入都必须变化（不限于 members/stores/transactions/rules）
  L('T12 dataVersion 覆盖全部业务集合');
  const bizCollections = Object.keys(SCHEMAS).filter(c => ['sheets', '_seeded', 'expiry-state'].indexOf(c) === -1);
  let allChanged = true; const notChanged = [];
  for (const coll of bizCollections) {
    const before = store.dataVersion();
    const data = (SCHEMAS[coll] && SCHEMAS[coll].id === 'single') ? { id: 'single', probe: Date.now() } : [{ id: 'probe-' + coll }];
    store.writeCollection(coll, data);
    const after = store.dataVersion();
    if (before === after) { allChanged = false; notChanged.push(coll); }
  }
  ok(`写入任意业务集合（共 ${bizCollections.length} 个：含 pending/products/redemptions）后 dataVersion 必变`, allChanged, notChanged);

  // T13 元数据集合不推进版本号（否则同步引擎会被自己的写入反复触发）
  L('T13 元数据集合不触发同步');
  let metaQuiet = true; const noisy = [];
  for (const coll of db.META_COLLECTIONS) {
    const before = store.dataVersion();
    const data = (SCHEMAS[coll] && SCHEMAS[coll].id === 'single') ? { id: 'single', probe: Date.now() } : [{ id: 'probe' }];
    store.writeCollection(coll, data);
    if (store.dataVersion() !== before) { metaQuiet = false; noisy.push(coll); }
  }
  ok(`写入元数据集合（${db.META_COLLECTIONS.join('/')}）不推进版本号 —— 防同步自我触发`, metaQuiet, noisy);

  // T14 写入失败不递增版本号
  L('T14 写入失败不递增');
  const vBefore = store.dataVersion();
  const dataBefore = store.readCollection('members');
  const circular = { id: 'bad' }; circular.self = circular;   // 无法序列化 → 必然抛错
  let threw = false;
  try { store.writeCollection('members', [circular]); } catch (e) { threw = true; }
  ok('写入无法序列化的数据会抛错', threw);
  eq('失败后 dataVersion 未变', store.dataVersion(), vBefore);
  ok('失败后原有数据完好无损', deepEq(store.readCollection('members'), dataBefore));

  // T15 事务回滚不留下错误递增
  L('T15 事务回滚不留下递增');
  if (isSqlite) {
    const v0 = db.dataVersion();
    const d = db.getDb();
    d.exec('BEGIN IMMEDIATE');
    db.bumpDataVersion('members', d);        // 事务内递增
    d.exec('ROLLBACK');                      // 然后回滚
    eq('事务内递增后回滚 → 版本号恢复原值', db.dataVersion(), v0);
    // 再验证一次整体回滚：写一半数据 + 递增，然后回滚
    const d2 = db.getDb();
    const v1 = db.dataVersion();
    d2.exec('BEGIN IMMEDIATE');
    d2.prepare('INSERT INTO "members" (_seq,id,_json) VALUES (?,?,?)').run(999, 'ghost', '{"id":"ghost"}');
    db.bumpDataVersion('members', d2);
    d2.exec('ROLLBACK');
    eq('回滚后版本号仍为原值', db.dataVersion(), v1);
    ok('回滚后「幽灵记录」未落库', !store.readCollection('members').some(m => m.id === 'ghost'));
  } else {
    const v0 = store.dataVersion();
    const data0 = store.readCollection('members');
    let threw2 = false;
    try { store.writeCollection('members', [circular]); } catch (e) { threw2 = true; }
    ok('写入失败会抛错（JSON 驱动的等价保证）', threw2);
    eq('失败后签名未变', store.dataVersion(), v0);
    ok('失败后原文件内容完好（未留下半写文件）', deepEq(store.readCollection('members'), data0));
    ok('失败后未遗留 .tmp 临时文件', fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.tmp')).length === 0,
      fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.tmp')));
  }
}

/* ============================================================
 * 迁移与等价性测试（与驱动无关，跑一遍）
 * ============================================================ */
function runMigrationSuite() {
  console.log('\n  【迁移 & 等价性】');
  resetEnv('json');

  // M1 两个驱动对同一份数据结果必须完全等价
  const fixtureMembers = [makeMember(1), makeMember(2), makeMember(3)];
  const fixtureRules = { spendPerPoint: 10, welcomeBonus: 500, levels: [{ key: 'silver', threshold: 0 }], b2bTiers: [] };
  store.writeCollection('members', fixtureMembers);
  store.writeCollection('rules', fixtureRules);
  const jsonMembers = store.readCollection('members');
  const jsonRules = store.readCollection('rules');

  fs.writeFileSync(MARKER, JSON.stringify({ driver: 'sqlite' }));
  db.close(); store.resetDriverCache(); db.ensureTables();
  store.writeCollection('members', fixtureMembers);
  store.writeCollection('rules', fixtureRules);
  const sqliteMembers = store.readCollection('members');
  const sqliteRules = store.readCollection('rules');
  ok('数组集合：SQLite 读回与 JSON 读回深度一致', deepEq(jsonMembers, sqliteMembers));
  ok('单例集合：SQLite 读回与 JSON 读回深度一致', deepEq(jsonRules, sqliteRules));

  // M2 损坏 JSON 留档且不覆盖（JSON 驱动行为）
  resetEnv('json');
  const badFile = path.join(DATA_DIR, 'corrupt_probe.json');
  fs.writeFileSync(badFile, '{ this is not valid json');
  const got = store.readCollection('corrupt_probe');       // 未注册 → 期望 []
  const quarantined = fs.readdirSync(DATA_DIR).filter(f => f.indexOf('corrupt_probe.json.corrupt-') === 0);
  ok('读取损坏文件不抛错，降级返回空值', deepEq(got, []));
  ok('损坏文件被改名留档（未被覆盖为空）', quarantined.length === 1, quarantined);

  // M3~M6 迁移脚本
  resetEnv('json');
  // 铺一份与生产同构的沙箱数据：11 个集合各写一次
  const names = Object.keys(SCHEMAS);
  for (const coll of names) {
    const single = SCHEMAS[coll] && SCHEMAS[coll].id === 'single';
    store.writeCollection(coll, single ? { id: 'single', probe: coll } : [{ id: 'x-' + coll, probe: coll }]);
  }
  const before = {};
  for (const coll of names) before[coll] = store.readCollection(coll);

  // M4 dry-run 不应写切换标记
  fs.writeFileSync(MARKER, JSON.stringify({ driver: 'json' }));
  store.resetDriverCache(); db.close();
  const dry = migrate.migrate({ dryRun: true, verbose: false });
  ok('dry-run 迁移校验通过', dry.ok && !dry.aborted);
  store.resetDriverCache();
  eq('dry-run 后驱动仍为 json（未写标记）', store.driver(), 'json');

  // M5 正式迁移
  const rm = migrate.migrate({ verbose: false });
  ok('正式迁移完成且校验通过', rm.ok && !rm.aborted);
  eq('11 个集合全部迁移（无遗漏）', rm.collections.length, names.length);
  ok('每个集合深度一致 + 条数一致 + 顺序一致',
    rm.collections.every(c => c.deepEqual && c.countOk && c.orderOk), rm.collections.filter(c => !c.pass));
  ok('业务事实迁移前后完全一致', rm.facts.ok, { before: rm.facts.before, after: rm.facts.after });
  eq('迁移后驱动为 sqlite', store.driver(), 'sqlite');

  // M6 迁移后数据与迁移前一致
  let allSame = true; const diff = [];
  for (const coll of names) {
    if (!deepEq(store.readCollection(coll), before[coll])) { allSame = false; diff.push(coll); }
  }
  ok('迁移后逐个集合读回与迁移前完全一致', allSame, diff);

  // M7 重复迁移保护
  let rejected = false, msg = '';
  try { migrate.migrate({ verbose: false }); } catch (e) { rejected = true; msg = e.message; }
  ok('已是 sqlite 模式时再次迁移被拒绝', rejected && /已是 SQLite 模式/.test(msg), msg);

  // M8 回滚
  const rb = migrate.rollback();
  ok('回滚成功', rb.ok);
  eq('回滚后驱动变回 json', store.driver(), 'json');
  let afterRb = true; const diff2 = [];
  for (const coll of names) {
    if (!deepEq(store.readCollection(coll), before[coll])) { afterRb = false; diff2.push(coll); }
  }
  ok('回滚后数据与迁移前完全一致（无损）', afterRb, diff2);
  const jsonIntact = names.every(coll => fs.existsSync(path.join(DATA_DIR, coll + '.json')));
  ok('回滚后 11 个 JSON 原始文件全部健在', jsonIntact);
}

/* ============================================================
 * 主流程
 * ============================================================ */
console.log('\n══════ 存储层测试（JSON / SQLite 双驱动）══════');
console.log('  沙箱目录: ' + SANDBOX);

for (const drv of ['json', 'sqlite']) {
  const p0 = pass, f0 = fail;
  runSuite(drv);
  console.log(`\n  ── ${drv.toUpperCase()} 驱动小结: ${pass - p0} passed, ${fail - f0} failed ──`);
}

runMigrationSuite();

console.log(`\n══════ 合计 ${pass} passed, ${fail} failed ══════`);
if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
console.log('');

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
