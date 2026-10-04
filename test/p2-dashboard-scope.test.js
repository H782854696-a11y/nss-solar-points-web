// ============================================================
// P2 针对性测试：/api/dashboard 的「门店分布」必须按数据范围过滤
// ============================================================
// 修复前：storeDist 直接用全部门店 → 店长能看到其他门店的**名称**（计数为 0）。
// 修复后：只用 guard.filterList(..., 'store') 的结果。
//
// 本测试起一个沙箱实例（SP_DATA_DIR 指向临时目录），用真实 HTTP 请求验证，
// 并对**整个响应体**做串搜索 —— 只要别的门店名出现就算泄露。
// 绝不触碰真实 data/。
// ============================================================
process.env.PORT = '3191';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-p2-'));
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

function seed() {
  store.writeCollection('stores', [
    { id: 'S1', name: '一号店', regionId: 'R-A', city: '', address: '', managerId: 'U-mgr1', managerName: '一号店长', phone: '', createdAt: now() },
    { id: 'S2', name: '二号店', regionId: 'R-B', city: '', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
    { id: 'S3', name: '三号店', regionId: 'R-C', city: '', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
  ]);
  const mkUser = (id, username, name, role, extra) => Object.assign({
    id, username, password: bcrypt.hashSync(PW, 10), name, role,
    storeId: null, phone: '', createdAt: now(), disabled: false,
  }, extra || {});
  store.writeCollection('users', [
    mkUser('U-admin', 't_admin', '管理员', 'admin'),
    mkUser('U-mgr1', 't_mgr1', '一号店长', 'manager', { storeId: 'S1' }),
  ]);
  const mkMem = (id, name, sid) => ({
    id, name, phone: '091700000' + id.slice(-2), type: 'retail', level: 'silver', points: 10, spend: 100,
    storeId: sid, storeName: sid === 'S1' ? '一号店' : (sid === 'S2' ? '二号店' : '三号店'),
    status: 'active', createdAt: now(), updatedAt: now(), notes: '', pointsExpireAt: null,
    lastEarnAt: null, lastPurchaseAt: null, earnedTotal: 10, redeemedTotal: 0,
  });
  store.writeCollection('members', [
    mkMem('MA1', '一号店会员甲', 'S1'),
    mkMem('MA2', '一号店会员乙', 'S1'),
    mkMem('MB1', '二号店会员甲', 'S2'),
    mkMem('MB2', '二号店会员乙', 'S2'),
    mkMem('MB3', '二号店会员丙', 'S2'),
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

const B = 'http://127.0.0.1:3191';
let cookie = '';
async function login(username) {
  cookie = '';
  const r = await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PW }),
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  cookie = sc.map(c => c.split(';')[0]).join('; ');
  return r.status;
}
async function get(p) {
  const r = await fetch(B + p, { headers: { cookie } });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, data: j };
}

(async () => {
  await sleep(800);
  console.log('\n══════ P2 看板门店范围 针对性测试 ══════\n');

  console.log('【前置】夹具');
  ok('3 家门店', (store.readCollection('stores') || []).length === 3);
  ok('5 名会员（S1 两家 / S2 三家 / S3 零家）', (store.readCollection('members') || []).length === 5);

  // ─────────────────────────────────────────
  console.log('\n【1】店长视角：只看得到自己门店');
  ok('店长登录', await login('t_mgr1') === 200);
  const mgr = await get('/api/dashboard');
  ok('GET /api/dashboard → 200', mgr.status === 200, mgr.status);
  const dist = (mgr.data && mgr.data.storeDist) || [];
  console.log('     storeDist = ' + JSON.stringify(dist));
  ok('★ storeDist 恰好 1 条（只有自己门店）', dist.length === 1, dist);
  ok('★ storeDist[0].storeId = S1', dist[0] && dist[0].storeId === 'S1', dist[0]);
  ok('★ storeDist[0].storeName = 一号店', dist[0] && dist[0].storeName === '一号店', dist[0]);
  ok('★ 会员总数只算本店（2 名）', mgr.data.total === 2, mgr.data.total);
  ok('★ 响应体里**不出现**「二号店」', JSON.stringify(mgr.data).indexOf('二号店') === -1,
    JSON.stringify(mgr.data).slice(0, 300));
  ok('★ 响应体里**不出现**「三号店」', JSON.stringify(mgr.data).indexOf('三号店') === -1);
  ok('★ 响应体里不出现 S2 / S3 的门店 id',
    JSON.stringify(mgr.data).indexOf('"S2"') === -1 && JSON.stringify(mgr.data).indexOf('"S3"') === -1);

  // ─────────────────────────────────────────
  console.log('\n【2】管理员视角：看得到全部门店（修复不能误伤 admin）');
  ok('admin 登录', await login('t_admin') === 200);
  const adm = await get('/api/dashboard');
  ok('GET /api/dashboard → 200', adm.status === 200, adm.status);
  const distA = (adm.data && adm.data.storeDist) || [];
  console.log('     storeDist = ' + JSON.stringify(distA));
  ok('★ admin 仍看到全部 3 家门店', distA.length === 3, distA.length);
  ok('★ admin 的门店名齐全（一号店/二号店/三号店）',
    ['一号店', '二号店', '三号店'].every(n => distA.some(d => d.storeName === n)));
  ok('★ admin 会员总数为 5', adm.data.total === 5, adm.data.total);
  ok('门店分布的 count 与各店会员数一致（S1=2 / S2=3 / S3=0）',
    JSON.stringify(distA.map(d => d.count).sort()) === JSON.stringify([0, 2, 3]),
    distA.map(d => d.count));

  // ─────────────────────────────────────────
  console.log('\n【3】其他统计项不受影响（回归）');
  ok('店长看到 retail/b2b 只基于本店',
    mgr.data.retail + mgr.data.b2b === 2, { retail: mgr.data.retail, b2b: mgr.data.b2b });
  ok('店长看到积分/消费只基于本店会员',
    mgr.data.points === 20 && mgr.data.spend === 200, { points: mgr.data.points, spend: mgr.data.spend });
  ok('趋势 buckets 结构未变（10 桶）', Array.isArray(mgr.data.buckets) && mgr.data.buckets.length === 10);

  // ─────────────────────────────────────────
  console.log('\n【4】未登录仍 401（修复不影响鉴权）');
  cookie = '';
  const anon = await get('/api/dashboard');
  ok('未登录 → 401', anon.status === 401, anon.status);

  console.log(`\n══════ P2 测试 ${pass} passed, ${fail} failed ══════`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.stack); try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e2) {} process.exit(2); });
