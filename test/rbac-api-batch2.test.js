// 第二批迁移（审核 / 商城）的 API 权限测试
// ============================================================
// 用 SP_DATA_DIR 沙箱启动独立实例，绝不碰真实 data/。
// 重点验证（按要求）：
//   · 无 approval.approve → 不能审批
//   · 有 approval.approve + 状态正确 → 可以审批
//   · 有 approval.approve + 已处理状态 → 仍由 L2 业务守卫拒绝（400，不是 403）
//   · Scope 越权继续拒绝
//   · admin / manager 原有行为不丢失
// ============================================================
process.env.PORT = '3141';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rbac-b2-'));
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
    { id: 'S1', name: '一号店', city: '', address: '', managerId: null, managerName: '', phone: '', createdAt: now() },
    { id: 'S2', name: '二号店', city: '', address: '', managerId: null, managerName: '', phone: '', createdAt: now() },
  ]);
  store.writeCollection('users', [
    { id: 'UA', username: 't_admin', password: bcrypt.hashSync('Admin#123', 10), name: '管理员', role: 'admin', storeId: null, phone: '', createdAt: now(), disabled: false },
    { id: 'UM1', username: 't_mgr1', password: bcrypt.hashSync('Mgr#123', 10), name: '一号店店长', role: 'manager', storeId: 'S1', phone: '', createdAt: now(), disabled: false },
    { id: 'UM2', username: 't_mgr2', password: bcrypt.hashSync('Mgr#123', 10), name: '二号店店长', role: 'store_manager', storeId: 'S2', phone: '', createdAt: now(), disabled: false },
    // sales：没有 approval.* / mall.create 等权限，用于无权限场景
    { id: 'US1', username: 't_sales', password: bcrypt.hashSync('Sales#123', 10), name: '销售', role: 'sales', storeId: 'S1', phone: '', createdAt: now(), disabled: false },
  ]);
  const mk = (id, name, phone, storeId) => ({
    id, name, phone, type: 'retail', level: 'silver', points: 5000, spend: 0,
    storeId, storeName: storeId === 'S1' ? '一号店' : '二号店', status: 'active',
    createdAt: now(), updatedAt: now(), notes: '', pointsExpireAt: null,
    lastEarnAt: null, lastPurchaseAt: null, earnedTotal: 5000, redeemedTotal: 0,
  });
  store.writeCollection('members', [
    mk('M1', '会员一号', '09170000001', 'S1'),
    mk('M2', '会员二号', '09170000002', 'S2'),
  ]);
  store.writeCollection('products', [{
    id: 'P1', name: '测试商品', description: '', points: 100, image: null,
    active: true, sort: 0, createdAt: now(), updatedAt: now(),
  }]);
  const pend = (id, memberId, memberName, storeId, status) => ({
    id, kind: 'purchase', memberId, memberName, memberPhone: '', storeId,
    storeName: storeId === 'S1' ? '一号店' : '二号店',
    points: null, estPoints: 100, purchaseAmount: 1000, reason: '测试',
    status, requestedBy: 'UM1', requestedByName: '一号店店长', requestedAt: now(),
    decidedBy: null, decidedByName: null, decidedAt: null, decisionNote: null,
    transactionId: null, grantedPoints: null,
  });
  store.writeCollection('pending', [
    pend('PD1', 'M1', '会员一号', 'S1', 'pending'),   // 用于审批
    pend('PD2', 'M1', '会员一号', 'S1', 'pending'),   // 用于驳回
    pend('PD3', 'M1', '会员一号', 'S1', 'approved'),  // 已处理 → L2 应拒绝
    pend('PD4', 'M2', '会员二号', 'S2', 'pending'),   // 他店 → scope 应拒绝
  ]);
  const rd = (id, memberId, memberName, storeId, status) => ({
    id, productId: 'P1', productName: '测试商品', productImage: null, points: 100,
    memberId, memberName, memberPhone: '', storeId,
    storeName: storeId === 'S1' ? '一号店' : '二号店', status,
    transactionId: null, refundTransactionId: null,
    createdBy: 'UA', createdByName: '管理员', createdAt: now(),
    fulfilledBy: null, fulfilledByName: null, fulfilledAt: null,
    cancelledBy: null, cancelledByName: null, cancelledAt: null,
  });
  store.writeCollection('redemptions', [
    rd('RD1', 'M1', '会员一号', 'S1', 'pending'),    // 可发放 / 可取消
    rd('RD2', 'M1', '会员一号', 'S1', 'fulfilled'),  // 已发放 → L2 应拒绝
    rd('RD3', 'M2', '会员二号', 'S2', 'pending'),    // 他店 → scope 应拒绝
  ]);
  store.writeCollection('transactions', []);
  store.writeCollection('rules', {
    id: 'single', spendPerPoint: 10, expiryMonths: 24, welcomeBonus: 500,
    redeemRatio: '10:1', redeemMaxPercent: 0, redeemMinPoints: 0,
    requireConfirm: false, realtimePush: false,
    levels: [{ key: 'silver', name: 'Silver', threshold: 0, color: '#9CA3AF' }],
    b2bTiers: [], updatedAt: now(),
  });
  store.writeCollection('sheets', { id: 'single', autoSync: false, syncCount: 0 });
  store.writeCollection('_seeded', { id: 'singleton', at: now() });
}

