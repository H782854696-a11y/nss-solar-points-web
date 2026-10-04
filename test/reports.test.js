// test/reports.test.js
// 报表聚合函数回归测试
//
// 用法：node test/reports.test.js
//
// 设计原则：测试数据全部内联在本文件里（不读 data/）。
// 报表函数的入参本来就是纯数据快照，读线上 data/ 会让断言随真实业务数据漂移，
// 在本地/服务器上跑出不同结果。需要针对真实数据核对时，用 API 自检而不是单测。

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const { overview } = require(path.join(ROOT, 'lib/reports'));

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { console.log('  ✅', name); pass++; }
  else { console.log('  ❌', name, 'got:', JSON.stringify(got)); fail++; }
};

const day = 86400000;
const genDaysAgo = (n) => new Date(Date.now() - n * day).toISOString();

// ==================== 固定样本数据 ====================
const rules = { spendPerPoint: 10, redeemRatio: '10:1', redeemMaxPercent: 0, redeemMinPoints: 0 };

const stores = [
  { id: 's1', name: 'Manila Flagship Store', city: 'Manila' },
  { id: 's2', name: 'Quezon City Branch', city: 'Quezon City' },
  { id: 's3', name: 'Cebu Branch', city: 'Cebu City' },
  { id: 's4', name: 'Davao Branch', city: 'Davao City' },
];

const members = [
  { id: 'm1', name: 'Maria Santos', phone: '0917 111 1111', storeId: 's1', storeName: 'Manila Flagship Store', type: 'retail', level: 'platinum', points: 58240, spend: 486200, status: 'active', createdAt: genDaysAgo(3) },
  { id: 'm2', name: 'Juan Dela Cruz', phone: '0917 222 2222', storeId: 's2', storeName: 'Quezon City Branch', type: 'retail', level: 'gold', points: 21306, spend: 152800, status: 'active', createdAt: genDaysAgo(3) },
  { id: 'm3', name: 'SunPower Installers', phone: '0917 333 3333', storeId: 's3', storeName: 'Cebu Branch', type: 'b2b', level: 'partner', points: 342500, spend: 2845000, status: 'active', createdAt: genDaysAgo(3) },
  { id: 'm4', name: 'Ana Reyes', phone: '0917 444 4444', storeId: 's4', storeName: 'Davao Branch', type: 'retail', level: 'silver', points: 8420, spend: 36900, status: 'active', createdAt: genDaysAgo(3) },
  { id: 'm5', name: 'Cebu Solar Trading', phone: '0917 555 5555', storeId: 's3', storeName: 'Cebu Branch', type: 'b2b', level: 'partner', points: 512800, spend: 5120000, status: 'frozen', createdAt: genDaysAgo(3) },
];

const mkTx = (memberId, type, amount, daysAgo, extra = {}) => ({
  id: 't-' + Math.random().toString(36).slice(2, 9),
  memberId, type, amount,
  createdAt: new Date(Date.now() - daysAgo * day).toISOString(),
  ...extra,
});

// ==================== 用例 ====================

console.log('\n【1】空数据不应抛错，返回结构化全零值');
const empty = overview({});
ok('membersTotal=0', empty.summary.membersTotal === 0, empty.summary.membersTotal);
ok('liabilityPHP=0', empty.summary.liabilityPHP === 0, empty.summary.liabilityPHP);
ok('storeRanking=[]', Array.isArray(empty.storeRanking) && empty.storeRanking.length === 0, empty.storeRanking.length);
ok('monthlyTrend.length=6', empty.monthlyTrend.length === 6, empty.monthlyTrend.length);
ok('sleepCount=0', empty.sleepCount === 0, empty.sleepCount);

console.log('\n【2】无流水基线：积分负债与会员构成');
const base = overview({ members, stores, rules, transactions: [], now: Date.now() });
const expectLiability = members.reduce((s, m) => s + (Number(m.points) || 0), 0) * 0.1;
ok('liabilityPHP = sum(points)*0.1', Math.abs(base.summary.liabilityPHP - expectLiability) < 0.01, { got: base.summary.liabilityPHP, expect: expectLiability });
ok('pointsOutstanding = 943,266', base.summary.pointsOutstanding === 943266, base.summary.pointsOutstanding);
ok('membersTotal=5', base.summary.membersTotal === 5, base.summary.membersTotal);
ok('membersActive=4 / Frozen=1', base.summary.membersActive === 4 && base.summary.membersFrozen === 1, base.summary);
ok('membersRetail=3', base.summary.membersRetail === 3, base.summary.membersRetail);
ok('membersB2B=2', base.summary.membersB2B === 2, base.summary.membersB2B);
ok('pointValue=0.1（来自 redeemRatio 10:1）', base.summary.pointValue === 0.1, base.summary.pointValue);
ok('activity30 txCount=0', base.activity30.txCount === 0, base.activity30.txCount);

