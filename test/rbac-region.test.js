// ============================================================
// 区域范围（region scope）修复的回归测试
// ============================================================
// 覆盖三项修复：
//   A · region 范围的角色能访问「本区域」的单条资源，且跨区域仍然拒绝
//       （修复点：lib/rbac-guard.js 的 check() 复用 regionOf() 派生 regionId）
//   B · region 范围的角色建档时不能落到区域外门店
//       （修复点：server.js 的会员创建门店解析）
//   C · 商城入口权限（前端 SCREEN_PERMS 加 mall: 'mall.view'）
//       本文件验证后端语义未变：/api/products 与 /api/redemptions 仍由 mall.view 把关
//
// 沙箱实例，绝不碰真实 data/。重点验证「实际返回的数据」与「实际落库的结果」，
// 而不只是状态码。全部 fail-closed 场景都要求 403/400 且不留数据。
// ============================================================
process.env.PORT = '3178';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rbac-region-'));
process.env.SP_DATA_DIR = SANDBOX;

const APP = path.join(__dirname, '..');
const store = require(APP + '/lib/store');
const rbac = require(APP + '/lib/rbac');
const bcrypt = require(APP + '/node_modules/bcryptjs');

// ── 测试专用「区域范围」探针角色 ──────────────────────────────
// 2026-09-22 组织架构调整后，**生产矩阵里已不再有任何角色使用 region 范围**
// （regional_manager 提升为 philippines：全国只保留 1 名负责人，管辖全部区域/门店）。
// 但本文件要覆盖的 region 分支代码路径**依然保留在代码里**，仍需回归保护：
//   · lib/rbac-guard.js 的 enrichScope()/check() 区域派生（修复 A）
//   · lib/rbac-guard.js 的 filterList('region') 列表过滤
//   · server.js 会员创建的区域门店校验（修复 B）
// 因此注入一个探针角色：**权限集合与生产 regional_manager 完全一致，仅把范围换成 region**。
// 只存在于测试进程内，不进生产配置（与 test/rbac.test.js 的 __probe_region 同一约定）。
const REGION_ROLE = '__probe_region_integration__';
rbac.ROLE_GRANTS[REGION_ROLE] = rbac.ROLE_GRANTS.regional_manager.map(g => ({ p: g.p, s: 'region' }));

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();

const PW = 'Reg#12345';
const USERS = {
  admin: ['t_admin', 'admin'],
  // ⚠ 这 4 个账号用「区域范围探针角色」，不是生产 regional_manager ——
  //   生产 regional_manager 现在是 philippines（全国），见文件头说明。
  regA: ['t_regA', REGION_ROLE],       // regionId = R-A
  regB: ['t_regB', REGION_ROLE],       // regionId = R-B
  regC: ['t_regC', REGION_ROLE],       // regionId = R-C（该区域没有任何门店）
  regNone: ['t_regNone', REGION_ROLE], // 没有 regionId
  mgrA: ['t_mgrA', 'manager'],                // storeId = SA
  mgrB: ['t_mgrB', 'store_manager'],          // storeId = SB
  ph: ['t_ph', 'philippines_manager'],
  sales: ['t_sales', 'sales'],                // storeId = SA
};

