// 第五批迁移（账号列表 / 报表总览 / 数据主库 / 审计日志）的 API 权限测试
// ============================================================
// 沙箱实例，绝不碰真实 data/。
// 重点（按用户要求）：
//   · 不只验证「有没有 checkPerm」，还要验证**实际返回的数据是否真的经过 scope 过滤**
//   · 系统级能力（system.* / db.*）保持 global 语义，不假装资源隔离
//   · 参数伪造不能改变授权结果
// ============================================================
process.env.PORT = '3171';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rbac-b5-'));
process.env.SP_DATA_DIR = SANDBOX;

const APP = path.join(__dirname, '..');
const store = require(APP + '/lib/store');
const rbac = require(APP + '/lib/rbac');
const bcrypt = require(APP + '/node_modules/bcryptjs');

// ── 测试专用「区域范围」探针角色 ──────────────────────────────
// 2026-09-22 组织架构调整后，生产矩阵里已不再有任何角色使用 region 范围
// （regional_manager 提升为 philippines，全国只保留 1 名负责人）。
// 本文件要验证「实际返回的数据是否真的经过 scope 过滤」，其中 region 档
// 依然保留在 rbac-guard.filterList 里，仍需回归覆盖 ——
// 故注入探针角色：权限集合与生产 regional_manager 完全一致，仅把范围换成 region。
const REGION_ROLE = '__probe_region_b5__';
rbac.ROLE_GRANTS[REGION_ROLE] = rbac.ROLE_GRANTS.regional_manager.map(g => ({ p: g.p, s: 'region' }));

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();

function seed() {
  // 两家门店分属两个区域，用于验证 region scope
  store.writeCollection('stores', [
    { id: 'SA', name: 'A区一号店', regionId: 'R-A', city: '', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
    { id: 'SB', name: 'B区一号店', regionId: 'R-B', city: '', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
  ]);
  const mkUser = (id, username, pw, name, role, extra) => Object.assign({
    id, username, password: bcrypt.hashSync(pw, 10), name, role,
    storeId: null, phone: '', createdAt: now(), disabled: false,
  }, extra || {});
  store.writeCollection('users', [
    mkUser('UA', 't_admin', 'Admin#123', '管理员', 'admin'),
    mkUser('UO', 't_owner', 'Owner#123', '老板', 'owner'),
    mkUser('UH', 't_hq', 'Hq#123456', '总部运营', 'hq_operator'),
    mkUser('UP', 't_ph', 'Ph#123456', '菲律宾负责人', 'philippines_manager'),
    mkUser('UR', 't_regA', 'Reg#12345', 'A区负责人', REGION_ROLE, { regionId: 'R-A' }),
    mkUser('UM', 't_mgrA', 'Mgr#12345', 'A区店长', 'manager', { storeId: 'SA' }),
    mkUser('UN', 't_mgrB', 'Mgr#12345', 'B区店长', 'store_manager', { storeId: 'SB' }),
    mkUser('US', 't_sales', 'Sales#123', '销售', 'sales', { storeId: 'SA' }),
    mkUser('UW', 't_wh', 'Wh#123456', '仓库', 'warehouse', { storeId: 'SA' }),
    mkUser('UV', 't_svc', 'Svc#12345', '售后', 'service', { storeId: 'SA' }),
    mkUser('UX', 't_ghost', 'Ghost#123', '未知角色', 'ghost_of_role'),
  ]);
  const mkMem = (id, name, phone, storeId, points, spend) => ({
    id, name, phone, type: 'retail', level: 'silver', points, spend,
    storeId, storeName: storeId === 'SA' ? 'A区一号店' : 'B区一号店', status: 'active',
    createdAt: now(), updatedAt: now(), notes: '', pointsExpireAt: null,
    lastEarnAt: null, lastPurchaseAt: null, earnedTotal: points, redeemedTotal: 0,
  });
  store.writeCollection('members', [
    mkMem('MA1', 'A区会员一', '09170000001', 'SA', 100, 1000),
    mkMem('MA2', 'A区会员二', '09170000002', 'SA', 200, 2000),
    mkMem('MB1', 'B区会员一', '09170000003', 'SB', 400, 4000),
    mkMem('MB2', 'B区会员二', '09170000004', 'SB', 800, 8000),
  ]);
  const mkTx = (id, memberId, memberName, storeId, amount) => ({
    id, memberId, memberName, type: 'earn', amount,
    reason: 'test', storeId, storeName: storeId === 'SA' ? 'A区一号店' : 'B区一号店',
    operatorId: 'UA', operatorName: '管理员', createdAt: now(),
    purchaseAmount: amount * 10, basePoints: amount, balanceAfter: amount,
  });
  store.writeCollection('transactions', [
    mkTx('TA1', 'MA1', 'A区会员一', 'SA', 100),
    mkTx('TB1', 'MB1', 'B区会员一', 'SB', 400),
  ]);
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
  store.writeCollection('_seeded', { id: 'singleton', at: now() });
}

const B = 'http://127.0.0.1:3171';
let cookie = '';
async function req(method, p, body) {
  const o = { method, headers: {} };
  if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  if (cookie) o.headers.cookie = cookie;
  const r = await fetch(B + p, o);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, data: j };
}
async function login(u, pw) {
  cookie = '';
  const r = await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: pw }),
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  cookie = sc.map(c => c.split(';')[0]).join('; ');
  return r.status;
}
const USERS = {
  admin: ['t_admin', 'Admin#123'], owner: ['t_owner', 'Owner#123'], hq: ['t_hq', 'Hq#123456'],
  ph: ['t_ph', 'Ph#123456'], regA: ['t_regA', 'Reg#12345'], mgrA: ['t_mgrA', 'Mgr#12345'],
  mgrB: ['t_mgrB', 'Mgr#12345'], sales: ['t_sales', 'Sales#123'], wh: ['t_wh', 'Wh#123456'],
  svc: ['t_svc', 'Svc#12345'], ghost: ['t_ghost', 'Ghost#123'],
};