console.log('\n【3】门店排行：4 店都出现，按 30 天发放积分降序');
ok('storeRanking.length=4', base.storeRanking.length === 4, base.storeRanking.length);
ok('均为 0 earn30（无流水）', base.storeRanking.every(r => r.earn30 === 0), base.storeRanking.map(r => r.earn30));
ok('每店带 memberCount / spendTotal', base.storeRanking.every(r => typeof r.memberCount === 'number' && typeof r.spendTotal === 'number'), base.storeRanking[0]);

console.log('\n【4】Top10 客户：按累计消费降序');
ok('topSpenders.length=5（5 会员）', base.topSpenders.length === 5, base.topSpenders.length);
ok('topSpenders 已排序', base.topSpenders.every((x, i) => i === 0 || x.spend <= base.topSpenders[i - 1].spend), 'not sorted');
ok('Top1 是 Cebu Solar Trading（spend 5,120,000）', base.topSpenders[0].name === 'Cebu Solar Trading', base.topSpenders[0].name);

console.log('\n【5】沉睡名单：5 会员都 created=3 天前、从未消费，<30 天门槛 → 全不沉睡');
ok('sleepCount=0（都太新）', base.sleepCount === 0, base.sleepCount);
ok('sleepList 为空数组', Array.isArray(base.sleepList) && base.sleepList.length === 0, base.sleepList);

console.log('\n【5b】沉睡名单：从未消费且注册 40 天 → 计入沉睡');
// m5 本身是 frozen，这里先全部置为 active，单独验证「注册久且无消费」这条规则
const aged = members.map(m => ({ ...m, status: 'active', createdAt: genDaysAgo(40) }));
const agedRes = overview({ members: aged, stores, rules, transactions: [], now: Date.now() });
ok('sleepCount=5（全部超 30 天未消费）', agedRes.sleepCount === 5, agedRes.sleepCount);
ok('kind=register', agedRes.sleepList.every(s => s.kind === 'register'), agedRes.sleepList[0]);

console.log('\n【5c】沉睡名单：冻结会员不计入');
const agedFrozen = aged.map(m => (m.id === 'm5' ? { ...m, status: 'frozen' } : m));
ok('sleepCount=4（冻结的 Cebu Solar Trading 排除）', overview({ members: agedFrozen, stores, rules, transactions: [], now: Date.now() }).sleepCount === 4, overview({ members: agedFrozen, stores, rules, transactions: [], now: Date.now() }).sleepCount);

console.log('\n【6】等级构成 / 类型构成');
ok('platinum=1', base.levelDist.platinum === 1, base.levelDist.platinum);
ok('gold=1', base.levelDist.gold === 1, base.levelDist.gold);
ok('silver=1', base.levelDist.silver === 1, base.levelDist.silver);
ok('partner=2', base.levelDist.partner === 2, base.levelDist.partner);
ok('typeDist.retail=3', base.typeDist.retail === 3, base.typeDist);
ok('typeDist.b2b=2', base.typeDist.b2b === 2, base.typeDist);

console.log('\n【7】月度趋势：6 个月');
ok('monthlyTrend.length=6', base.monthlyTrend.length === 6, base.monthlyTrend.length);
ok('每个桶含 earn/redeem/spend', base.monthlyTrend.every(b => 'earn' in b && 'redeem' in b && 'spend' in b), base.monthlyTrend[0]);

console.log('\n【8】构造历史流水：30 天活跃 + 复购');
const synthTxs = [];
// Maria (platinum, s1) 30 天内 4 次消费
[1, 5, 10, 20].forEach((d, i) => synthTxs.push(mkTx('m1', 'earn', 5000 + i * 1000, d, { purchaseAmount: (5000 + i * 1000) * 10 })));
// Juan (gold, s2) 30 天内 2 次消费（复购）
[3, 18].forEach((d, i) => synthTxs.push(mkTx('m2', 'earn', 3000 + i * 500, d, { purchaseAmount: (3000 + i * 500) * 10 })));
// Ana (silver, s4) 30 天内 1 次消费（不计入复购）
synthTxs.push(mkTx('m4', 'earn', 1500, 8, { purchaseAmount: 15000 }));
// Ana 70 天前 1 次（在 30 天窗口外）
synthTxs.push(mkTx('m4', 'earn', 2000, 70, { purchaseAmount: 20000 }));
// Maria 一次核销
synthTxs.push(mkTx('m1', 'redeem', -1000, 2));