function seed() {
  // ⚠ 门店顺序很关键：第一家是 B 区门店，用来证明「未传 storeId」时
  //    区域负责人不会回退到「全连锁第一家门店」。
  store.writeCollection('stores', [
    { id: 'SB', name: 'B区一号店', regionId: 'R-B', city: 'Cebu', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
    { id: 'SA', name: 'A区一号店', regionId: 'R-A', city: 'Manila', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
    { id: 'SC', name: 'A区二号店', regionId: 'R-A', city: 'Manila', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
    { id: 'SD', name: 'D区无区域店', regionId: null, city: '', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
  ]);
  const mkUser = (id, username, name, role, extra) => Object.assign({
    id, username, password: bcrypt.hashSync(PW, 10), name, role,
    storeId: null, phone: '', createdAt: now(), disabled: false,
  }, extra || {});
  store.writeCollection('users', [
    mkUser('U-admin', USERS.admin[0], '管理员', 'admin'),
    mkUser('U-regA', USERS.regA[0], 'A区负责人', REGION_ROLE, { regionId: 'R-A' }),
    mkUser('U-regB', USERS.regB[0], 'B区负责人', REGION_ROLE, { regionId: 'R-B' }),
    mkUser('U-regC', USERS.regC[0], 'C区负责人', REGION_ROLE, { regionId: 'R-C' }),
    mkUser('U-regNone', USERS.regNone[0], '无区域负责人', REGION_ROLE),
    mkUser('U-mgrA', USERS.mgrA[0], 'A区店长', 'manager', { storeId: 'SA' }),
    mkUser('U-mgrB', USERS.mgrB[0], 'B区店长', 'store_manager', { storeId: 'SB' }),
    mkUser('U-ph', USERS.ph[0], '菲律宾负责人', 'philippines_manager'),
    mkUser('U-sales', USERS.sales[0], '销售', 'sales', { storeId: 'SA' }),
  ]);
  const mkMem = (id, name, phone, storeId, points) => ({
    id, name, phone, type: 'retail', level: 'silver', points, spend: points * 10,
    storeId, storeName: storeId, status: 'active',
    createdAt: now(), updatedAt: now(), notes: '', pointsExpireAt: null,
    lastEarnAt: null, lastPurchaseAt: null, earnedTotal: points, redeemedTotal: 0,
  });
  store.writeCollection('members', [
    mkMem('MA1', 'A区会员', '09170000001', 'SA', 5000),
    mkMem('MC1', 'A区二号店会员', '09170000003', 'SC', 5000),
    mkMem('MB1', 'B区会员', '09170000002', 'SB', 5000),
    mkMem('MD1', '无区域店会员', '09170000004', 'SD', 5000),
    mkMem('ME1', '门店不存在的会员', '09170000005', 'S-NOT-EXIST', 5000),
  ]);
  store.writeCollection('transactions', []);
  const mkPending = (id, memberId, memberName, storeId) => ({
    id, kind: 'earn', memberId, memberName, memberPhone: '',
    storeId, storeName: storeId,
    points: 100, purchaseAmount: null, reason: '测试', status: 'pending',
    requestedBy: 'U-mgrA', requestedByName: 'A区店长', requestedByName2: USERS.mgrA[0],
    requestedAt: now(), decidedBy: null, decidedByName: null, decidedAt: null, decisionNote: '',
  });
  store.writeCollection('pending', [
    mkPending('PA1', 'MA1', 'A区会员', 'SA'),
    mkPending('PB1', 'MB1', 'B区会员', 'SB'),
    { ...mkPending('PX1', 'MA1', 'A区会员', null), storeId: undefined },  // 既无 storeId 也无 regionId
  ]);
  store.writeCollection('products', [
    { id: 'P1', name: '测试奖品', points: 100, active: true, stock: 99, createdAt: now(), images: [] },
  ]);
  const mkRedeem = (id, memberId, memberName, storeId) => ({
    id, productId: 'P1', productName: '测试奖品', productImage: null, points: 100,
    memberId, memberName, memberPhone: '', storeId, storeName: storeId,
    status: 'pending', transactionId: null,
    createdBy: 'U-mgrA', createdByName: 'A区店长', createdAt: now(),
    fulfilledBy: null, fulfilledByName: null, fulfilledAt: null,
    cancelledBy: null, cancelledByName: null, cancelledAt: null, cancelReason: '',
  });
  store.writeCollection('redemptions', [
    mkRedeem('RA1', 'MA1', 'A区会员', 'SA'),
    mkRedeem('RB1', 'MB1', 'B区会员', 'SB'),
  ]);
  store.writeCollection('rules', {
    id: 'single', spendPerPoint: 10, expiryMonths: 24, welcomeBonus: 0,
    redeemRatio: '10:1', redeemMaxPercent: 0, redeemMinPoints: 0,
    requireConfirm: false, realtimePush: false,
    levels: [{ key: 'silver', name: 'Silver', threshold: 0, color: '#9CA3AF' }],
    b2bTiers: [], updatedAt: now(), schemaVersion: 4,
  });
  store.writeCollection('expiry-state', { lastRunAt: now(), expiryMonths: 24, expiredMembers: 0, expiredPoints: 0, dryRun: false, nextRunAt: now(), note: '' });
  store.writeCollection('sheets', { id: 'single', autoSync: false, syncCount: 0 });
  store.writeCollection('_seeded', { id: 'singleton', at: now() });
}
seed();
require(APP + '/server.js');

const B = 'http://127.0.0.1:3178';
let cookie = '';
async function req(method, p, body) {
  const o = { method, headers: {} };
  if (body !== undefined && body !== null) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  if (cookie) o.headers.cookie = cookie;
  const r = await fetch(B + p, o);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, data: j };
}
async function login(key) {
  cookie = '';
  const r = await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERS[key][0], password: PW }),
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  cookie = sc.map(c => c.split(';')[0]).join('; ');
  return r.status;
}
const membersNow = () => store.readCollection('members') || [];
const byPhone = (ph) => membersNow().find(m => String(m.phone).replace(/[\s\-()]/g, '') === ph);
let phoneSeq = 0;
const newPhone = () => '0999' + String(1000000 + (++phoneSeq)).slice(1);

(async () => {
  await sleep(700);

  // ═══════════════════════════════════════════════════════════
  console.log('\n【A-1】region 范围：列表与单条资源的访问结果一致（修复前：列表 200 / 单条 403）');
  await login('regA');
  let r = await req('GET', '/api/members');
  let items = (r.data && r.data.items) || [];
  const listIds = items.map(m => m.id).sort();
  ok('A 区负责人列会员 → 200，且只含本区域会员（MA1, MC1）',
    r.status === 200 && JSON.stringify(listIds) === JSON.stringify(['MA1', 'MC1']), { status: r.status, listIds });
  ok('列表不含 B 区会员 MB1', !listIds.includes('MB1'));
  ok('列表不含「门店无区域」的 MD1（fail-closed）', !listIds.includes('MD1'));
  ok('列表不含「门店不存在」的 ME1（fail-closed）', !listIds.includes('ME1'));

  // 单条读取
  r = await req('GET', '/api/members/MA1');
  ok('单条读取本区域会员 MA1 → 200（与列表一致）', r.status === 200, r.status);
  r = await req('GET', '/api/members/MC1');
  ok('单条读取本区域二号店会员 MC1 → 200', r.status === 200, r.status);
  r = await req('GET', '/api/members/MA1/quote');
  ok('实时报价（MA1）→ 200', r.status === 200, r.status);
  r = await req('GET', '/api/members/MA1/transactions');
  ok('会员流水（MA1）→ 200', r.status === 200, r.status);
  r = await req('PUT', '/api/members/MA1', { name: 'A区会员' });
  ok('修改会员（MA1）→ 200', r.status === 200, r.status);
  r = await req('POST', '/api/members/MA1/purchase', { amount: 100 });
  ok('登记消费/发分（MA1）→ 200', r.status === 200, r.status);
  r = await req('POST', '/api/members/MA1/transactions', { type: 'earn', amount: 10, reason: '回归测试' });
  ok('手工补录积分（MA1）→ 200', r.status === 200, r.status);
  r = await req('POST', '/api/redemptions', { memberId: 'MA1', productId: 'P1' });
  ok('会员兑换（MA1）→ 200', r.status === 200, r.status);
  r = await req('POST', '/api/redemptions/RA1/fulfill');
  ok('发放本区域兑换单（RA1 属 SA）→ 200', r.status === 200, { status: r.status, err: r.data && r.data.error });

  // —— 审批列表的 region 过滤（approval.view 在 regional_manager 上是 region 范围）——
  //    注意：前面的 purchase / transactions 也会各自产生一条本区域的待审核记录，
  //    所以这里不写死条数，而是断言「全部属于本区域门店 SA」且「跨区域/无门店的一条都不出现」。
  r = await req('GET', '/api/pending');
  const pend = (r.data && r.data.items) || [];
  const pendIds = pend.map(x => x.id);
  ok('A 区负责人看待审核列表 → 200', r.status === 200, r.status);
  ok('待审核列表里的每一条都属于本区域门店 SA',
    pend.length > 0 && pend.every(x => x.storeId === 'SA'), pend.map(x => x.id + '@' + x.storeId));
  ok('待审核列表含预置的本区域申请 PA1', pendIds.includes('PA1'));
  ok('待审核列表不含 B 区申请 PB1', !pendIds.includes('PB1'));
  ok('待审核列表不含「无 storeId」的 PX1（fail-closed）', !pendIds.includes('PX1'));

  // —— approval.approve / approval.reject 在区域范围角色上并未授予 ——
  //    （矩阵里只有 admin(global) 与 philippines_manager(philippines) 拥有，
  //      因此「region × approval.approve」这个组合当前不存在，403 是正确行为）
  r = await req('POST', '/api/pending/PA1/approve', { note: '同意' });
  ok('区域负责人审批申请 → 403（矩阵中该角色无 approval.approve，符合预期）',
    r.status === 403, { status: r.status, err: r.data && r.data.error });
  r = await req('POST', '/api/pending/PA1/reject', { note: '不行' });
  ok('区域负责人驳回申请 → 403（同上，无 approval.reject）', r.status === 403, r.status);
  ok('矩阵事实：没有「region 或 store 范围」的 approval.approve（该组合不存在）',
    ['admin', 'owner', 'hq_operator', 'philippines_manager', 'regional_manager', 'store_manager',
      'sales', 'warehouse', 'service']
      .filter(k => { const a = rbac.grantsFor(k).find(x => x.p === 'approval.approve'); return a && (a.s === 'region' || a.s === 'store'); })
      .length === 0);
  //    活动路径的 region 派生由 mall.fulfill 等价覆盖（同为 record 型资源 + guard.check(rec)）
  ok('record 型资源的 region 派生已被 mall.fulfill 覆盖（探针角色上为 region 范围）',
    rbac.grantsFor(REGION_ROLE).find(x => x.p === 'mall.fulfill').s === 'region');

  // ═══════════════════════════════════════════════════════════
  console.log('\n【A-2】region 范围：跨区域单条访问全部拒绝');
  const CROSS = [
    ['GET', '/api/members/MB1', null, '单条读取'],
    ['GET', '/api/members/MB1/quote', null, '实时报价'],
    ['GET', '/api/members/MB1/transactions', null, '会员流水'],
    ['PUT', '/api/members/MB1', { name: '越权改名' }, '修改会员'],
    ['POST', '/api/members/MB1/purchase', { amount: 100 }, '登记消费发分'],
    ['POST', '/api/members/MB1/transactions', { type: 'earn', amount: 10, reason: 'x' }, '手工补录积分'],
    ['POST', '/api/redemptions', { memberId: 'MB1', productId: 'P1' }, '会员兑换'],
    ['POST', '/api/pending/PB1/approve', { note: 'x' }, '审批他区域待审核'],
    ['POST', '/api/redemptions/RB1/fulfill', null, '发放他区域兑换单'],
  ];
  let crossBad = [];
  for (const [m, p, body, label] of CROSS) {
    const res = await req(m, p, body);
    if (res.status !== 403) crossBad.push(`${label} ${m} ${p} → ${res.status}`);
  }
  ok(`跨区域 ${CROSS.length} 条路径全部 403`, crossBad.length === 0, crossBad);

  // 跨区域不能真的改到数据
  const mb1 = membersNow().find(x => x.id === 'MB1');
  ok('跨区域 PUT 没有改到 MB1 的姓名', mb1 && mb1.name === 'B区会员', mb1 && mb1.name);

  // ═══════════════════════════════════════════════════════════
  console.log('\n【A-3】fail-closed：拿不到区域归属时一律拒绝');
  r = await req('GET', '/api/members/MD1');
  ok('门店存在但没有 regionId（MD1）→ 403', r.status === 403, r.status);
  r = await req('GET', '/api/members/ME1');
  ok('门店在门店表里不存在（ME1）→ 403', r.status === 403, r.status);
  r = await req('POST', '/api/pending/PX1/approve', { note: 'x' });
  ok('资源既无 storeId 也无 regionId（PX1）→ 403', r.status === 403, r.status);

  await login('regNone');
  r = await req('GET', '/api/members/MA1');
  ok('账号本身没有 regionId → 403', r.status === 403, r.status);
  r = await req('GET', '/api/members');
  const noneItems = (r.data && r.data.items) || [];
  ok('账号没有 regionId 时列表为空（fail-closed，非全量）', r.status === 200 && noneItems.length === 0, noneItems.length);

  // ═══════════════════════════════════════════════════════════
  console.log('\n【A-4】不扩大其他角色的访问范围');
  const MATRIX = [
    // [账号, 期望 MA1(SA/R-A), 期望 MC1(SC/R-A), 期望 MB1(SB/R-B), 期望 MD1(SD 无区域)]
    ['admin', 200, 200, 200, 200],
    ['ph', 200, 200, 200, 200],
    ['regA', 200, 200, 403, 403],
    ['regB', 403, 403, 200, 403],
    ['mgrA', 200, 403, 403, 403],
    ['mgrB', 403, 403, 200, 403],
    ['sales', 200, 403, 403, 403],
  ];
  let wid = [];
  for (const [key, eA, eC, eB, eD] of MATRIX) {
    await login(key);
    const got = [];
    for (const id of ['MA1', 'MC1', 'MB1', 'MD1']) {
      got.push((await req('GET', '/api/members/' + id)).status);
    }
    const expect = [eA, eC, eB, eD];
    if (JSON.stringify(got) !== JSON.stringify(expect)) wid.push(`${key} 期望 ${expect.join('/')} 实得 ${got.join('/')}`);
    else ok(`${key} 单条可见范围正确（${expect.join(' / ')}）`, true);
  }
  ok('没有任何角色的可见范围被扩大', wid.length === 0, wid);

  // store 范围的角色不能因为这次修复而拿到区域内的其他门店
  await login('mgrA');
  r = await req('GET', '/api/members');
  const mgrItems = ((r.data && r.data.items) || []).map(m => m.storeId);
  ok('A 店店长列表仍只含 SA（没有扩展到整个区域）',
    mgrItems.length === 1 && mgrItems[0] === 'SA', mgrItems);

  // ═══════════════════════════════════════════════════════════
  console.log('\n【B-1】region 范围建档：跨区域 storeId 必须被拒绝且不落库');
  await login('regA');
  const p1 = newPhone();
  r = await req('POST', '/api/members', { name: '越权建档甲', phone: p1, storeId: 'SB' });
  ok('传 B 区门店 storeId=SB → 403', r.status === 403, { status: r.status, err: r.data && r.data.error });
  ok('该请求没有落库（按手机号查不到）', !byPhone(p1), byPhone(p1) && byPhone(p1).storeId);

  const p2 = newPhone();
  r = await req('POST', '/api/members', { name: '越权建档乙', phone: p2, storeId: 'SD' });
  ok('传「存在但没有区域」的门店 SD → 403', r.status === 403, r.status);
  ok('SD 请求也没有落库', !byPhone(p2));

  const p3 = newPhone();
  r = await req('POST', '/api/members', { name: '越权建档丙', phone: p3, storeId: 'S-NOT-EXIST' });
  ok('传不存在的门店 → 403', r.status === 403, r.status);
  ok('不存在的门店也没有落库', !byPhone(p3));

  // ═══════════════════════════════════════════════════════════
  console.log('\n【B-2】region 范围建档：未传 storeId 只能落到本区域门店');
  ok('（前置）门店表第一间是 B 区的 SB —— 若回退到全连锁第一家就会落错', (store.readCollection('stores') || [])[0].id === 'SB');

  const p4 = newPhone();
  r = await req('POST', '/api/members', { name: '本区域建档', phone: p4 });
  const m4 = byPhone(p4);
  ok('未传 storeId → 200', r.status === 200, { status: r.status, err: r.data && r.data.error });
  ok('落库门店是「本区域第一家」SA，不是全连锁第一家的 SB', m4 && m4.storeId === 'SA', m4 && m4.storeId);

  const p5 = newPhone();
  r = await req('POST', '/api/members', { name: '本区域二号店建档', phone: p5, storeId: 'SC' });
  const m5 = byPhone(p5);
  ok('传本区域内另一家门店 SC → 200 且落在 SC', r.status === 200 && m5 && m5.storeId === 'SC', m5 && m5.storeId);

  // 区域里没有门店
  await login('regC');
  const p6 = newPhone();
  r = await req('POST', '/api/members', { name: '空区域建档', phone: p6 });
  ok('管辖区域内没有任何门店 → 拒绝（400）', r.status === 400, { status: r.status, err: r.data && r.data.error });
  ok('空区域请求没有落库', !byPhone(p6));
  r = await req('POST', '/api/members', { name: '空区域跨区建档', phone: newPhone(), storeId: 'SA' });
  ok('空区域负责人传别的区域门店 → 403', r.status === 403, r.status);

  // 账号没有 regionId
  await login('regNone');
  const p7 = newPhone();
  r = await req('POST', '/api/members', { name: '无区域账号建档', phone: p7 });
  ok('账号没有 regionId → 403', r.status === 403, { status: r.status, err: r.data && r.data.error });
  ok('账号无 regionId 时没有落库', !byPhone(p7));

  // ═══════════════════════════════════════════════════════════
  console.log('\n【B-3】store 范围仍强制落到自己门店（原有行为不回归）');
  await login('mgrA');
  const p8 = newPhone();
  r = await req('POST', '/api/members', { name: '店长跨店建档', phone: p8, storeId: 'SB' });
  const m8 = byPhone(p8);
  ok('A 店店长传 storeId=SB → 200，但被强制落到 SA', r.status === 200 && m8 && m8.storeId === 'SA', m8 && m8.storeId);
  const p9 = newPhone();
  r = await req('POST', '/api/members', { name: '店长默认建档', phone: p9 });
  const m9 = byPhone(p9);
  ok('A 店店长未传 storeId → 落到 SA', r.status === 200 && m9 && m9.storeId === 'SA', m9 && m9.storeId);

  // ═══════════════════════════════════════════════════════════
  console.log('\n【B-4】global / philippines 行为不回归');
  await login('admin');
  const pa = newPhone();
  r = await req('POST', '/api/members', { name: 'admin指定门店', phone: pa, storeId: 'SB' });
  const ma = byPhone(pa);
  ok('admin 指定 storeId=SB → 200 且落在 SB', r.status === 200 && ma && ma.storeId === 'SB', ma && ma.storeId);
  const pb = newPhone();
  r = await req('POST', '/api/members', { name: 'admin默认门店', phone: pb });
  const mb = byPhone(pb);
  ok('admin 未传 storeId → 仍回退到全连锁第一家门店 SB（原行为）', r.status === 200 && mb && mb.storeId === 'SB', mb && mb.storeId);
  r = await req('POST', '/api/members', { name: 'admin不存在门店', phone: newPhone(), storeId: 'S-NOT-EXIST' });
  ok('admin 传不存在的门店 → 400（原行为）', r.status === 400, r.status);

  await login('ph');
  const pc = newPhone();
  r = await req('POST', '/api/members', { name: 'ph指定门店', phone: pc, storeId: 'SB' });
  const mc = byPhone(pc);
  ok('菲律宾负责人指定 storeId=SB → 200 且落在 SB', r.status === 200 && mc && mc.storeId === 'SB', mc && mc.storeId);

  // ═══════════════════════════════════════════════════════════
  console.log('\n【B-5】落库总复核：不存在区域外门店的越权会员');
  const outside = membersNow().filter(m =>
    m.storeId === 'SB' && /越权建档/.test(String(m.name)));
  ok('所有被拒绝的越权建档请求都不存在于库里', outside.length === 0,
    outside.map(m => `${m.name}@${m.storeId}`));
  const badStores = membersNow().filter(m => m.storeId === 'S-NOT-EXIST' || m.storeId === 'SD');
  const badStoresNew = badStores.filter(m => /建档/.test(String(m.name)));
  ok('本次测试新增的会员里没有指向「不存在门店」或「无区域门店」的',
    badStoresNew.length === 0, badStoresNew.map(m => m.name + '@' + m.storeId));
  ok('库里指向「不存在门店 / 无区域门店」的只有 2 条预置数据（MD1@SD、ME1@S-NOT-EXIST）',
    badStores.length === 2 &&
    JSON.stringify(badStores.map(m => m.id).sort()) === JSON.stringify(['MD1', 'ME1']),
    badStores.map(m => m.id + '@' + m.storeId));

  // ═══════════════════════════════════════════════════════════
  console.log('\n【C】商城后端语义未变：仍由 mall.view 把关（前端入口权限由浏览器层验证）');
  const MALL = [
    ['admin', 200], ['ph', 200], ['regA', 200],
    ['mgrA', 200], ['mgrB', 200], ['sales', 200],
  ];
  let mallBad = [];
  for (const [key, exp] of MALL) {
    await login(key);
    const a = await req('GET', '/api/products');
    const b = await req('GET', '/api/redemptions?status=all');
    if (a.status !== exp || b.status !== exp) mallBad.push(`${key}: products=${a.status} redemptions=${b.status} 期望 ${exp}`);
  }
  ok('有 mall.view 的 6 个角色都能读商品与兑换单（商城功能不回归）', mallBad.length === 0, mallBad);

  // owner / hq_operator / service 本来就无 mall.view —— 与权限表一致
  const NO_MALL = rbac.grantsFor('owner').concat(rbac.grantsFor('hq_operator'), rbac.grantsFor('service'))
    .filter(g => g.p === 'mall.view');
  ok('owner / hq_operator / service 在权限表中确实没有 mall.view', NO_MALL.length === 0, NO_MALL);

  // ═══════════════════════════════════════════════════════════
  console.log('\n【D】新组织架构：生产矩阵的 region 范围已全部下线（仅由探针角色覆盖）');
  ok('生产 regional_manager 授权全部为 philippines（原为 region）',
    rbac.grantsFor('regional_manager').length > 0 &&
    rbac.grantsFor('regional_manager').every(g => g.s === 'philippines'),
    rbac.grantsFor('regional_manager').filter(g => g.s !== 'philippines').map(g => g.p + ':' + g.s));
  ok('生产矩阵里没有任何 9 大角色使用 region 范围',
    ['admin', 'owner', 'hq_operator', 'philippines_manager', 'regional_manager',
      'store_manager', 'sales', 'warehouse', 'service']
      .every(k => rbac.grantsFor(k).every(g => g.s !== 'region')));
  ok('store_manager 仅本人整改执行权限为 self，其余授权为 store',
    rbac.grantsFor('store_manager').some(g => g.p === 'workflow.execute' && g.s === 'self') &&
    rbac.grantsFor('store_manager').every(g => g.s === 'store' || (g.p === 'workflow.execute' && g.s === 'self')));
  ok('admin 仍为 global（68 项 = 69 权限 - kingdee.edit）',
    rbac.grantsFor('admin').length === rbac.PERMISSIONS.length - 1 &&
    rbac.grantsFor('admin').every(g => g.s === 'global'));
  ok('owner / hq_operator / philippines_manager 的范围均未被本次改动触及',
    rbac.grantsFor('owner').every(g => g.s === 'global') &&
    rbac.grantsFor('hq_operator').every(g => g.s === 'philippines') &&
    rbac.grantsFor('philippines_manager').every(g => g.s === 'philippines'));
  ok('探针角色与生产 regional_manager 的权限集合完全一致（仅范围不同）',
    JSON.stringify(rbac.grantsFor(REGION_ROLE).map(g => g.p)) ===
    JSON.stringify(rbac.grantsFor('regional_manager').map(g => g.p)));

  // philippines 范围「不要求资源带 regionId」——这正是全国负责人能跨区域的原因
  await login('ph');
  const phStores = ((await req('GET', '/api/stores')).data || {}).items || [];
  ok('philippines 范围可见全部 4 家门店（含无区域门店 SD）——区域限制已解除',
    phStores.length === 4, phStores.map(s => s.id));
  const phMemberIds = ((await req('GET', '/api/members')).data || {}).items.map(m => m.id);
  ok('philippines 范围可见跨区域 / 无区域门店的会员（MB1@R-B、MD1@无区域、ME1@门店不存在）',
    ['MA1', 'MC1', 'MB1', 'MD1', 'ME1'].every(id => phMemberIds.includes(id)), phMemberIds);
  // 对照组：区域范围探针角色看不到 MB1/MD1/ME1 —— 证明「范围比较」真的在起作用
  await login('regA');
  const regMemberIds = ((await req('GET', '/api/members')).data || {}).items.map(m => m.id);
  ok('对照组：区域范围角色看不到 MB1(R-B) / MD1(无区域) / ME1(门店不存在)',
    !regMemberIds.includes('MB1') && !regMemberIds.includes('MD1') && !regMemberIds.includes('ME1'),
    regMemberIds);

  console.log(`\n══════ ${pass} passed, ${fail} failed ══════`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.stack); try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e2) {} process.exit(2); });
