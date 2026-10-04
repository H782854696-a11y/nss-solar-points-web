// ============================================================
// P4 针对性测试：审计日志页（只读）
// ============================================================
// 覆盖用户要求的 8 条验证：
//   1 有权限用户可以读取审计日志
//   2 无权限用户访问 API 被拒绝（403）
//   3 无权限用户不显示审计日志入口（前端静态断言）
//   4 分页/筛选不会造成越权
//   5 不修改任何业务 collection
//   6 真实 data/audit.log MD5 保持不变
//   7 现有全部测试继续通过（由全量回归覆盖，本文件只做 P4 专项）
//   8 报告测试文件数/断言数/失败数
//
// 全部走 SP_DATA_DIR 沙箱；绝不触碰真实 data/。
//
// ⚠ 本文件的一个关键写法（上一版踩过）：**登录一次，之后复用 cookie**。
//   因为「登录」本身会写审计行（`login: xxx`），若每次请求前都重新登录，
//   审计日志会持续增长，导致 total/分页/「读取不写日志」等断言全部失真。
// ============================================================
process.env.PORT = '3195';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-p4-'));
process.env.SP_DATA_DIR = SANDBOX;

const APP = path.join(__dirname, '..');
const store = require(APP + '/lib/store');
const bcrypt = require(APP + '/node_modules/bcryptjs');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const PW = 'Test#12345';

// 真实 audit.log（绝不能被动到）
const REAL_LOG = path.join(APP, 'data', 'audit.log');
const realStat = () => { try { return { md5: md5(fs.readFileSync(REAL_LOG, 'utf8')), size: fs.statSync(REAL_LOG).size }; } catch (e) { return { md5: null, size: -1 }; } };
const realBefore = realStat();

const SANDBOX_LOG = path.join(SANDBOX, 'audit.log');
const sandboxLines = () => { try { return fs.readFileSync(SANDBOX_LOG, 'utf8').split('\n').filter(Boolean).length; } catch (e) { return 0; } };

const BUSINESS = ['users', 'stores', 'members', 'transactions', 'pending', 'products', 'redemptions', 'rules'];
const fingerprintAll = () => {
  const out = {};
  for (const c of BUSINESS) {
    const rows = store.readCollection(c) || [];
    const arr = Array.isArray(rows) ? rows : [rows];
    out[c] = md5(arr.map(x => JSON.stringify(x)).join('\n'));
  }
  return out;
};

function seed() {
  store.writeCollection('stores', [
    { id: 'S1', name: '一号店', regionId: 'R-A', city: '', address: '', managerId: 'U-mgr1', managerName: '一号店长', phone: '', createdAt: now() },
  ]);
  const mkUser = (id, username, name, role, extra) => Object.assign({
    id, username, password: bcrypt.hashSync(PW, 10), name, role,
    storeId: null, phone: '', createdAt: now(), disabled: false,
  }, extra || {});
  store.writeCollection('users', [
    mkUser('U-admin', 't_admin', '管理员', 'admin'),
    mkUser('U-mgr1', 't_mgr1', '一号店长', 'manager', { storeId: 'S1' }),
    mkUser('U-hq', 't_hq', '总部运营', 'hq_operator'),
  ]);
  store.writeCollection('members', []);
  store.writeCollection('transactions', []);
  store.writeCollection('pending', []);
  store.writeCollection('products', []);
  store.writeCollection('redemptions', []);
  store.writeCollection('rules', {
    id: 'single', spendPerPoint: 10, expiryMonths: 24, welcomeBonus: 0,
    redeemRatio: '10:1', redeemMaxPercent: 0, redeemMinPoints: 0,
    requireConfirm: false, realtimePush: false,
    levels: [{ key: 'silver', name: 'Silver', threshold: 0, color: '#9CA3AF' }],
    b2bTiers: [], updatedAt: now(), schemaVersion: 4,
  });
  store.writeCollection('sheets', { id: 'single', autoSync: false, syncCount: 0 });
  store.writeCollection('expiry-state', { lastRunAt: now(), expiryMonths: 24, expiredMembers: 0, expiredPoints: 0, dryRun: false, nextRunAt: now(), note: '' });
  store.writeCollection('_seeded', { id: 'singleton', at: now() });
}
seed();
require(APP + '/server.js');

const B = 'http://127.0.0.1:3195';

