// 第一批迁移（会员 / 积分）的 API 权限测试
// ============================================================
// 用 SP_DATA_DIR 沙箱启动一个独立服务实例，**绝不碰真实 data/**。
// 覆盖 9 个已迁移 API × 4 类场景：
//   ① 正常允许  ② 无权限  ③ Scope 越权  ④ 敏感字段越权
// ============================================================
process.env.PORT = '3131';
const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠ 必须在 require server.js 之前设置，让 store/db 指向沙箱
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rbac-api-'));
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

// ---------- 播种测试数据 ----------
function seed() {
  store.writeCollection('stores', [
    { id: 'S1', name: '一号店', city: '', address: '', managerId: null, managerName: '', phone: '', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'S2', name: '二号店', city: '', address: '', managerId: null, managerName: '', phone: '', createdAt: '2026-01-01T00:00:00.000Z' },
  ]);
  store.writeCollection('users', [
    { id: 'UA', username: 't_admin', password: bcrypt.hashSync('Admin#123', 10), name: '管理员', role: 'admin', storeId: null, phone: '', createdAt: '2026-01-01T00:00:00.000Z', disabled: false },
    // 旧角色 manager —— 验证兼容映射
    { id: 'UM1', username: 't_mgr1', password: bcrypt.hashSync('Mgr#123', 10), name: '一号店店长', role: 'manager', storeId: 'S1', phone: '', createdAt: '2026-01-01T00:00:00.000Z', disabled: false },
    // 新角色 store_manager
    { id: 'UM2', username: 't_mgr2', password: bcrypt.hashSync('Mgr#123', 10), name: '二号店店长', role: 'store_manager', storeId: 'S2', phone: '', createdAt: '2026-01-01T00:00:00.000Z', disabled: false },
  ]);
  const mk = (id, name, phone, storeId, extra) => Object.assign({
    id, name, phone, type: 'retail', level: 'silver', points: 100, spend: 0,
    storeId, storeName: storeId === 'S1' ? '一号店' : '二号店', status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    notes: '', pointsExpireAt: null, lastEarnAt: null, lastPurchaseAt: null,
    earnedTotal: 100, redeemedTotal: 0,
  }, extra || {});
  store.writeCollection('members', [
    mk('M1', '会员一号', '09170000001', 'S1'),
    mk('M2', '会员二号', '09170000002', 'S2'),
  ]);
  store.writeCollection('transactions', []);
  store.writeCollection('pending', []);
  store.writeCollection('products', []);
  store.writeCollection('redemptions', []);
  store.writeCollection('rules', {
    id: 'single', spendPerPoint: 10, expiryMonths: 24, welcomeBonus: 500,
    redeemRatio: '10:1', redeemMaxPercent: 0, redeemMinPoints: 0,
    requireConfirm: false, realtimePush: false,
    levels: [{ key: 'silver', name: 'Silver', threshold: 0, color: '#9CA3AF' }],
    b2bTiers: [], updatedAt: '2026-01-01T00:00:00.000Z',
  });
  store.writeCollection('sheets', { id: 'single', autoSync: false, syncCount: 0 });
  store.writeCollection('_seeded', { id: 'singleton', at: new Date().toISOString() });
}

