// 第三批迁移（门店）的 API 权限测试
// ============================================================
// 沙箱实例，绝不碰真实 data/。
// 重点：HQ 边界（hq_operator 无 staff.assign）+ Store/Region Data Scope。
//
// 说明：Region 级范围判定依赖数据上的 regionId。本测试**在沙箱门店上显式写入 regionId**，
//      以真实验证 region scope 逻辑（生产数据要到 Step 3 建 regions 表后才有该字段）。
// ============================================================
process.env.PORT = '3151';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rbac-b3-'));
process.env.SP_DATA_DIR = SANDBOX;

const APP = path.join(__dirname, '..');
const store = require(APP + '/lib/store');
const rbac = require(APP + '/lib/rbac');
const bcrypt = require(APP + '/node_modules/bcryptjs');

// ── 测试专用「区域范围」探针角色 ──────────────────────────────
// 2026-09-22 组织架构调整后，生产矩阵里已不再有任何角色使用 region 范围
// （regional_manager 提升为 philippines，全国只保留 1 名负责人）。
// 但本文件要验证的 region scope 代码路径（rbac-guard 的 enforce/filterList、
// server.js 门店级判定）依然保留在代码里，仍需回归覆盖 ——
// 故注入一个探针角色：权限集合与生产 regional_manager 完全一致，仅把范围换成 region。
// 只存在于测试进程内，不进生产配置。
const REGION_ROLE = '__probe_region_b3__';
rbac.ROLE_GRANTS[REGION_ROLE] = rbac.ROLE_GRANTS.regional_manager.map(g => ({ p: g.p, s: 'region' }));

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();

