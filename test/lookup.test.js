// test/lookup.test.js
// 会员积分自助查询（公开接口）的纯函数回归测试
//
// 用法：node test/lookup.test.js
//
// 设计原则：测试数据全部内联（不读 data/）。这个模块是**对外公开接口的核心**，
// 断言必须锁死两件事：① 双因子（手机号 + 姓名）真的拦得住；② 返回体绝不外泄内部字段。

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const L = require(path.join(ROOT, 'lib/lookup'));

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { console.log('  ✅', name); pass++; }
  else { console.log('  ❌', name, 'got:', JSON.stringify(got)); fail++; }
};

const day = 86400000;
const NOW = new Date('2026-09-18T12:00:00.000Z').getTime();
const ago = (n) => new Date(NOW - n * day).toISOString();

// ==================== 固定样本 ====================
// 等级门槛与 lib/seed.js 的 DEFAULT_LEVELS / DEFAULT_B2B_TIERS 保持一致
const rules = {
  spendPerPoint: 10,
  redeemRatio: '10:1',
  redeemMinPoints: 0,
  redeemMaxPercent: 0,
  expiryMonths: 6,
  levels: [
    { key: 'silver', name: 'Silver', threshold: 0 },
    { key: 'gold', name: 'Gold', threshold: 50000 },
    { key: 'platinum', name: 'Platinum', threshold: 200000 },
  ],
  b2bTiers: [
    { key: 'bronze', name: 'Registered Installer', threshold: 500000 },
    { key: 'silver', name: 'Certified Distributor', threshold: 2000000 },
    { key: 'partner', name: 'Strategic Partner', threshold: 5000000 },
  ],
};

const stores = [
  { id: 's1', name: 'Iloilo' },
  { id: 's2', name: 'Cebu' },
];

const members = [
  { id: 'm1', name: 'Maria Santos', phone: '0917 482 1129', storeId: 's1', storeName: 'Iloilo',
    type: 'retail', level: 'platinum', points: 58240, spend: 486200, status: 'active',
    createdAt: ago(200), pointsExpireAt: null },
  { id: 'm2', name: 'Juan Dela Cruz', phone: '0917 222 2222', storeId: 's1', storeName: 'Iloilo',
    type: 'retail', level: 'gold', points: 21306, spend: 152800, status: 'active',
    createdAt: ago(120), pointsExpireAt: new Date(NOW + 42 * day).toISOString() },
  { id: 'm3', name: 'SunPower Installers', phone: '+63 917 333 3333', storeId: 's2', storeName: 'Cebu',
    type: 'b2b', level: 'bronze', points: 342500, spend: 2845000, status: 'active',
    createdAt: ago(90), pointsExpireAt: null },
  { id: 'm4', name: 'Cebu Solar Trading', phone: '0919 643 1187', storeId: 's2', storeName: 'Cebu',
    type: 'b2b', level: 'silver', points: 512800, spend: 5120000, status: 'frozen',
    createdAt: ago(60), pointsExpireAt: null },
  // 同一个手机号被登记了两次（历史脏数据）→ 必须靠姓名才能区分
  { id: 'm5', name: 'Ana Reyes', phone: '0918 000 0000', storeId: 's1', storeName: 'Iloilo',
    type: 'retail', level: 'silver', points: 100, spend: 1000, status: 'active',
    createdAt: ago(30), pointsExpireAt: null },
  { id: 'm6', name: 'Ana Cruz', phone: '0918 000 0000', storeId: 's1', storeName: 'Iloilo',
    type: 'retail', level: 'silver', points: 200, spend: 2000, status: 'active',
    createdAt: ago(30), pointsExpireAt: null },
];