const B = 'http://127.0.0.1:3131';
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
  require(APP + '/server.js');       // 启动沙箱实例
  await sleep(1000);

  console.log('\n══════ 第一批迁移 API 权限测试 ══════\n');

  // ---------- ① 正常允许 ----------
  console.log('【① 正常允许】');
  ok('admin 登录成功', await login('t_admin', 'Admin#123') === 200);
  let r = await req('GET', '/api/members?page=1&pageSize=50');
  ok('admin 可看全部会员（global）', r.status === 200 && r.data.total === 2, r.data && r.data.total);
  r = await req('GET', '/api/members/M1');
  ok('admin 可看任意会员详情', r.status === 200);
  r = await req('GET', '/api/members/M1/quote?purchaseAmount=1000');
  ok('admin 可查报价', r.status === 200 && r.data.earn.points === 100);

  ok('旧角色 manager 登录成功（兼容）', await login('t_mgr1', 'Mgr#123') === 200);
  r = await req('GET', '/api/members?page=1&pageSize=50');
  const ids = (r.data.items || []).map(x => x.id);
  ok('manager 列表只剩本店会员（scope 生效）', r.status === 200 && ids.length === 1 && ids[0] === 'M1', ids);
  r = await req('GET', '/api/members/M1');
  ok('manager 可看本店会员', r.status === 200);
  r = await req('GET', '/api/members/M1/quote?purchaseAmount=1000');
  ok('manager 可查本店会员报价', r.status === 200);
  r = await req('GET', '/api/members/M1/transactions');
  ok('manager 可看本店会员流水', r.status === 200);

  // ---------- ③ Scope 越权 ----------
  console.log('\n【③ Scope 越权：store_manager 不能碰其他 Store】');
  r = await req('GET', '/api/members/M2');
  ok('不能访问其他 Store 会员详情（403）', r.status === 403, r.status);
  r = await req('PUT', '/api/members/M2', { name: '黑客改名' });
  ok('不能修改其他 Store 会员（403）', r.status === 403, r.status);
  r = await req('GET', '/api/members/M2/quote?purchaseAmount=1000');
  ok('不能查其他 Store 会员报价（403）', r.status === 403, r.status);
  r = await req('GET', '/api/members/M2/transactions');
  ok('不能看其他 Store 会员流水（403）', r.status === 403, r.status);
  r = await req('POST', '/api/members/M2/purchase', { amount: 1000 });
  ok('不能给其他 Store 会员登记消费（403）', r.status === 403, r.status);
  r = await req('POST', '/api/members/M2/transactions', { type: 'earn', amount: 10 });
  ok('不能给其他 Store 会员记流水（403）', r.status === 403, r.status);
  r = await req('DELETE', '/api/members/M2');
  ok('不能删除其他 Store 会员（403）', r.status === 403, r.status);
  // 确认 M2 原封不动
  await login('t_admin', 'Admin#123');
  const m2 = (await req('GET', '/api/members/M2')).data;
  ok('其他 Store 会员数据未被改动', m2 && m2.name === '会员二号' && m2.points === 100, m2);

  // ---------- ④ 敏感字段 ----------
  console.log('\n【④ 敏感字段：有 member.edit ≠ 有 member.manage】');
  ok('manager（旧角色）登录', await login('t_mgr1', 'Mgr#123') === 200);
  r = await req('PUT', '/api/members/M1', { name: '正常改名', spend: 999999 });
  ok('manager 改名成功', r.status === 200, r.data);
  ok('但 spend 未被写入（敏感字段被过滤）', r.data.member && r.data.member.spend === 0, r.data.member && r.data.member.spend);
  r = await req('PUT', '/api/members/M1', { type: 'b2b' });
  ok('type 未被写入', r.data.member && r.data.member.type === 'retail', r.data.member && r.data.member.type);
  r = await req('PUT', '/api/members/M1', { storeId: 'S2' });
  ok('storeId 未被写入（不能把会员偷到别店）', r.data.member && r.data.member.storeId === 'S1', r.data.member && r.data.member.storeId);
  r = await req('PUT', '/api/members/M1', { status: 'frozen' });
  ok('status 未被写入', r.data.member && r.data.member.status === 'active', r.data.member && r.data.member.status);
  r = await req('PUT', '/api/members/M1', { points: 999999 });
  ok('points 未被写入（无 points.adjust）', r.data.member && r.data.member.points === 100, r.data.member && r.data.member.points);
  r = await req('PUT', '/api/members/M1', { notes: '备注可改' });
  ok('notes 可改（基础字段）', r.data.member && r.data.member.notes === '备注可改');

  ok('admin 登录', await login('t_admin', 'Admin#123') === 200);
  r = await req('PUT', '/api/members/M1', { spend: 12345 });
  ok('admin（有 member.manage）可改 spend', r.data.member && r.data.member.spend === 12345, r.data.member && r.data.member.spend);
  r = await req('PUT', '/api/members/M1', { points: 777 });
  ok('admin（有 points.adjust）可改积分并留痕', r.data.member && r.data.member.points === 777, r.data.member && r.data.member.points);

  // ---------- ② 无权限 ----------
  console.log('\n【② 无权限：store_manager 没有 delete / adjust】');
  ok('manager 登录', await login('t_mgr1', 'Mgr#123') === 200);
  r = await req('DELETE', '/api/members/M1');
  ok('manager 删除会员 → 403（无 member.delete）', r.status === 403, r.status);
  r = await req('POST', '/api/members/M1/transactions', { type: 'adjust', amount: -50 });
  ok('manager 做 adjust 流水 → 403（无 points.adjust）', r.status === 403, r.status);

  // ---------- 直发 vs 审核 ----------
  console.log('\n【直发 vs 进审核】');
  r = await req('POST', '/api/members/M1/purchase', { amount: 1000 });
  ok('manager 登记消费 → 进待审核（pending=true）', r.status === 200 && r.data.pending === true, r.data);
  r = await req('POST', '/api/members/M1/transactions', { type: 'earn', amount: 10 });
  ok('manager 手工补录 → 进待审核（pending=true）', r.status === 200 && r.data.pending === true, r.data);
  ok('admin 登录', await login('t_admin', 'Admin#123') === 200);
  r = await req('POST', '/api/members/M1/purchase', { amount: 1000 });
  ok('admin 登记消费 → 直接生效（无 pending）', r.status === 200 && r.data.pending !== true, r.data && r.data.pending);

  // ---------- 建档：门店强制 + 敏感字段 ----------
  console.log('\n【建档：门店强制与敏感字段】');
  ok('manager 登录', await login('t_mgr1', 'Mgr#123') === 200);
  r = await req('POST', '/api/members', { name: '测试会员', phone: '09170000101', storeId: 'S2', spend: 50000, points: 50000 });
  ok('建档成功', r.status === 200, r.data);
  ok('门店被强制为本店 S1（不信任入参）', r.data.member && r.data.member.storeId === 'S1', r.data.member && r.data.member.storeId);
  ok('spend 归零（防建档刷分）', r.data.member && r.data.member.spend === 0, r.data.member && r.data.member.spend);
  ok('未发放期初积分（防建档刷分）', r.data.member && r.data.member.points === 0, r.data.member && r.data.member.points);
  ok('admin 登录', await login('t_admin', 'Admin#123') === 200);
  r = await req('POST', '/api/members', { name: '管理员建档', phone: '09170000102', storeId: 'S2', spend: 100 });
  ok('admin 可指定门店建档', r.status === 200 && r.data.member.storeId === 'S2', r.data.member && r.data.member.storeId);
  ok('admin 建档可带 spend', r.data.member && r.data.member.spend === 100, r.data.member && r.data.member.spend);

  // ---------- 兼容 ----------
  console.log('\n【admin / manager 兼容】');
  r = await req('GET', '/api/members?page=1&pageSize=50');
  ok('admin 仍可看全部会员', r.status === 200 && r.data.total >= 3, r.data && r.data.total);
  ok('旧 manager 账号仍可登录并操作本店', await login('t_mgr1', 'Mgr#123') === 200);
  r = await req('GET', '/api/members/M1');
  ok('旧 manager 仍能访问本店会员（原功能不丢）', r.status === 200);

  console.log(`\n══════ ${pass} passed, ${fail} failed ══════`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.stack); try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e2) {} process.exit(2); });