// ── 登录一次，之后一律复用 cookie（见文件头说明）──
const cookies = {};
async function loginAs(username) {
  const r = await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PW }),
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  cookies[username] = sc.map(c => c.split(';')[0]).join('; ');
  return r.status;
}
/** 以某用户身份 GET（不重新登录） */
async function as(username, p) {
  const r = await fetch(B + p, { headers: { cookie: cookies[username] || '' } });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, data: j };
}
/** 未带任何 cookie */
async function anon(p) {
  const r = await fetch(B + p);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, data: j };
}

(async () => {
  await sleep(800);
  console.log('\n══════ P4 审计日志页 针对性测试 ══════\n');

  // 制造审计记录：3 个账号各登录一次 = 3 行（写在沙箱，顺带验证 P3）
  await loginAs('t_admin');
  await loginAs('t_mgr1');
  await loginAs('t_hq');

  console.log('【前置】沙箱审计日志由 API 调用产生');
  const seeded = sandboxLines();
  ok('沙箱 audit.log 已有记录（说明 P3 生效：写的是沙箱不是真实日志）', seeded === 3, seeded);
  ok('沙箱日志位于 SP_DATA_DIR 内', SANDBOX_LOG.indexOf(SANDBOX) === 0, SANDBOX_LOG);

  const fpBefore = fingerprintAll();

  // ─────────────────────────────────────────
  console.log('\n【1】有权限用户（admin）可以读取审计日志');
  const a = await as('t_admin', '/api/audit-log?page=1&pageSize=50');
  ok('GET /api/audit-log → 200', a.status === 200, a.status);
  ok('返回 items 是结构化对象数组 {at, message}',
    Array.isArray(a.data.items) && a.data.items.length > 0 &&
    typeof a.data.items[0].at === 'string' && typeof a.data.items[0].message === 'string',
    (a.data.items || []).slice(0, 2));
  ok('包含 total / page / pageSize / pages',
    ['total', 'page', 'pageSize', 'pages'].every(k => a.data[k] !== undefined), Object.keys(a.data));
  ok('total 与沙箱日志行数一致', a.data.total === seeded, { total: a.data.total, seeded });
  ok('时间戳可解析（ISO）', !isNaN(new Date(a.data.items[0].at).getTime()), a.data.items[0].at);
  ok('按时间倒序（最新在前）: first.at >= last.at',
    a.data.items.length < 2 || a.data.items[0].at >= a.data.items[a.data.items.length - 1].at);
  ok('能读到 login 事件（内容含账号名）',
    a.data.items.every(x => /login/.test(x.message)), a.data.items.map(x => x.message));

  // ─────────────────────────────────────────
  console.log('\n【2】无权限用户访问 API 被拒绝（不得返回任何日志数据）');
  const mgr = await as('t_mgr1', '/api/audit-log');
  ok('store_manager → 403', mgr.status === 403, mgr.status);
  ok('403 响应体不含任何日志内容', JSON.stringify(mgr.data).indexOf('login') === -1, mgr.data);
  const hq = await as('t_hq', '/api/audit-log');
  ok('hq_operator → 403（没有任何 system.* 权限）', hq.status === 403, hq.status);
  const anonR = await anon('/api/audit-log');
  ok('未登录 → 401', anonR.status === 401, anonR.status);
  ok('401 响应体不含任何日志内容', JSON.stringify(anonR.data).indexOf('login') === -1, anonR.data);

  // ─────────────────────────────────────────
  console.log('\n【4】分页 / 筛选不会造成越权，且分页本身正确');
  ok('无权限用户带 pageSize=10000 → 仍 403（参数不能提权）',
    (await as('t_mgr1', '/api/audit-log?page=1&pageSize=10000&q=')).status === 403);
  ok('无权限用户带 q 筛选 → 仍 403', (await as('t_mgr1', '/api/audit-log?page=1&pageSize=1&q=login')).status === 403);

  const p1 = await as('t_admin', '/api/audit-log?page=1&pageSize=2');
  const p2 = await as('t_admin', '/api/audit-log?page=2&pageSize=2');
  ok('pageSize=2 第 1 页返回 2 条', p1.data.items.length === 2, p1.data.items.length);
  ok('第 1 页与第 2 页内容不重叠',
    !p1.data.items.some(x => p2.data.items.some(y => y.at === x.at && y.message === x.message)),
    { p1: p1.data.items.map(x => x.at), p2: p2.data.items.map(x => x.at) });
  ok('两页 total 相同且等于总行数（不随页码变）',
    p1.data.total === p2.data.total && p1.data.total === seeded, { p1: p1.data.total, p2: p2.data.total, seeded });
  const big = await as('t_admin', '/api/audit-log?page=1&pageSize=99999');
  ok('pageSize 被钳制到上限 200', big.data.pageSize === 200, big.data.pageSize);
  const badPage = await as('t_admin', '/api/audit-log?page=999&pageSize=50');
  ok('越界页返回空 items，但 total 不变',
    badPage.data.items.length === 0 && badPage.data.total === seeded, { items: badPage.data.items.length, total: badPage.data.total });
  const neg = await as('t_admin', '/api/audit-log?page=-5&pageSize=abc');
  ok('非法 page/pageSize 不报错（回落默认值）', neg.status === 200 && neg.data.page === 1, neg.data);
  const inj = await as('t_admin', '/api/audit-log?q=' + encodeURIComponent("' OR 1=1 --"));
  ok('可疑查询串不报错、也不会返回全量（只是普通关键词匹配）',
    inj.status === 200 && inj.data.total === 0, { status: inj.status, total: inj.data.total });
  const q1 = await as('t_admin', '/api/audit-log?q=login');
  ok('关键词筛选只返回匹配项', q1.data.items.every(x => x.message.indexOf('login') !== -1), q1.data.items.map(x => x.message));
  ok('筛选后 total = 匹配总数（<= 全量）',
    q1.data.total === seeded && q1.data.total <= seeded, { filteredTotal: q1.data.total, seeded });
  const qNone = await as('t_admin', '/api/audit-log?q=__no_such_keyword__');
  ok('无匹配关键词返回空列表且 total=0', qNone.data.items.length === 0 && qNone.data.total === 0, qNone.data);

  // ─────────────────────────────────────────
  console.log('\n【只读保证】读日志不产生任何写入');
  const sandboxBefore5 = fs.readFileSync(SANDBOX_LOG, 'utf8');
  const linesBeforeRead = sandboxLines();
  for (let i = 0; i < 5; i++) await as('t_admin', '/api/audit-log?page=' + (i + 1) + '&pageSize=10');
  ok('连续 5 次读取后，沙箱审计日志行数未增加（读取不写审计）',
    sandboxLines() === linesBeforeRead, { before: linesBeforeRead, after: sandboxLines() });
  ok('沙箱日志内容逐字节未变', fs.readFileSync(SANDBOX_LOG, 'utf8') === sandboxBefore5);

  console.log('\n【5】不修改任何业务 collection');
  const fpAfter = fingerprintAll();
  BUSINESS.forEach(c => ok(c.padEnd(13) + ' 指纹未变', fpAfter[c] === fpBefore[c], { before: fpBefore[c], after: fpAfter[c] }));
  ok('业务集合行数未变（members/transactions/pending/products/redemptions 仍为空）',
    ['members', 'transactions', 'pending', 'products', 'redemptions'].every(c => {
      const r = store.readCollection(c); return Array.isArray(r) ? r.length === 0 : true;
    }));

  console.log('\n【只读保证】代码层：审计相关只有 GET，没有任何写/删路径');
  const APPJS = fs.readFileSync(path.join(APP, 'public', 'app.js'), 'utf8');
  const SRV = fs.readFileSync(APP + '/server.js', 'utf8');
  const AUDITLIB = fs.readFileSync(APP + '/lib/audit.js', 'utf8');
  const fnBody = (() => {
    const i = APPJS.indexOf('async function renderAudit(root)');
    if (i < 0) return '';
    const rest = APPJS.slice(i);
    const m = rest.slice(1).search(/\nfunction |\nasync function /);
    return m < 0 ? rest : rest.slice(0, m + 1);
  })();
  ok('renderAudit 已定义', fnBody.length > 0);
  ok('renderAudit 只用 GET（不出现 POST/PUT/DELETE/PATCH）', !/\b(POST|PUT|DELETE|PATCH)\(/.test(fnBody));
  // ⚠ 统计「请求了哪些接口」时必须先剔除注释：注释里提到别的接口名不算请求
  //   （2026-09-24 踩过：renderAudit 与下一个函数之间的注释里出现了 /api/xxx，导致误报）
  const noComment = fnBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('renderAudit 只请求 /api/audit-log', noComment.indexOf('/api/audit-log') !== -1 &&
    (noComment.match(/\/api\//g) || []).length === (noComment.match(/\/api\/audit-log/g) || []).length,
    (noComment.match(/\/api\/[a-z\-]*/g) || []));
  ok('审计接口只有 GET：不存在 app.(post|put|delete|patch)(\'/api/audit…',
    !/app\.(post|put|delete|patch)\('\/api\/audit/.test(SRV));
  ok('lib/audit.js 不包含 writeFile / unlink / truncate / rmSync（只有 append 写入）',
    !/\b(writeFile|writeFileSync|unlink|unlinkSync|truncate|truncateSync|rmSync)\b/.test(AUDITLIB));
  ok('lib/audit.js 的写入路径只有 appendFileSync',
    (AUDITLIB.match(/appendFileSync/g) || []).length === 1);
  ok('SCREEN_PERMS 登记了 audit → system.audit.view', /audit:\s*'system\.audit\.view'/.test(APPJS));
  ok('renderScreen 分发里有 audit 分支', /state\.screen === 'audit'\)\s*await renderAudit/.test(APPJS));
  ok('导航项 data-screen="audit" 存在（显隐由 SCREEN_PERMS 统一控制）',
    fs.readFileSync(path.join(APP, 'public', 'index.html'), 'utf8').indexOf('data-screen="audit"') !== -1);
  ok('前端没有把 audit 页暴露给非 admin：SCREEN_PERMS 用的就是只授给 admin 的那个权限',
    /audit:\s*'system\.audit\.view'/.test(APPJS) &&
    require(APP + '/lib/rbac').ROLES.filter(r => require(APP + '/lib/rbac').hasPermission({ role: r }, 'system.audit.view')).join(',') === 'admin',
    require(APP + '/lib/rbac').ROLES.filter(r => require(APP + '/lib/rbac').hasPermission({ role: r }, 'system.audit.view')));

  console.log('\n【运行时校验】i18n key 与依赖符号都存在（避免页面上出现裸 key / ReferenceError）');
  const I18N = fs.readFileSync(path.join(APP, 'public', 'i18n.js'), 'utf8');
  const i18nKeys = new Set((I18N.match(/^\s*'([a-zA-Z][a-zA-Z0-9_.]*)':\s*\[/gm) || [])
    .map(s => s.trim().replace(/^'/, '').replace(/':\s*\[$/, '')));
  const usedKeys = Array.from(new Set((fnBody.match(/t\('([a-zA-Z][a-zA-Z0-9_.]*)'/g) || [])
    .map(s => s.replace(/^t\('/, '').replace(/'$/, ''))));
  const missingKeys = usedKeys.filter(k => !i18nKeys.has(k));
  ok('renderAudit 用到的 i18n key 共 ' + usedKeys.length + ' 个，全部存在于字典',
    missingKeys.length === 0, missingKeys);
  ok('i18n 字典里已登记 nav.audit 与 audit.* 共 8 个 key',
    ['nav.audit', 'audit.title', 'audit.subtitle', 'audit.searchPh', 'audit.summary',
      'audit.readonly', 'audit.empty', 'audit.emptyFiltered'].every(k => i18nKeys.has(k)),
    ['nav.audit', 'audit.title', 'audit.subtitle', 'audit.searchPh', 'audit.summary',
      'audit.readonly', 'audit.empty', 'audit.emptyFiltered'].filter(k => !i18nKeys.has(k)));
  const deps = ['state', 'GET', 'fmt', 'escapeHtml', 't', 'locale', 'renderPagerPages', 'renderScreen'];
  // t / locale 由 public/i18n.js 提供，app.js 顶部 `const { t, …, locale } = I18N;` 解构而来
  const i18nImport = (APPJS.match(/const \{([^}]*)\} = I18N;/) || [])[1] || '';
  const i18nProvided = new Set(i18nImport.split(',').map(s => s.trim()).filter(Boolean));
  const missingDeps = deps.filter(d =>
    !new RegExp('(function |const |let |var )' + d + '\\b').test(APPJS) && !i18nProvided.has(d));
  ok('renderAudit 依赖的符号都已定义（' + deps.join(', ') + '）', missingDeps.length === 0,
    { missing: missingDeps, 由I18N提供: Array.from(i18nProvided) });
  ok('index.html 引用了新版本 app.js（v>=35）',
    Number((fs.readFileSync(path.join(APP, 'public', 'index.html'), 'utf8').match(/app\.js\?v=(\d+)/) || [])[1]) >= 35);

  console.log('\n【6】真实 data/audit.log MD5 保持不变');
  const realAfter = realStat();
  ok('★ 真实 audit.log 逐字节未变', realAfter.md5 === realBefore.md5, { before: realBefore, after: realAfter });
  ok('★ 真实 audit.log size 未变', realAfter.size === realBefore.size, { before: realBefore.size, after: realAfter.size });

  console.log(`\n══════ P4 测试 ${pass} passed, ${fail} failed ══════`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.stack); try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e2) {} process.exit(2); });