// m1 有 12 笔流水（验证「只取 10 笔」+ 倒序）
const transactions = [];
for (let i = 0; i < 12; i++) {
  transactions.push({
    id: 't' + i, memberId: 'm1', memberName: 'Maria Santos', type: 'earn',
    amount: 100 + i, reason: 'earn', storeId: 's1', storeName: 'Iloilo',
    operatorId: 'u-secret', operatorName: 'HQ Administrator',
    createdAt: ago(i), purchaseAmount: 1000 + i * 100, balanceAfter: 58240,
  });
}
transactions.push(
  { id: 'tx-r', memberId: 'm1', memberName: 'Maria Santos', type: 'redeem', amount: -3000,
    storeId: 's1', storeName: 'Iloilo', operatorId: 'u-secret', operatorName: 'Store Manager',
    createdAt: ago(5), purchaseAmount: 4000, balanceAfter: 58240 },
  { id: 'tx-x', memberId: 'm1', memberName: 'Maria Santos', type: 'expire', amount: -500,
    storeId: 's1', storeName: 'Iloilo', createdAt: ago(6), balanceAfter: 58240 },
  { id: 'tx-w', memberId: 'm1', memberName: 'Maria Santos', type: 'welcome', amount: 500,
    storeId: 's1', storeName: 'Iloilo', createdAt: ago(200), balanceAfter: 500 },
  { id: 'tx-u', memberId: 'm1', memberName: 'Maria Santos', type: 'brandNewType', amount: 7,
    storeId: 's1', storeName: 'Iloilo', createdAt: ago(2), balanceAfter: 58240 },
  { id: 'tx-other', memberId: 'm2', type: 'earn', amount: 999, createdAt: ago(1) }
);

console.log('【1】手机号归一化：各种写法都要归到同一个号');
ok("'0917 482 1129' → 09174821129", L.normalizePhone('0917 482 1129') === '09174821129', L.normalizePhone('0917 482 1129'));
ok("'0917-482-1129' → 09174821129", L.normalizePhone('0917-482-1129') === '09174821129');
ok("'(0917) 482 1129' → 09174821129", L.normalizePhone('(0917) 482 1129') === '09174821129');
ok("'+63 917 482 1129' → 09174821129", L.normalizePhone('+63 917 482 1129') === '09174821129');
ok("'63 917 482 1129' → 09174821129", L.normalizePhone('63 917 482 1129') === '09174821129');
ok("'917 482 1129' → 09174821129", L.normalizePhone('917 482 1129') === '09174821129');
ok("'abc' → 空串", L.normalizePhone('abc') === '');
ok('null → 空串', L.normalizePhone(null) === '');

console.log('\n【2】姓名匹配：顾客记得住就能查到，但猜不到');
ok("'Santos' 命中 'Maria Santos'", L.nameMatches('Maria Santos', 'Santos') === true);
ok('大小写不敏感', L.nameMatches('Maria Santos', 'santos') === true);
ok("'Maria Santos' 全名命中", L.nameMatches('Maria Santos', 'Maria Santos') === true);
ok("'maria s' 前缀命中", L.nameMatches('Maria Santos', 'maria s') === true);
ok("'Sa' 两字符前缀命中", L.nameMatches('Maria Santos', 'Sa') === true);
ok("'S' 一个字符 → 不通过", L.nameMatches('Maria Santos', 'S') === false);
ok('空查询 → 不通过', L.nameMatches('Maria Santos', '') === false);
ok("'Reyes' 不命中 'Maria Santos'", L.nameMatches('Maria Santos', 'Reyes') === false);
ok("多段必须全部命中：'Maria Reyes' → 不通过", L.nameMatches('Maria Santos', 'Maria Reyes') === false);
ok('变音符号：pena 命中 Peña', L.nameMatches('Jose Peña', 'pena') === true);
ok('标点忽略：dela cruz 命中 Dela Cruz', L.nameMatches('Juan Dela Cruz', 'dela cruz') === true);
ok('公司名可查：sunpower 命中', L.nameMatches('SunPower Installers', 'sunpower') === true);

console.log('\n【3】脱敏：顾客认得出，旁人看不出全名');
ok("'Maria Santos' → 'Maria S.'", L.maskName('Maria Santos') === 'Maria S.', L.maskName('Maria Santos'));
ok("'Juan Dela Cruz' → 'Juan D. C.'", L.maskName('Juan Dela Cruz') === 'Juan D. C.', L.maskName('Juan Dela Cruz'));
ok("单段名字原样 'Maria'", L.maskName('Maria') === 'Maria');
ok("'SunPower Installers' → 'SunPower I.'", L.maskName('SunPower Installers') === 'SunPower I.');
ok('空值 → 空串', L.maskName('') === '');
ok("手机号 → '0917 *** 1129'", L.maskPhone('09174821129') === '0917 *** 1129', L.maskPhone('09174821129'));
ok("+63 写法同样脱敏", L.maskPhone('+63 917 482 1129') === '0917 *** 1129', L.maskPhone('+63 917 482 1129'));
ok('过短号码 → 占位符', L.maskPhone('123') === '—');

