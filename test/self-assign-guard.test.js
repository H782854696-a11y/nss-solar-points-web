// ============================================================
// staff.assign 自我停用 / 自我替换 隐患 —— 回归测试
// ============================================================
// 隐患（2026-09-22 发现）：
//   `POST /api/stores/:id/managers` 的逻辑是「一家门店只保留一位店长」，
//   会把 `store.managerId` 指向的账号置为 disabled=true。
//   若调用者**本身就是该门店的现任店长**，他调用此接口就等于把自己停用
//   （账号一停用，`getSessionUser` 立刻作废自己的会话 → 门店失去唯一店长，且不可逆）。
//   同理 `DELETE /api/stores/:id/managers/:managerId` 传自己的 id 也会自我停用。
//
// 本文件断言「修复后」的期望行为：
//   · 目标 = 当前登录用户本人 → 拒绝（400）且不落库、不动 dataVersion
//   · 目标 = 别人            → 保持原行为（admin / regional_manager 任命不受影响）
//   · 跨门店                  → 仍然 403
//
// 沙箱实例，绝不碰真实 data/。
// ============================================================
process.env.PORT = '3181';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-selfassign-'));
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
const PW = 'Test#12345';

// ── 账号 id（固定字符串，方便断言引用）──
const U = {
  admin: 'U-admin',
  pp: 'U-pp',        // 全国区域负责人（regional_manager / philippines）
  mgr1: 'U-mgr1',    // S1 的现任店长（store.managerId = mgr1）→ 自我停用隐患主体
  mgr2: 'U-mgr2',    // S2 的现任店长，用来验证跨店拦截
  mgr3: 'U-mgr3',    // S3 的店长，但 S3.managerId = null → 验证「正常任命别人」仍可用
  regA: 'U-regA',    // 区域范围角色（region scope）→ 验证范围语义未变
  sales1: 'U-sales1',// S1 的销售
};

function seed() {
  store.writeCollection('stores', [
    // S1：managerId 指向 mgr1 —— 自我停用场景
    { id: 'S1', name: '一号店', regionId: 'R-A', city: '', address: '', managerId: U.mgr1, managerName: '一号店长', phone: '', createdAt: now() },
    // S2：managerId 指向 mgr2 —— 跨店拦截场景
    { id: 'S2', name: '二号店', regionId: 'R-B', city: '', address: '', managerId: U.mgr2, managerName: '二号店长', phone: '', createdAt: now() },
    // S3：managerId = null，但 mgr3 是 S3 的 store_manager → 「正常任命别人」应仍可用
    { id: 'S3', name: '三号店', regionId: 'R-A', city: '', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
  ]);
  const mkUser = (id, username, name, role, extra) => Object.assign({
    id, username, password: bcrypt.hashSync(PW, 10), name, role,
    storeId: null, phone: '', createdAt: now(), disabled: false,
  }, extra || {});
  store.writeCollection('users', [
    mkUser(U.admin, 't_admin', '管理员', 'admin'),
    mkUser(U.pp, 't_pp', '全国区域负责人', 'regional_manager', { regionId: 'region-1' }),
    mkUser(U.regA, 't_regA', '区域负责人', 'regional_manager', { regionId: 'R-A' }),
    mkUser(U.mgr1, 't_mgr1', '一号店长', 'manager', { storeId: 'S1' }),
    mkUser(U.mgr2, 't_mgr2', '二号店长', 'manager', { storeId: 'S2' }),
    mkUser(U.mgr3, 't_mgr3', '三号店长', 'store_manager', { storeId: 'S3' }),
    mkUser(U.sales1, 't_sales1', '一号店销售', 'sales', { storeId: 'S1', employeeId: 'E1' }),
  ]);
  store.writeCollection('members', [
    { id: 'MA1', name: '一号店会员', phone: '09170000001', type: 'retail', level: 'silver', points: 100,
      spend: 1000, storeId: 'S1', storeName: '一号店', status: 'active', createdAt: now(), updatedAt: now(),
      notes: '', pointsExpireAt: null, lastEarnAt: null, lastPurchaseAt: null, earnedTotal: 100, redeemedTotal: 0 },
    { id: 'MB1', name: '二号店会员', phone: '09170000002', type: 'retail', level: 'silver', points: 200,
      spend: 2000, storeId: 'S2', storeName: '二号店', status: 'active', createdAt: now(), updatedAt: now(),
      notes: '', pointsExpireAt: null, lastEarnAt: null, lastPurchaseAt: null, earnedTotal: 200, redeemedTotal: 0 },
  ]);
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

const B = 'http://127.0.0.1:3181';
let cookie = '';
async function req(method, p, body, asUser) {
  if (asUser !== undefined) await login(asUser);
  const o = { method, headers: {} };
  if (body !== undefined && body !== null) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  if (cookie) o.headers.cookie = cookie;
  const r = await fetch(B + p, o);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, data: j };
}
async function login(id) {
  cookie = '';
  const u = (store.readCollection('users') || []).find(x => x.id === id);
  const r = await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u.username, password: PW }),
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  cookie = sc.map(c => c.split(';')[0]).join('; ');
  return r.status;
}
const usersNow = () => store.readCollection('users') || [];
const userById = (id) => usersNow().find(x => x.id === id);
const storesNow = () => store.readCollection('stores') || [];
const storeById = (id) => storesNow().find(x => x.id === id);
const dv = () => store.dataVersion();
const body = (u, n) => ({ username: u, name: n, password: 'Brand#New123' });