const nowMs = Date.now();
const withTxs = overview({ members, stores, rules, transactions: synthTxs, now: nowMs });
// 4 earn(Maria) + 2 earn(Juan) + 1 earn(Ana) + 1 redeem(Maria) = 8 笔
ok('txCount30=8（含 redeem）', withTxs.activity30.txCount === 8, withTxs.activity30.txCount);
ok('activeMembers30=3（只有 earn 算活跃）', withTxs.activity30.activeMembers === 3, withTxs.activity30.activeMembers);
ok('repeatBuyers30=2（Maria+Juan）', withTxs.activity30.repeatBuyers === 2, withTxs.activity30.repeatBuyers);
ok('repeatRate30 ≈ 0.667（复购率）', Math.abs(withTxs.activity30.repeatRate - 2 / 3) < 0.01, withTxs.activity30.repeatRate);
// Maria: 50k+60k+70k+80k = 260k; Juan: 30k+35k = 65k; Ana: 15k → 合计 340k
ok('spend30 = 340,000', withTxs.activity30.spendPHP === 340000, withTxs.activity30.spendPHP);
// Maria: 5k+6k+7k+8k = 26k; Juan: 3k+3.5k = 6.5k; Ana: 1.5k → 合计 34k
ok('earn30=34,000', withTxs.activity30.earnPoints === 34000, withTxs.activity30.earnPoints);
ok('redeem30=1,000', withTxs.activity30.redeemPoints === 1000, withTxs.activity30.redeemPoints);

console.log('\n【9】门店排行：Manila（Maria 所在店）排第一');
console.log('  ', withTxs.storeRanking.map(r => `${r.storeName}=${r.earn30}`).join(' / '));
ok('发放积分最多的店排第一', withTxs.storeRanking[0].storeId === 's1', withTxs.storeRanking[0].storeId);
ok('earn30 降序', withTxs.storeRanking.every((r, i) => i === 0 || r.earn30 <= withTxs.storeRanking[i - 1].earn30), withTxs.storeRanking.map(r => r.earn30));

console.log('\n【10】沉睡名单：Maria/Juan/Ana 近 30 天都有消费 → 全不沉睡');
ok('sleepCount=0', withTxs.sleepCount === 0, withTxs.sleepCount);
ok('Maria 不在列', !withTxs.sleepList.map(s => s.name).includes('Maria Santos'), withTxs.sleepList.map(s => s.name));

console.log('\n【11】即将过期：未设 pointsExpireAt → 全空');
ok('expiringSoonCount=0', withTxs.expiringSoonCount === 0, withTxs.expiringSoonCount);

console.log('\n【11b】即将过期：20 天后到期 → 命中；200 天后 → 不命中');
const expiring = members.map(m => (m.id === 'm1' ? { ...m, pointsExpireAt: new Date(nowMs + 20 * day).toISOString() } : m));
const expiringRes = overview({ members: expiring, stores, rules, transactions: [], now: nowMs });
ok('expiringSoonCount=1', expiringRes.expiringSoonCount === 1, expiringRes.expiringSoonCount);
ok('daysLeft=20', expiringRes.expiringSoon[0].daysLeft === 20, expiringRes.expiringSoon[0]);
const farOut = members.map(m => (m.id === 'm1' ? { ...m, pointsExpireAt: new Date(nowMs + 200 * day).toISOString() } : m));
ok('200 天后到期 → 不计入', overview({ members: farOut, stores, rules, transactions: [], now: nowMs }).expiringSoonCount === 0);

console.log('\n【12】店长视角：只传本店数据时，排行/负债只算本店');
const s1Members = members.filter(m => m.storeId === 's1');
const mgr = overview({ members: s1Members, stores: [stores[0]], rules, transactions: [], now: nowMs });
ok('membersTotal=1', mgr.summary.membersTotal === 1, mgr.summary.membersTotal);
ok('storeRanking.length=1', mgr.storeRanking.length === 1, mgr.storeRanking.length);
ok('liabilityPHP=5,824（仅 Maria）', mgr.summary.liabilityPHP === 5824, mgr.summary.liabilityPHP);

console.log(`\n====== ${pass} passed, ${fail} failed ======`);
process.exit(fail ? 1 : 0);
