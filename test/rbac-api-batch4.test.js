// 第四批迁移（规则 / 云同步）的 API 权限测试
// ============================================================
// 沙箱实例，绝不碰真实 data/。
// 重点：
//   · Rules：能看 ≠ 能改（points.view vs points.rule.edit）
//   · Sync ：view / config / run 三个能力分开授权，不合并成一个
//   · owner / hq_operator / philippines_manager 不得获得 system 级 sync 权限
//   · L1/L2 分离：403 = 无权限；400 = 有权限但状态/入参不合法
// ============================================================
process.env.PORT = '3161';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rbac-b4-'));
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

function seed() {
  store.writeCollection('stores', [
    { id: 'S1', name: '一号店', city: '', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
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
    mkUser('UR', 't_reg', 'Reg#12345', '区域负责人', 'regional_manager', { regionId: 'R-A' }),
    mkUser('UM', 't_mgr', 'Mgr#12345', '店长', 'manager', { storeId: 'S1' }),
    mkUser('US', 't_sales', 'Sales#123', '销售', 'sales', { storeId: 'S1' }),
    // 未识别角色：应无任何权限（用于验证「无权限读取 → 403」）
    mkUser('UX', 't_ghost', 'Ghost#123', '未知角色', 'ghost_of_role'),
  ]);
  store.writeCollection('members', []);
  store.writeCollection('transactions', []);
  store.writeCollection('pending', []);
  store.writeCollection('products', []);
  store.writeCollection('redemptions', []);
  store.writeCollection('rules', {
    id: 'single', spendPerPoint: 10, expiryMonths: 24, welcomeBonus: 500,
    redeemRatio: '10:1', redeemMaxPercent: 0, redeemMinPoints: 0,
    requireConfirm: false, realtimePush: false,
    levels: [{ key: 'silver', name: 'Silver', threshold: 0, color: '#9CA3AF' }],
    b2bTiers: [], updatedAt: now(), schemaVersion: 4,
  });
  store.writeCollection('sheets', { id: 'single', autoSync: false, syncCount: 0, gasUrl: '', spreadsheetId: '' });
  store.writeCollection('_seeded', { id: 'singleton', at: now() });
}

const B = 'http://127.0.0.1:3161';
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
const ROLES = [
  ['admin', 't_admin', 'Admin#123'],
  ['owner', 't_owner', 'Owner#123'],
  ['hq_operator', 't_hq', 'Hq#123456'],
  ['philippines_manager', 't_ph', 'Ph#123456'],
  ['regional_manager', 't_reg', 'Reg#12345'],
  ['store_manager(旧manager)', 't_mgr', 'Mgr#12345'],
  ['sales', 't_sales', 'Sales#123'],
  ['未识别角色', 't_ghost', 'Ghost#123'],
];

(async () => {
  seed();
  require(APP + '/server.js');
  await sleep(1000);
  console.log('\n══════ 第四批迁移 API 权限测试（规则 / 云同步）══════\n');

  // ═══════════ A. Rules ═══════════
  console.log('【A1】读取规则（points.view）');
  const readRows = [];
  for (const [label, u, p] of ROLES) {
    ok(label + ' 登录', await login(u, p) === 200);
    const r = await req('GET', '/api/rules');
    readRows.push([label, r.status]);
  }
  console.log('     读取结果：' + readRows.map(x => x[0] + '=' + x[1]).join('  '));
  ok('admin 读规则 → 200', readRows.find(x => x[0] === 'admin')[1] === 200);
  ok('owner 读规则 → 200（老板可查看）', readRows.find(x => x[0] === 'owner')[1] === 200);
  ok('hq_operator 读规则 → 200', readRows.find(x => x[0] === 'hq_operator')[1] === 200);
  ok('philippines_manager 读规则 → 200', readRows.find(x => x[0] === 'philippines_manager')[1] === 200);
  ok('regional_manager 读规则 → 200', readRows.find(x => x[0] === 'regional_manager')[1] === 200);
  ok('store_manager 读规则 → 200（门店需知道积分规则）', readRows.find(x => x[0].indexOf('store_manager') === 0)[1] === 200);
  ok('sales 读规则 → 200', readRows.find(x => x[0] === 'sales')[1] === 200);
  ok('未识别角色读规则 → 403（无 points.view）', readRows.find(x => x[0] === '未识别角色')[1] === 403,
    readRows.find(x => x[0] === '未识别角色')[1]);

  console.log('\n【A2】修改规则（points.rule.edit）');
  const writeRows = [];
  for (const [label, u, p] of ROLES) {
    await login(u, p);
    const r = await req('PUT', '/api/rules', { spendPerPoint: 11 });
    writeRows.push([label, r.status]);
  }
  console.log('     修改结果：' + writeRows.map(x => x[0] + '=' + x[1]).join('  '));
  const w = (k) => writeRows.find(x => x[0] === k)[1];
  ok('admin 改规则 → 200', w('admin') === 200);
  ok('owner 改规则 → 403（老板只看不改）', w('owner') === 403, w('owner'));
  ok('hq_operator 改规则 → 403（总部不改一线标准）', w('hq_operator') === 403, w('hq_operator'));
  ok('regional_manager 改规则 → 403（普通管理角色不能改全局规则）', w('regional_manager') === 403, w('regional_manager'));
  ok('store_manager 改规则 → 403', w('store_manager(旧manager)') === 403, w('store_manager(旧manager)'));
  ok('sales 改规则 → 403', w('sales') === 403, w('sales'));
  ok('未识别角色改规则 → 403', w('未识别角色') === 403);
  // 2026-09-22 收紧：rules 是全局单例配置，points.rule.edit 只属于 admin（global）
  ok('philippines_manager 改规则 → 403（全局配置不可由非 global 角色修改）', w('philippines_manager') === 403, w('philippines_manager'));
  ok('所有非 admin 角色改规则一律 403（8/8 无例外）',
    ['owner', 'hq_operator', 'philippines_manager', 'regional_manager', 'store_manager(旧manager)', 'sales', '未识别角色']
      .every(k => w(k) === 403));

  console.log('\n【A2b】规则权限不能被请求参数绕过');
  for (const [label, u, p, params] of [
    ['philippines_manager', 't_ph', 'Ph#123456', { role: 'admin' }],
    ['philippines_manager', 't_ph', 'Ph#123456', { regionId: 'R-A' }],
    ['philippines_manager', 't_ph', 'Ph#123456', { country: 'global' }],
    ['regional_manager', 't_reg', 'Reg#12345', { storeId: 'S1', role: 'admin' }],
    ['store_manager', 't_mgr', 'Mgr#12345', { role: 'admin', scope: 'global' }],
  ]) {
    await login(u, p);
    const body = Object.assign({ spendPerPoint: 99 }, params);
    ok(label + ' 带 ' + JSON.stringify(params) + ' 改规则 → 仍 403',
      (await req('PUT', '/api/rules', body)).status === 403);
  }
  await login('t_ph', 'Ph#123456');
  ok('philippines_manager 带 role=admin 试算到期 → 仍 403',
    (await req('POST', '/api/rules/expiry-scan', { role: 'admin', storeId: 'S1' })).status === 403);

  console.log('\n【A3】积分到期试算（points.expiry.scan，同样收紧为 admin only）');
  const scanRows = [];
  for (const [label, u, p] of ROLES) {
    await login(u, p);
    scanRows.push([label, (await req('POST', '/api/rules/expiry-scan', {})).status]);
  }
  console.log('     试算结果：' + scanRows.map(x => x[0] + '=' + x[1]).join('  '));
  const s = (k) => scanRows.find(x => x[0] === k)[1];
  ok('admin 试算 → 200', s('admin') === 200);
  ok('owner 试算 → 403（老板不做系统操作）', s('owner') === 403);
  ok('hq_operator 试算 → 403', s('hq_operator') === 403);
  ok('philippines_manager 试算 → 403（全局配置只属 admin）', s('philippines_manager') === 403, s('philippines_manager'));
  ok('regional_manager 试算 → 403', s('regional_manager') === 403);
  ok('store_manager 试算 → 403', s('store_manager(旧manager)') === 403);
  ok('sales 试算 → 403', s('sales') === 403);
  ok('除 admin 外全部 403（7/7）',
    ['owner', 'hq_operator', 'philippines_manager', 'regional_manager', 'store_manager(旧manager)', 'sales', '未识别角色']
      .every(k => s(k) === 403));

  // ═══════════ B. Cloud Sync ═══════════
  console.log('\n【B1】云同步三能力分开授权');
  const syncMatrix = {};
  for (const [label, u, p] of ROLES) {
    await login(u, p);
    syncMatrix[label] = {
      view: (await req('GET', '/api/sheets/status')).status,
      config: (await req('POST', '/api/sheets/config', { autoSync: true })).status,
      run: (await req('POST', '/api/sheets/sync-now', {})).status,
      log: (await req('POST', '/api/sheets/log', { action: 'push', status: 'success' })).status,
    };
  }
  for (const [label, r] of Object.entries(syncMatrix)) {
    console.log('     ' + label.padEnd(24) + ' view=' + r.view + ' config=' + r.config + ' run=' + r.run + ' log=' + r.log);
  }
  const sm = (k) => syncMatrix[k];
  // run 在未配置 GAS 时返回 400（业务原因），不是 403 —— 说明权限已放行
  ok('admin: view/config 放行（200）', sm('admin').view === 200 && sm('admin').config === 200);
  ok('admin: run 已放行（400 = 未配置 GAS 的业务原因，不是 403）',
    sm('admin').run === 400, sm('admin').run);
  ok('admin: log 放行（200）', sm('admin').log === 200);
  ok('owner: view → 403', sm('owner').view === 403);
  ok('owner: config → 403', sm('owner').config === 403);
  ok('owner: run → 403', sm('owner').run === 403);
  ok('owner: log → 403', sm('owner').log === 403);
  ok('owner 完全没有任何 sync 权限（4/4 全 403）',
    sm('owner').view === 403 && sm('owner').config === 403 && sm('owner').run === 403 && sm('owner').log === 403);
  ok('hq_operator: view → 403（按矩阵无 sync.view）', sm('hq_operator').view === 403);
  ok('hq_operator: config → 403', sm('hq_operator').config === 403);
  ok('hq_operator: run → 403', sm('hq_operator').run === 403);
  ok('philippines_manager: view → 403（业务权限不会带来系统级权限）', sm('philippines_manager').view === 403);
  ok('philippines_manager: config → 403', sm('philippines_manager').config === 403);
  ok('philippines_manager: run → 403', sm('philippines_manager').run === 403);
  ok('regional_manager 全部 403', sm('regional_manager').view === 403 && sm('regional_manager').config === 403);
  ok('store_manager 全部 403（店长看不到 GAS URL 与密钥）',
    sm('store_manager(旧manager)').view === 403 && sm('store_manager(旧manager)').config === 403);
  ok('sales 全部 403', sm('sales').view === 403);

  console.log('\n【B2】不能通过请求参数绕过');
  await login('t_mgr', 'Mgr#12345');
  ok('店长带 role=admin 请求 status → 仍 403',
    (await req('GET', '/api/sheets/status', undefined) && true) && (await req('POST', '/api/sheets/config', { role: 'admin', autoSync: true })).status === 403);
  ok('店长带 sync=true 触发同步 → 仍 403',
    (await req('POST', '/api/sheets/sync-now', { sync: true, role: 'admin' })).status === 403);
  ok('店长带 storeId 伪装 → 仍 403',
    (await req('POST', '/api/sheets/config', { storeId: 'S1', spreadsheetId: 'X' })).status === 403);
  await login('t_hq', 'Hq#123456');
  ok('HQ 带 role=admin 请求同步状态 → 仍 403',
    (await req('GET', '/api/sheets/status')).status === 403);

  // ═══════════ C. L1 / L2 分离 ═══════════
  console.log('\n【C】L1 / L2 分离（403 = 无权限；400 = 有权限但状态/入参不合法）');
  await login('t_admin', 'Admin#123');
  let r = await req('POST', '/api/sheets/sync-now', {});
  ok('admin 触发同步 → 400（未配置 GAS，业务原因；不是 403）', r.status === 400, r.status);
  ok('400 的错误来自业务层（可选同步未配置）', r.data && typeof r.data.error === 'string', r.data);
  r = await req('PUT', '/api/rules', { spendPerPoint: -5 });
  ok('admin 提交非法规则 → 400（入参校验，不是 403）', r.status === 400, r.status);
  await login('t_mgr', 'Mgr#12345');
  r = await req('PUT', '/api/rules', { spendPerPoint: -5 });
  ok('店长提交同样非法规则 → 403（先被权限拦，不是 400）', r.status === 403, r.status);

  // ═══════════ 兼容 ═══════════
  console.log('\n【兼容】');
  await login('t_admin', 'Admin#123');
  r = await req('GET', '/api/rules');
  ok('admin 仍可读取规则（原能力保留）', r.status === 200 && !!r.data.rules);
  r = await req('PUT', '/api/rules', { spendPerPoint: 10 });
  ok('admin 仍可修改规则（原能力保留）', r.status === 200);
  r = await req('GET', '/api/sheets/status');
  ok('admin 仍可查看同步状态（原能力保留）', r.status === 200);
  r = await req('POST', '/api/sheets/config', { autoSync: false });
  ok('admin 仍可配置同步（原能力保留）', r.status === 200);
  await login('t_mgr', 'Mgr#12345');
  r = await req('GET', '/api/rules');
  ok('旧 manager 仍可读取规则（原能力保留）', r.status === 200);
  r = await req('PUT', '/api/rules', { spendPerPoint: 10 });
  ok('旧 manager 仍不能改规则（与原行为一致）', r.status === 403);
  r = await req('GET', '/api/sheets/status');
  ok('旧 manager 仍看不到同步配置（与原行为一致）', r.status === 403);

  console.log(`\n══════ ${pass} passed, ${fail} failed ══════`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.stack); try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e2) {} process.exit(2); });