(async () => {
  await sleep(800);
  console.log('\n══════ staff.assign 自我停用 / 自我替换 回归测试 ══════\n');

  // ─────────────────────────────────────────────────────────
  console.log('【0】前置：夹具状态符合预期');
  ok('S1.managerId = mgr1（mgr1 是 S1 的现任店长）', storeById('S1').managerId === U.mgr1);
  ok('S2.managerId = mgr2', storeById('S2').managerId === U.mgr2);
  ok('S3.managerId = null（mgr3 是 S3 的店长但未被绑定为 managerId）', storeById('S3').managerId === null);
  ok('mgr1 初始为启用状态', userById(U.mgr1).disabled !== true);

  // ─────────────────────────────────────────────────────────
  console.log('\n【1】★ 核心：店长不能通过「任命店长」流程把自己停用/替换');
  const dv1 = dv();
  let r = await req('POST', '/api/stores/S1/managers', body('brand_new_mgr', '新店长'), U.mgr1);
  ok('S1 现任店长给自己门店任命新店长 → 被拒绝（400）',
    r.status === 400, { status: r.status, err: r.data && r.data.error });
  ok('返回了明确错误信息', !!(r.data && r.data.error), r.data);
  console.log('     错误信息：' + (r.data && r.data.error));

  ok('★ mgr1 自己没有被停用（disabled 仍不是 true）', userById(U.mgr1).disabled !== true,
    userById(U.mgr1).disabled);
  ok('★ mgr1 的 storeId 未被清空', userById(U.mgr1).storeId === 'S1', userById(U.mgr1).storeId);
  ok('★ 门店 S1 的 managerId 未被改动', storeById('S1').managerId === U.mgr1, storeById('S1').managerId);
  ok('★ 没有创建出新账号 brand_new_mgr', !usersNow().some(x => x.username === 'brand_new_mgr'));
  ok('★ users 总数未变（7 个）', usersNow().length === 7, usersNow().length);
  ok('★ dataVersion 未变化（被拒绝的请求不落库）', dv() === dv1, { before: dv1, after: dv() });
  r = await req('GET', '/api/members');
  ok('★ mgr1 的会话仍然有效（GET /api/members → 200），没有被踢出',
    r.status === 200, r.status);

  console.log('\n【2】★ 核心：店长不能通过「解绑」流程把自己停用');
  const dv2 = dv();
  r = await req('DELETE', '/api/stores/S1/managers/' + U.mgr1, null, U.mgr1);
  ok('S1 现任店长解绑自己 → 被拒绝（400）', r.status === 400, { status: r.status, err: r.data && r.data.error });
  console.log('     错误信息：' + (r.data && r.data.error));
  ok('★ mgr1 自己没有被停用', userById(U.mgr1).disabled !== true, userById(U.mgr1).disabled);
  ok('★ mgr1 仍在门店 S1 上', userById(U.mgr1).storeId === 'S1');
  ok('★ 门店 S1 的 managerId 未被清空', storeById('S1').managerId === U.mgr1);
  ok('★ dataVersion 未变化', dv() === dv2, { before: dv2, after: dv() });

  console.log('\n【3】店长用「自己的用户名」重复建号 → 仍被拒绝（原有护栏不回归）');
  r = await req('POST', '/api/stores/S1/managers', body('t_mgr1', '冒充自己'), U.mgr1);
  ok('用自己用户名建号 → 400', r.status === 400, { status: r.status, err: r.data && r.data.error });
  ok('mgr1 没有被改动', userById(U.mgr1).disabled !== true && userById(U.mgr1).name === '一号店长');

  // ─────────────────────────────────────────────────────────
  console.log('\n【4】保持原行为：店长给「自己未被绑定为店长」的门店任命店长 → 仍可用');
  const dv4 = dv();
  r = await req('POST', '/api/stores/S3/managers', body('s3_mgr', '三号店长'), U.mgr3);
  ok('mgr3（S3 的 store_manager，但 S3.managerId=null）任命店长 → 200',
    r.status === 200, { status: r.status, err: r.data && r.data.error });
  const created = r.data && r.data.manager;
  ok('新账号已创建：role=manager、storeId=S3',
    !!created && created.role === 'manager' && created.storeId === 'S3', created);
  ok('返回体不含 password 字段（哈希不外泄）', !(created && 'password' in created));
  ok('门店 S3 的 managerId 已同步为新账号', storeById('S3').managerId === (created && created.id),
    storeById('S3').managerId);
  ok('门店 S3 的 managerName 已同步', storeById('S3').managerName === '三号店长');
  ok('mgr3 自己未被停用（本次操作的「原店长」不是他）', userById(U.mgr3).disabled !== true);
  ok('dataVersion 有变化（成功写入 users + stores）', dv() !== dv4, { before: dv4, after: dv() });

  // ─────────────────────────────────────────────────────────
  console.log('\n【5】保持原行为：admin / 全国区域负责人 任命店长不受影响');
  const dv5 = dv();
  r = await req('POST', '/api/stores/S1/managers', body('admin_appointed', 'admin任命'), U.admin);
  ok('admin 给 S1 任命新店长 → 200（原行为）', r.status === 200, { status: r.status, err: r.data && r.data.error });
  ok('S1 原店长 mgr1 依既有规则被停用（admin 操作不属"自我"场景）',
    userById(U.mgr1).disabled === true, userById(U.mgr1).disabled);
  ok('S1.managerId 已指向新账号', storeById('S1').managerId === (r.data.manager && r.data.manager.id),
    storeById('S1').managerId);
  ok('admin 自己未被停用', userById(U.admin).disabled !== true);

  r = await req('POST', '/api/stores/S2/managers', body('pp_appointed', 'pp任命'), U.pp);
  ok('全国区域负责人给 S2 任命新店长 → 200（原行为）', r.status === 200,
    { status: r.status, err: r.data && r.data.error });
  ok('S2 原店长 mgr2 依既有规则被停用', userById(U.mgr2).disabled === true);
  ok('区域负责人自己未被停用', userById(U.pp).disabled !== true);

  r = await req('DELETE', '/api/stores/S2/managers/' + (userById(U.pp) && (storeById('S2').managerId)), null, U.pp);
  ok('全国区域负责人解绑刚任命的店长 → 200（原行为）', r.status === 200, { status: r.status, err: r.data && r.data.error });

  // ─────────────────────────────────────────────────────────
  console.log('\n【6】跨门店拦截仍然生效（未因本次修改而放宽）');
  r = await req('POST', '/api/stores/S9/managers', body('x', 'x'), U.mgr3);
  ok('店长给不存在的门店任命 → 404', r.status === 404, r.status);
  r = await req('POST', '/api/stores/S2/managers', body('x', 'x'), U.mgr3);
  ok('mgr3（S3）给 S2 任命 → 403（范围拦截）', r.status === 403, { status: r.status, err: r.data && r.data.error });
  r = await req('DELETE', '/api/stores/S2/managers/' + storeById('S2').managerId, null, U.mgr3);
  ok('mgr3 解绑 S2 的店长 → 403', r.status === 403, r.status);

  console.log('\n【7】无 staff.assign 的角色仍被拦；有 staff.assign 的角色行为未变');
  r = await req('POST', '/api/stores/S1/managers', body('y', 'y'), U.sales1);
  ok('sales 任命店长 → 403（无 staff.assign，权限门未放宽）',
    r.status === 403, { status: r.status, err: r.data && r.data.error });
  const dv7 = dv();
  r = await req('POST', '/api/stores/S1/managers', body('regA_appointed', '区域任命'), U.regA);
  ok('regional_manager 给门店任命店长 → 200（不是"操作自己"，原行为不变）',
    r.status === 200, { status: r.status, err: r.data && r.data.error });
  ok('regional_manager 自己未被停用', userById(U.regA).disabled !== true);
  ok('dataVersion 有变化', dv() !== dv7);

  console.log('\n【8】被拒绝的自我操作写入审计日志（便于事后发现异常尝试）');
  // P3（2026-09-22）之后 lib/audit.js 已尊重 SP_DATA_DIR —— 审计日志落在**沙箱**里，
  //   不再写进项目真实 data/audit.log。所以这里读沙箱路径。
  //   （此前那条「忽略 SP_DATA_DIR」的既有问题已修复，见 test/p3-audit-sandbox.test.js）
  const auditPath = path.join(SANDBOX, 'audit.log');
  const readAudit = () => { try { return fs.readFileSync(auditPath, 'utf8'); } catch (e) { return ''; } };
  const aBefore = readAudit();
  // s3_mgr 是 S3 的现任绑定店长（【4】创建），由它自己发起「给自己门店任命新店长」
  const s3user = usersNow().find(x => x.id === created.id);
  ok('（前置）S3 的现任店长 = 刚创建的 s3_mgr，且其 storeId=S3',
    !!s3user && s3user.storeId === 'S3' && storeById('S3').managerId === s3user.id);
  cookie = '';
  const lr = await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: s3user.username, password: 'Brand#New123' }),
  });
  const sc3 = lr.headers.getSetCookie ? lr.headers.getSetCookie() : [];
  cookie = sc3.map(c => c.split(';')[0]).join('; ');
  ok('s3_mgr 登录 → 200', lr.status === 200, lr.status);
  const rr = await req('POST', '/api/stores/S3/managers', body('s3_mgr2', '想替换自己'), undefined);
  ok('★ S3 现任店长给自己门店任命新店长 → 被拒绝（400）', rr.status === 400,
    { status: rr.status, err: rr.data && rr.data.error });
  ok('★ 该店长自己未被停用、门店未被易主',
    usersNow().find(x => x.id === s3user.id).disabled !== true && storeById('S3').managerId === s3user.id);
  ok('★ 没有创建出新账号 s3_mgr2', !usersNow().some(x => x.username === 's3_mgr2'));

  const added = readAudit().slice(aBefore.length);
  ok('审计日志追加了内容', added.length > 0, added.length);
  ok('追加内容里记录了这次被拒绝的自我操作', /拒绝|self|自己/.test(added), added);
  console.log('     本次追加的审计行：');
  added.split('\n').filter(Boolean).forEach(l => console.log('       ' + l));

  console.log(`\n══════ ${pass} passed, ${fail} failed ══════`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.stack); try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e2) {} process.exit(2); });