const B = 'http://127.0.0.1:3141';
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

(async () => {
  seed();
  require(APP + '/server.js');
  await sleep(1000);

  console.log('\n══════ 第二批迁移 API 权限测试（审核 / 商城）══════\n');

  // ─────────── 审核 ───────────
  console.log('【审核 · L1 权限】');
  ok('admin 登录', await login('t_admin', 'Admin#123') === 200);
  ok('manager 登录', await login('t_mgr1', 'Mgr#123') === 200);
  let r = await req('POST', '/api/pending/PD1/approve', {});
  ok('无 approval.approve 的店长审批 → 403', r.status === 403, r.status);
  r = await req('POST', '/api/pending/PD2/reject', { note: '不合规' });
  ok('无 approval.reject 的店长驳回 → 403', r.status === 403, r.status);
  r = await req('GET', '/api/pending?status=all');
  ok('店长可查看待审核列表（有 approval.view）', r.status === 200, r.status);

  ok('sales 登录', await login('t_sales', 'Sales#123') === 200);
  r = await req('GET', '/api/pending?status=all');
  ok('sales 无 approval.view → 403', r.status === 403, r.status);
  r = await req('POST', '/api/pending/PD1/approve', {});
  ok('sales 审批 → 403', r.status === 403, r.status);

  console.log('\n【审核 · 正常审批】');
  ok('admin 登录', await login('t_admin', 'Admin#123') === 200);
  r = await req('POST', '/api/pending/PD1/approve', {});
  ok('admin 审批 pending 记录 → 200', r.status === 200, r.data);
  ok('审批后积分已发放', r.data && r.data.member && r.data.member.points > 5000, r.data && r.data.member && r.data.member.points);
  r = await req('POST', '/api/pending/PD2/reject', { note: '不合规' });
  ok('admin 驳回 pending 记录 → 200', r.status === 200, r.data);

  console.log('\n【审核 · L2 业务状态守卫（角色有权限但状态不允许）】');
  r = await req('POST', '/api/pending/PD3/approve', {});
  ok('审批「已 approved」的记录 → 400（L2 拒绝，不是 403）', r.status === 400, r.status);
  ok('L2 拒绝时的错误信息来自业务守卫', r.data && typeof r.data.error === 'string', r.data);
  r = await req('POST', '/api/pending/PD1/approve', {});
  ok('重复审批刚通过的记录 → 400（L2 拒绝）', r.status === 400, r.status);

  console.log('\n【审核 · Scope 越权】');
  ok('manager 登录', await login('t_mgr1', 'Mgr#123') === 200);
  r = await req('POST', '/api/pending/PD4/approve', {});
  ok('店长审批他店申请 → 403（scope）', r.status === 403, r.status);
  r = await req('POST', '/api/pending/PD4/reject', { note: 'x' });
  ok('店长驳回他店申请 → 403（scope）', r.status === 403, r.status);
  r = await req('GET', '/api/pending?status=all');
  const pendStoreIds = (r.data.items || []).map(x => x.storeId);
  ok('店长列表只含本店申请', r.status === 200 && pendStoreIds.every(s => s === 'S1'), pendStoreIds);
  ok('admin 登录', await login('t_admin', 'Admin#123') === 200);
  r = await req('GET', '/api/pending?status=all');
  ok('admin 可看全部门店申请', r.status === 200 && (r.data.items || []).some(x => x.storeId === 'S2'));

  // ─────────── 商城 ───────────
  console.log('\n【商城 · 商品维护】');
  ok('manager 登录', await login('t_mgr1', 'Mgr#123') === 200);
  r = await req('POST', '/api/products', { name: '店长建的商品', points: 50 });
  ok('无 mall.create 的店长建商品 → 403', r.status === 403, r.status);
  r = await req('PUT', '/api/products/P1', { name: '改名' });
  ok('无 mall.edit 的店长改商品 → 403', r.status === 403, r.status);
  r = await req('DELETE', '/api/products/P1');
  ok('无 mall.delete 的店长下架商品 → 403', r.status === 403, r.status);
  r = await req('POST', '/api/products/image', { image: 'data:image/png;base64,iVBORw0KGgo=' });
  ok('无 mall.edit 的店长传图 → 403', r.status === 403, r.status);
  r = await req('GET', '/api/products');
  ok('店长可看商品列表（有 mall.view）', r.status === 200 && (r.data.items || []).length === 1, r.data && r.data.items && r.data.items.length);

  ok('admin 登录', await login('t_admin', 'Admin#123') === 200);
  r = await req('POST', '/api/products', { name: '管理员的商品', points: 60 });
  ok('admin 建商品 → 200', r.status === 200, r.data);
  const newPid = r.data && r.data.product && r.data.product.id;
  r = await req('PUT', '/api/products/' + newPid, { name: '管理员的商品（改）' });
  ok('admin 改商品 → 200', r.status === 200);
  r = await req('DELETE', '/api/products/' + newPid);
  ok('admin 下架商品 → 200', r.status === 200);

  console.log('\n【商城 · 兑换（L1 权限 + Scope）】');
  ok('sales 登录', await login('t_sales', 'Sales#123') === 200);
  r = await req('POST', '/api/redemptions', { memberId: 'M1', productId: 'P1' });
  ok('sales 无 mall.redeem → 403', r.status === 403, r.status);

  ok('manager 登录', await login('t_mgr1', 'Mgr#123') === 200);
  r = await req('POST', '/api/redemptions', { memberId: 'M1', productId: 'P1' });
  ok('店长给本店会员兑换 → 200', r.status === 200, r.data);
  const newRdId = r.data && r.data.redemption && r.data.redemption.id;
  r = await req('POST', '/api/redemptions', { memberId: 'M2', productId: 'P1' });
  ok('店长给他店会员兑换 → 403（scope）', r.status === 403, r.status);
  r = await req('GET', '/api/redemptions?status=all');
  ok('店长兑换单列表只含本店', r.status === 200 && (r.data.items || []).every(x => x.storeId === 'S1'), (r.data.items || []).map(x => x.storeId));

  console.log('\n【商城 · 发放 / 取消（L1 + L2）】');
  r = await req('POST', '/api/redemptions/RD3/fulfill', {});
  ok('店长发放他店兑换单 → 403（scope）', r.status === 403, r.status);
  r = await req('POST', '/api/redemptions/RD3/cancel', {});
  ok('店长取消他店兑换单 → 403（scope）', r.status === 403, r.status);
  r = await req('POST', '/api/redemptions/' + newRdId + '/fulfill', {});
  ok('店长发放本店兑换单 → 200', r.status === 200, r.data);
  r = await req('POST', '/api/redemptions/' + newRdId + '/fulfill', {});
  ok('重复发放已 fulfilled 的单 → 400（L2 拒绝）', r.status === 400, r.status);
  r = await req('POST', '/api/redemptions/RD2/cancel', {});
  ok('取消「已发放」的单 → 400（L2 拒绝）', r.status === 400, r.status);
  r = await req('POST', '/api/redemptions/RD1/cancel', {});
  ok('取消 pending 单 → 200（并自动退分）', r.status === 200, r.data);

  console.log('\n【admin / manager 兼容】');
  ok('旧 manager 账号仍可登录并完成原有商城操作', await login('t_mgr1', 'Mgr#123') === 200);
  r = await req('GET', '/api/products');
  ok('旧 manager 仍可查看商品', r.status === 200);
  ok('admin 登录', await login('t_admin', 'Admin#123') === 200);
  r = await req('GET', '/api/redemptions?status=all');
  ok('admin 仍可看全部兑换单', r.status === 200 && (r.data.items || []).some(x => x.storeId === 'S2'));

  console.log(`\n══════ ${pass} passed, ${fail} failed ══════`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.stack); try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e2) {} process.exit(2); });