console.log('\n【4】按手机号查 + 姓名定人');
const cands = L.findCandidates(members, '0918-000-0000');
ok('同号两个会员都被找出', cands.length === 2, cands.length);
ok("姓名 'Ana Reyes' → 命中 m5", L.pickMember(cands, 'Ana Reyes')?.id === 'm5');
ok("姓名 'cruz' → 命中的是 m6 不是 m5", L.pickMember(cands, 'cruz')?.id === 'm6');
ok('姓名对不上 → null（查不到余额）', L.pickMember(cands, 'Santos') === null);
ok('号码不存在 → 空数组', L.findCandidates(members, '0999 000 0000').length === 0);

console.log('\n【5】等级进度（零售用 rules.levels）');
const juan = members.find(m => m.id === 'm2');
const t1 = L.tierProgress(juan, rules);
ok('当前档 = Gold', t1.currentKey === 'gold', t1.currentKey);
ok('下一档 = Platinum', t1.nextKey === 'platinum', t1.nextKey);
ok('还差 ₱47,200（200000 - 152800）', t1.remaining === 47200, t1.remaining);
ok('进度 ≈ 68.5%（(152800-50000)/(200000-50000)）', Math.abs(t1.percent - 0.685) < 0.002, t1.percent);

const maria = members.find(m => m.id === 'm1');
const t2 = L.tierProgress(maria, rules);
ok('累计消费 48.6 万 → Platinum', t2.currentKey === 'platinum', t2.currentKey);
ok('已是最高档：nextKey=null', t2.nextKey === null);
ok('已是最高档：remaining=0', t2.remaining === 0);
ok('已是最高档：percent=1', t2.percent === 1);

const b2b = members.find(m => m.id === 'm3');
const t3 = L.tierProgress(b2b, rules);
ok('B2B 用 b2bTiers：累计 284.5 万 → silver（已过 200 万那档）', t3.currentKey === 'silver', t3.currentKey);
ok('B2B 下一档 = partner（500 万）', t3.nextKey === 'partner', t3.nextKey);
ok('B2B 还差 ₱2,155,000（5,000,000 - 2,845,000）', t3.remaining === 2155000, t3.remaining);

ok('等级表为空 → null（不崩）', L.tierProgress(juan, { levels: [] }) === null);

console.log('\n【5b】B2B 等级是人工设定的：进度必须以设定档为准，不能自相矛盾');
const partnerFixed = L.tierProgress({ ...b2b, level: 'partner' }, rules, 'partner');
ok('设定为 partner（最高档）→ nextKey=null', partnerFixed.nextKey === null, partnerFixed.nextKey);
ok('不会出现「升 partner」这种自相矛盾的下一档', partnerFixed.nextKey !== 'partner');
ok('最高档 → qualifies=false', partnerFixed.qualifies === false);
const bronzeHigh = L.tierProgress({ ...b2b, level: 'bronze' }, rules, 'bronze');
ok('设定 bronze 但消费已过 200 万 → 下一档 silver', bronzeHigh.nextKey === 'silver', bronzeHigh.nextKey);
ok('已够门槛 → remaining=0', bronzeHigh.remaining === 0, bronzeHigh.remaining);
ok('已够门槛 → qualifies=true（前端提示可升级）', bronzeHigh.qualifies === true);
ok('进度条不溢出 → percent=1', bronzeHigh.percent === 1, bronzeHigh.percent);
ok('没到门槛时 qualifies=false', t1.qualifies === false);
const unknownKey = L.tierProgress({ ...b2b, level: 'legacyTier' }, rules, 'legacyTier');
ok('设定档不在阶梯里 → 退回按消费算（silver）', unknownKey.currentKey === 'silver', unknownKey.currentKey);

console.log('\n【5c】返回体里「展示等级」与「进度档」必须一致');
const b2bRes = L.buildLookup({ member: members.find(m => m.id === 'm3'), stores, rules, transactions: [], now: NOW });
ok('B2B: member.level 与 tier.currentKey 相同',
  b2bRes.member.level === b2bRes.tier.currentKey, b2bRes.member.level + ' / ' + b2bRes.tier.currentKey);
const retailRes = L.buildLookup({ member: maria, stores, rules, transactions: [], now: NOW });
ok('零售: member.level 与 tier.currentKey 相同',
  retailRes.member.level === retailRes.tier.currentKey, retailRes.member.level + ' / ' + retailRes.tier.currentKey);