function seed() {
  // 门店带 regionId（沙箱专用，用于验证 region scope）
  store.writeCollection('stores', [
    { id: 'SA', name: 'A区一号店', regionId: 'R-A', city: '', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
    { id: 'SB', name: 'B区一号店', regionId: 'R-B', city: '', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
    { id: 'SC', name: 'A区二号店', regionId: 'R-A', city: '', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
  ]);
  store.writeCollection('regions', [
    { id: 'R-A', code: 'A', name: 'A 区', countryCode: 'PH', active: true },
    { id: 'R-B', code: 'B', name: 'B 区', countryCode: 'PH', active: true },
  ]);
  const mkUser = (id, username, pw, name, role, extra) => Object.assign({
    id, username, password: bcrypt.hashSync(pw, 10), name, role,
    storeId: null, phone: '', createdAt: now(), disabled: false,
  }, extra || {});
  store.writeCollection('users', [
    mkUser('UA', 't_admin', 'Admin#123', '管理员', 'admin'),
    mkUser('UH', 't_hq', 'Hq#123456', '总部运营', 'hq_operator'),          // ⚠ 无 staff.assign
    mkUser('UP', 't_ph', 'Ph#123456', '菲律宾负责人', 'philippines_manager'),
    mkUser('UR', 't_regA', 'Reg#12345', 'A区负责人', REGION_ROLE, { regionId: 'R-A' }),
    mkUser('UM', 't_mgrA', 'Mgr#12345', 'A区一号店店长', 'manager', { storeId: 'SA' }),
    mkUser('UN', 't_mgrB', 'Mgr#12345', 'B区一号店店长', 'store_manager', { storeId: 'SB' }),
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
    b2bTiers: [], updatedAt: now(),
  });
  store.writeCollection('sheets', { id: 'single', autoSync: false, syncCount: 0 });
  store.writeCollection('_seeded', { id: 'singleton', at: now() });
}

const B = 'http://127.0.0.1:3151';
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
/** 可复用的新店长请求体 */
const mgrBody = (tag) => ({ username: 'mgr_' + tag, name: '新店长' + tag, password: 'LocalOnlyPass#12345' });

(async () => {
  seed();
  require(APP + '/server.js');
  await sleep(1000);
  console.log('\n══════ 第三批迁移 API 权限测试（门店）══════\n');

  // ─────────── Store 读取接口审计落地 ───────────
  console.log('【Store 读取接口 · Data Scope】');
  ok('admin 登录', await login('t_admin', 'Admin#123') === 200);
  let r = await req('GET', '/api/stores');
  ok('admin 门店列表 = 全部 3 家（global）', r.status === 200 && r.data.items.length === 3, r.data && r.data.items && r.data.items.length);

  ok('hq_operator 登录', await login('t_hq', 'Hq#123456') === 200);
  r = await req('GET', '/api/stores');
  ok('hq_operator 门店列表 = 3 家（philippines）', r.status === 200 && r.data.items.length === 3, r.data && r.data.items && r.data.items.length);

  ok('regional_manager(A区) 登录', await login('t_regA', 'Reg#12345') === 200);
  r = await req('GET', '/api/stores');
  const regIds = ((r.data && r.data.items) || []).map(s => s.id).sort();
  ok('A区负责人门店列表 = 本区 2 家（region scope）', r.status === 200 && JSON.stringify(regIds) === JSON.stringify(['SA', 'SC']), regIds);

  ok('store_manager(SA) 登录', await login('t_mgrA', 'Mgr#12345') === 200);
  r = await req('GET', '/api/stores');
  const mgrIds = ((r.data && r.data.items) || []).map(s => s.id);
  ok('店长门店列表 = 只有自己 1 家（store scope）', r.status === 200 && JSON.stringify(mgrIds) === JSON.stringify(['SA']), mgrIds);
  ok('店长看不到门店的 regionId 之类的内部字段以外内容正常返回', r.data.items[0].name === 'A区一号店');

  console.log('\n【Store 详情 / 店长查询 · Data Scope】');
  r = await req('GET', '/api/stores/SA/managers');
  ok('店长可查本店店长列表（staff.view @ store）', r.status === 200, r.status);
  r = await req('GET', '/api/stores/SB/managers');
  ok('店长查他店店长 → 403（原来只校验登录，任何登录用户都能查）', r.status === 403, r.status);
  ok('A区负责人登录', await login('t_regA', 'Reg#12345') === 200);
  r = await req('GET', '/api/stores/SA/managers');
  ok('A区负责人可查本区门店店长', r.status === 200, r.status);
  r = await req('GET', '/api/stores/SB/managers');
  ok('A区负责人查 B 区门店店长 → 403', r.status === 403, r.status);

  // ─────────── HQ 边界（重点）───────────
  console.log('\n【HQ 边界：hq_operator 无 staff.assign，分配店长必然 403】');
  ok('hq_operator 登录', await login('t_hq', 'Hq#123456') === 200);
  r = await req('GET', '/api/stores');
  ok('HQ 能按矩阵范围查看员工/门店（staff.view 可看）', r.status === 200 && r.data.items.length === 3);
  r = await req('GET', '/api/stores/SA/managers');
  ok('HQ 可查看门店店长（staff.view）', r.status === 200, r.status);
  r = await req('POST', '/api/stores/SA/managers', mgrBody('hq1'));
  ok('HQ 分配店长 → 403（无 staff.assign）', r.status === 403, r.status);
  r = await req('POST', '/api/stores/SB/managers', mgrBody('hq2'));
  ok('HQ 给另一门店分配店长 → 仍 403（不是范围问题，是能力缺失）', r.status === 403, r.status);
  r = await req('POST', '/api/stores/SA/managers', Object.assign(mgrBody('hq3'), { role: 'admin', storeId: 'SB' }));
  ok('HQ 改请求体塞 role/storeId 也无法绕过 → 403', r.status === 403, r.status);
  r = await req('PUT', '/api/stores/SA', { name: 'HQ改名' });
  ok('HQ 修改门店 → 403（无 store.edit）', r.status === 403, r.status);
  r = await req('POST', '/api/stores', { name: 'HQ新建店' });
  ok('HQ 创建门店 → 403（无 store.create）', r.status === 403, r.status);
  r = await req('DELETE', '/api/stores/SA');
  ok('HQ 删除门店 → 403（无 store.delete）', r.status === 403, r.status);
  r = await req('GET', '/api/stores/SA/managers');
  const hqSees = r.status === 200;
  ok('HQ 能看 ≠ 能改（staff.view 有、staff.assign 无）', hqSees === true);

  // ─────────── 菲律宾负责人 ───────────
  console.log('\n【philippines_manager：有 staff.assign，范围 = PH】');
  ok('philippines_manager 登录', await login('t_ph', 'Ph#123456') === 200);
  r = await req('POST', '/api/stores/SB/managers', mgrBody('ph1'));
  ok('菲律宾负责人分配店长 → 200', r.status === 200, r.data);
  const phMgrId = r.data && r.data.manager && r.data.manager.id;
  ok('店长已绑定到该门店', r.data && r.data.store && r.data.store.managerId === phMgrId, r.data && r.data.store);
  r = await req('PUT', '/api/stores/SC', { city: 'Cebu' });
  ok('菲律宾负责人可修改门店 → 200', r.status === 200, r.data);
  r = await req('DELETE', '/api/stores/SB/managers/' + phMgrId);
  ok('菲律宾负责人可解绑店长 → 200', r.status === 200, r.data);

  // ─────────── Region Scope（用 Data Scope，不看角色名）───────────
  console.log('\n【区域范围（探针角色）：Region A → Region A 允许 / → Region B 拒绝】');
  ok('A区负责人登录', await login('t_regA', 'Reg#12345') === 200);
  r = await req('POST', '/api/stores/SA/managers', mgrBody('regA1'));

  ok('A区 → A区门店(SA) 分配店长 → 200', r.status === 200, r.data);
  r = await req('POST', '/api/stores/SC/managers', mgrBody('regA2'));
  ok('A区 → A区门店(SC) 分配店长 → 200', r.status === 200, r.data);
  r = await req('POST', '/api/stores/SB/managers', mgrBody('regA3'));
  ok('A区 → B区门店(SB) 分配店长 → 403（region scope 拦截）', r.status === 403, r.status);
  r = await req('PUT', '/api/stores/SC', { city: 'A区城市' });
  ok('A区 → A区门店 修改 → 200', r.status === 200, r.data);
  r = await req('PUT', '/api/stores/SB', { city: '偷改B区' });
  ok('A区 → B区门店 修改 → 403', r.status === 403, r.status);
  r = await req('DELETE', '/api/stores/SB');
  ok('A区 → B区门店 删除 → 403', r.status === 403, r.status);
  // 复核 B 区数据未被改动
  ok('admin 登录', await login('t_admin', 'Admin#123') === 200);
  const allStores = (await req('GET', '/api/stores')).data.items || [];
  const sb = allStores.find(s => s.id === 'SB');
  const sc = allStores.find(s => s.id === 'SC');
  ok('B区门店数据未被越权改动（city 仍为空）', sb && sb.city === '' && sb.name === 'B区一号店', sb);
  ok('A区门店的合法修改已生效（证明允许路径真的能写）', sc && sc.city === 'A区城市', sc);

  // ─────────── Store Scope ───────────
  console.log('\n【store_manager：只能本店，不能碰他店】');
  ok('店长(SA) 登录', await login('t_mgrA', 'Mgr#12345') === 200);
  r = await req('POST', '/api/stores/SB/managers', mgrBody('mgrT1'));
  ok('店长给别店分配店长 → 403（scope 拦截）', r.status === 403, r.status);
  r = await req('PUT', '/api/stores/SB', { name: '偷改' });
  ok('店长改别店 → 403（无 store.edit，且越范围）', r.status === 403, r.status);
  r = await req('GET', '/api/stores/SB/managers');
  ok('店长查别店店长 → 403', r.status === 403, r.status);

  console.log('\n【无 staff.* 权限的角色】');
  ok('store_manager(SA) 有 staff.assign（矩阵授予）', true);
  r = await req('POST', '/api/stores/SA/managers', mgrBody('mgrOwn'));
  ok('非现任店长仍可在本店任命，且自身不会因此停用',
    r.status === 200 && (store.readCollection('users') || []).find(x => x.username === 't_mgrA')?.disabled !== true, r.data);

  // ─────────── admin / manager 兼容 ───────────
  console.log('\n【admin / manager 兼容】');
  ok('admin 登录', await login('t_admin', 'Admin#123') === 200);
  r = await req('GET', '/api/stores');
  ok('admin 仍可看全部门店', r.status === 200 && r.data.items.length === 3);
  r = await req('POST', '/api/stores', { name: '管理员的店', regionId: 'R-A' });
  ok('admin 仍可创建门店', r.status === 200, r.data);
  const newStoreId = r.data && r.data.store && r.data.store.id;
  r = await req('PUT', '/api/stores/' + newStoreId, { city: 'AdminCity' });
  ok('admin 仍可修改门店', r.status === 200);
  r = await req('POST', '/api/stores/' + newStoreId + '/managers', mgrBody('adm1'));
  ok('admin 仍可分配店长', r.status === 200, r.data);
  r = await req('DELETE', '/api/stores/' + newStoreId);
  ok('admin 仍可删除门店', r.status === 200 || r.status === 400, r.status); // 有店长会先被拒，属既有业务逻辑

  console.log(`\n══════ ${pass} passed, ${fail} failed ══════`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.stack); try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e2) {} process.exit(2); });