(async () => {
  seed();
  require(APP + '/server.js');
  await sleep(1000);
  console.log('\n══════ 第五批迁移 API 权限测试 ══════\n');

  // ═══════════ 一、账号列表 ═══════════
  console.log('【一】账号列表 GET /api/users（system.user.view，admin only）');
  const userRows = [];
  for (const [k, [u, p]] of Object.entries(USERS)) {
    await login(u, p);
    const r = await req('GET', '/api/users');
    userRows.push([k, r.status, (r.data && r.data.items) ? r.data.items.length : 0]);
  }
  console.log('     结果：' + userRows.map(x => x[0] + '=' + x[1] + (x[2] ? '(' + x[2] + '条)' : '')).join('  '));
  const uv = (k) => userRows.find(x => x[0] === k);
  ok('admin 可看账号列表 → 200，且能看到全部 11 个账号', uv('admin')[1] === 200 && uv('admin')[2] === 11, uv('admin'));
  for (const k of ['owner', 'hq', 'ph', 'regA', 'mgrA', 'mgrB', 'sales', 'wh', 'svc', 'ghost']) {
    ok(k + ' 查看账号列表 → 403（不泄露任何账号）', uv(k)[1] === 403 && uv(k)[2] === 0, uv(k));
  }
  ok('非 admin 角色一律拿不到账号列表（10/10）',
    userRows.filter(x => x[0] !== 'admin').every(x => x[1] === 403 && x[2] === 0));
  // 参数伪造
  await login(USERS.mgrA[0], USERS.mgrA[1]);
  ok('店长带 role=admin 查账号 → 仍 403', (await req('GET', '/api/users?role=admin&storeId=SA')).status === 403);
  await login(USERS.ph[0], USERS.ph[1]);
  ok('菲律宾负责人带 country=global 查账号 → 仍 403', (await req('GET', '/api/users?country=global')).status === 403);

  // ═══════════ 二、报表 / 总览（3 个接口 / 5 处旧判断）═══════════
  console.log('\n【二-1】经营总览 GET /api/dashboard（dashboard.view + filterList）');
  const dash = {};
  for (const [k, [u, p]] of Object.entries(USERS)) {
    await login(u, p);
    const r = await req('GET', '/api/dashboard');
    dash[k] = { status: r.status, total: r.data && r.data.total, points: r.data && r.data.points };
  }
  console.log('     结果：' + Object.entries(dash).map(([k, v]) => k + '=' + v.status + (v.total !== undefined ? '/会员' + v.total : '')).join('  '));
  ok('admin（global）→ 200，会员总数 4（全部）', dash.admin.status === 200 && dash.admin.total === 4, dash.admin);
  ok('hq_operator（philippines）→ 200，会员总数 4', dash.hq.status === 200 && dash.hq.total === 4, dash.hq);
  ok('philippines_manager（philippines）→ 200，会员总数 4', dash.ph.status === 200 && dash.ph.total === 4, dash.ph);
  ok('★ regionA 负责人 → 200，会员总数 2（只含本区）', dash.regA.status === 200 && dash.regA.total === 2, dash.regA);
  ok('★ A区店长 → 200，会员总数 2（只含本店）', dash.mgrA.status === 200 && dash.mgrA.total === 2, dash.mgrA);
  ok('★ B区店长 → 200，会员总数 2（只含本店，且与 A 店互不可见）', dash.mgrB.status === 200 && dash.mgrB.total === 2, dash.mgrB);
  ok('★ 店长看到的是本店数据：积分合计 300（A店 100+200），不是全域 1500',
    dash.mgrA.points === 300, { got: dash.mgrA.points, allPoints: 1500 });
  ok('owner → 200（经营查看）', dash.owner.status === 200);
  ok('warehouse / service → 200（按矩阵有 dashboard.view @ store）', dash.wh.status === 200 && dash.svc.status === 200);
  // sales 的 member.view 是 store 范围（self 只作用于 crm/task），因此看得到本店会员
  ok('sales → 200，会员数为 2（member.view @ store，本店）', dash.sales.status === 200 && dash.sales.total === 2, dash.sales);
  ok('未识别角色 → 403（无 dashboard.view）', dash.ghost.status === 403, dash.ghost.status);

  console.log('\n【二-2】经营报表 GET /api/reports/overview（report.view + filterList）');
  const rep = {};
  for (const [k, [u, p]] of Object.entries(USERS)) {
    await login(u, p);
    const r = await req('GET', '/api/reports/overview');
    rep[k] = { status: r.status, summary: r.data && r.data.summary, stores: r.data && r.data.storeRanking };
  }
  console.log('     结果：' + Object.entries(rep).map(([k, v]) => k + '=' + v.status).join('  '));
  ok('admin → 200 且含全部 2 家门店排行', rep.admin.status === 200 && (rep.admin.stores || []).length === 2,
    (rep.admin.stores || []).length);
  ok('★ A区店长 → 200 且门店排行只有 1 家（本店）',
    rep.mgrA.status === 200 && (rep.mgrA.stores || []).length === 1, (rep.mgrA.stores || []).length);
  ok('★ A区负责人 → 200 且只含本区门店', rep.regA.status === 200 && (rep.regA.stores || []).length === 1,
    (rep.regA.stores || []).length);
  ok('hq_operator → 200（全菲）', rep.hq.status === 200);
  ok('未识别角色 → 403', rep.ghost.status === 403);

  console.log('\n【二-3】全局流水 GET /api/transactions（points.view + filterList）');
  const txr = {};
  for (const [k, [u, p]] of Object.entries(USERS)) {
    await login(u, p);
    const r = await req('GET', '/api/transactions');
    txr[k] = { status: r.status, n: (r.data && r.data.items) ? r.data.items.length : 0, ids: ((r.data && r.data.items) || []).map(t => t.id) };
  }
  console.log('     结果：' + Object.entries(txr).map(([k, v]) => k + '=' + v.status + (v.n !== undefined ? '/' + v.n + '条' : '')).join('  '));
  ok('admin → 200，看到全部 2 条流水', txr.admin.status === 200 && txr.admin.n === 2, txr.admin);
  ok('★ A区店长 → 200，只看到 1 条（TA1，本店）',
    txr.mgrA.status === 200 && txr.mgrA.n === 1 && txr.mgrA.ids[0] === 'TA1', txr.mgrA);
  ok('★ B区店长 → 200，只看到 1 条（TB1，本店）',
    txr.mgrB.status === 200 && txr.mgrB.n === 1 && txr.mgrB.ids[0] === 'TB1', txr.mgrB);
  ok('★ 两个店长看到的流水完全不重叠（无跨店泄露）',
    txr.mgrA.ids.every(id => txr.mgrB.ids.indexOf(id) === -1));
  ok('A区负责人 → 200，只看到本区 1 条', txr.regA.status === 200 && txr.regA.n === 1, txr.regA);
  ok('hq_operator → 200，看到全部 2 条（全菲）', txr.hq.status === 200 && txr.hq.n === 2, txr.hq);
  ok('未识别角色 → 403', txr.ghost.status === 403);

  // ═══════════ 三、数据主库 ═══════════
  console.log('\n【三】数据主库（db.view / db.export，admin only）');
  const dbPaths = [
    ['overview', '/api/db/overview', 'db.view'],
    ['collection', '/api/db/collection/members', 'db.view'],
    ['export', '/api/db/export?key=members&format=json', 'db.export'],
  ];
  await login(USERS.admin[0], USERS.admin[1]);
  for (const [label, p, perm] of dbPaths) {
    const r = await req('GET', p);
    ok('admin 访问 ' + label + '（' + perm + '）→ 200', r.status === 200, r.status);
  }
  for (const k of ['owner', 'hq', 'ph', 'regA', 'mgrA', 'sales', 'ghost']) {
    await login(USERS[k][0], USERS[k][1]);
    let allDenied = true; const codes = [];
    for (const [label, p] of dbPaths) {
      const r = await req('GET', p);
      codes.push(label + '=' + r.status);
      if (r.status !== 403) allDenied = false;
    }
    ok(k + ' 访问数据主库三个接口 → 全部 403', allDenied, codes);
  }
  await login(USERS.mgrA[0], USERS.mgrA[1]);
  ok('店长带 role=admin 访问数据主库 → 仍 403', (await req('GET', '/api/db/overview?role=admin')).status === 403);
  await login(USERS.ph[0], USERS.ph[1]);
  ok('菲律宾负责人带 country=global 访问数据主库 → 仍 403',
    (await req('GET', '/api/db/export?key=all&format=json&country=global')).status === 403);
  await login(USERS.owner[0], USERS.owner[1]);
  ok('老板（owner）访问数据主库 → 403（无 db / system / sync 权限）',
    (await req('GET', '/api/db/overview')).status === 403);

  // ═══════════ 四、审计日志 ═══════════
  console.log('\n【四】审计日志 GET /api/audit-log（system.audit.view，admin only）');
  await login(USERS.admin[0], USERS.admin[1]);
  let r = await req('GET', '/api/audit-log');
  ok('admin 可读审计日志 → 200', r.status === 200 && Array.isArray(r.data.items), r.status);
  for (const k of ['owner', 'hq', 'ph', 'regA', 'mgrA', 'sales', 'ghost']) {
    await login(USERS[k][0], USERS[k][1]);
    ok(k + ' 读审计日志 → 403', (await req('GET', '/api/audit-log')).status === 403);
  }
  await login(USERS.hq[0], USERS.hq[1]);
  ok('HQ 带 role=admin 读审计日志 → 仍 403', (await req('GET', '/api/audit-log?role=admin&limit=9999')).status === 403);

  // ═══════════ 五、L1 / L2 与兼容 ═══════════
  console.log('\n【五】L1/L2 与兼容');
  await login(USERS.admin[0], USERS.admin[1]);
  r = await req('GET', '/api/db/collection/not_a_collection');
  ok('admin 访问不存在的集合 → 404（L2 业务层，不是 403）', r.status === 404, r.status);
  await login(USERS.mgrA[0], USERS.mgrA[1]);
  r = await req('GET', '/api/db/collection/not_a_collection');
  ok('店长访问同一路径 → 403（L1 先拦，轮不到 404）', r.status === 403, r.status);
  r = await req('GET', '/api/dashboard');
  ok('旧 manager 仍可看总览（原能力保留）', r.status === 200);
  r = await req('GET', '/api/transactions');
  ok('旧 manager 仍可看流水（原能力保留）', r.status === 200);
  r = await req('GET', '/api/reports/overview');
  ok('旧 manager 仍可看报表（原能力保留）', r.status === 200);
  await login(USERS.admin[0], USERS.admin[1]);
  r = await req('GET', '/api/dashboard');
  ok('admin 总览仍为全量 4 会员（原能力保留）', r.status === 200 && r.data.total === 4);

  console.log(`\n══════ ${pass} passed, ${fail} failed ══════`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.stack); try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e2) {} process.exit(2); });