console.log('\n【6】返回体：余额、等级、价值换算');
const r1 = L.buildLookup({ member: maria, stores, rules, transactions, now: NOW });
ok('points = 58240', r1.member.points === 58240, r1.member.points);
ok('pointsValue = 5824（58240 × ₱0.1）', r1.member.pointsValue === 5824, r1.member.pointsValue);
ok('等级由累计消费推导 = platinum', r1.member.level === 'platinum', r1.member.level);
ok('门店名 = Iloilo', r1.member.storeName === 'Iloilo', r1.member.storeName);
ok('姓名已脱敏', r1.member.name === 'Maria S.', r1.member.name);
ok('手机号已脱敏', r1.member.phone === '0917 *** 1129', r1.member.phone);
ok('费率字段 = 每 ₱10 得 1 分', r1.rules.spendPerPoint === 10);
ok('兑换比例 10:1 → 1 分 = ₱0.1', r1.rules.pointValue === 0.1);

console.log('\n【7】返回体：绝不外泄内部字段（安全红线）');
const json = JSON.stringify(r1);
ok('不含 operatorName', json.indexOf('operatorName') === -1 && json.indexOf('HQ Administrator') === -1);
ok('不含 operatorId', json.indexOf('operatorId') === -1 && json.indexOf('u-secret') === -1);
ok('不含 memberId', json.indexOf('memberId') === -1);
ok('不含 balanceAfter', json.indexOf('balanceAfter') === -1);
ok('不含 reason 备注', json.indexOf('"reason"') === -1);
ok('顶层不含 members 全量数组', r1.members === undefined);

console.log('\n【8】流水：只取最近 10 笔 + 倒序 + 类型归一');
ok('recent 恰好 10 笔', r1.recent.length === 10, r1.recent.length);
ok('最新一笔在最前（age 0 天）', r1.recent[0].createdAt === ago(0), r1.recent[0].createdAt);
const times = r1.recent.map(t => t.createdAt);
ok('严格倒序', times.every((t, i) => i === 0 || times[i - 1] >= t));
ok('只含本人的流水（不含 m2 的 999）', r1.recent.every(t => t.amount !== 999));
ok("未知类型 'brandNewType' 归一成 'adjust'", r1.recent.some(t => t.type === 'adjust'));
ok('已知类型原样保留 earn', r1.recent.some(t => t.type === 'earn'));
ok('redeem 保留负数金额', r1.recent.some(t => t.type === 'redeem' && t.amount === -3000));
ok('流水里带门店名', typeof r1.recent[0].storeName === 'string');

console.log('\n【9】到期提示');
const r2 = L.buildLookup({ member: juan, stores, rules, transactions: [], now: NOW });
ok('42 天后到期 → days = 42', r2.expiring && r2.expiring.days === 42, r2.expiring);
ok('到期积分数 = 当前余额', r2.expiring && r2.expiring.points === 21306);
ok('未设置到期时间 → expiring = null', r1.expiring === null, r1.expiring);
const expired = { ...juan, pointsExpireAt: new Date(NOW - 3 * day).toISOString() };
ok('已过期 → 不提示（交给后台扣减任务）',
  L.buildLookup({ member: expired, stores, rules, transactions: [], now: NOW }).expiring === null);
const far = { ...juan, pointsExpireAt: new Date(NOW + 400 * day).toISOString() };
ok('还很远 → 仍返回天数（由前端决定是否强调）',
  L.buildLookup({ member: far, stores, rules, transactions: [], now: NOW }).expiring.days === 400);

console.log('\n【10】边界与健壮性');
const frozen = L.buildLookup({ member: members.find(m => m.id === 'm4'), stores, rules, transactions: [], now: NOW });
ok('冻结会员仍可查询（前端提示联系门店）', frozen.ok === true && frozen.member.status === 'frozen');
ok('冻结会员门店名正确 = Cebu', frozen.member.storeName === 'Cebu', frozen.member.storeName);
const orphan = L.buildLookup({ member: { id: 'mx', name: 'No Store', phone: '0900', storeId: 'gone', storeName: 'Old Name', type: 'retail', points: 0, spend: 0, level: 'silver' }, stores, rules, transactions: [], now: NOW });
ok('门店找不到时退回 storeName 副本', orphan.member.storeName === 'Old Name', orphan.member.storeName);
ok('空流水不崩', orphan.recent.length === 0);
const noRules = L.buildLookup({ member: maria, stores, rules: {}, transactions: [], now: NOW });
ok('rules 为空时用兜底费率（每 ₱10）', noRules.rules.spendPerPoint === 10);
ok('rules 为空时等级仍可算（silver）', noRules.member.level === 'silver', noRules.member.level);

console.log(`\n====== ${pass} passed, ${fail} failed ======`);
process.exit(fail ? 1 : 0);
