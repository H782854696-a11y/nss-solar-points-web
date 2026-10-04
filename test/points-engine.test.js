// 积分引擎端到端测试（单进程内，绕过系统代理）
// 规则基线（2026-09-11 v4）：每消费 ₱10 得 1 积分（返利 1%）· 10 积分抵 ₱1 · 抵扣无上限
process.env.PORT = '3110';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-points-engine-'));
const BOOTSTRAP_PASSWORD = 'LocalOnlyPointsBootstrap2026!';
const CHANGED_PASSWORD = 'LocalOnlyPointsChanged2026!';
process.env.SP_ADMIN_PASSWORD = BOOTSTRAP_PASSWORD;
const APP = path.join(__dirname, '..');
require(APP + '/server.js');

const B = 'http://127.0.0.1:3110';
const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`); }
}

let cookie = '';
async function api(method, path, body) {
  const r = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
const rndPhone = () => '0999' + Math.floor(1000000 + Math.random() * 8999999);

(async () => {
  await wait(900);
  const pointsLib = require(APP + '/lib/points');
  const expiryLib = require(APP + '/lib/points-expiry');
  const { readAll: ra, writeAll: wa } = require(APP + '/lib/seed');

  const rules = ra('rules');
  console.log(`\n规则(v${rules.schemaVersion})：每 ₱${rules.spendPerPoint} 得 1 分 | 兑换 ${rules.redeemRatio} | 门槛 ${rules.redeemMinPoints} 分 | 抵扣上限 ${rules.redeemMaxPercent === 0 ? '无上限' : rules.redeemMaxPercent + '%'} | 欢迎礼 ${rules.welcomeBonus} | 有效期 ${rules.expiryMonths} 月`);

  const lg = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: BOOTSTRAP_PASSWORD }) });
  cookie = (lg.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  console.log('\n【1】登录与规则');
  ok('管理员登录', lg.status === 200);
  const changed = await fetch(B + '/api/auth/change-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ currentPassword: BOOTSTRAP_PASSWORD, newPassword: CHANGED_PASSWORD }),
  });
  ok('首次登录强制改密完成', changed.status === 200, changed.status);
  cookie = (changed.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const rl = await api('GET', '/api/rules');
  ok('规则接口带 engine 运行时信息', !!rl.body?.engine);
  ok('生日双倍规则已移除', rl.body?.rules && !('birthdayDouble' in rl.body.rules));
  ok('每 ₱10 得 1 分', Number(rl.body?.rules?.spendPerPoint) === 10, rl.body?.rules?.spendPerPoint);
  ok('兑换比例 10:1', rl.body?.rules?.redeemRatio === '10:1', rl.body?.rules?.redeemRatio);
  ok('抵扣上限 = 无上限（0）', Number(rl.body?.rules?.redeemMaxPercent) === 0, rl.body?.rules?.redeemMaxPercent);
  ok('每积分价值 ₱0.1', rl.body?.engine?.redeem?.value / rl.body?.engine?.redeem?.points === 0.1, rl.body?.engine?.redeem);

  console.log('\n【2】新会员自动发欢迎积分');
  const phone = rndPhone();
  const c1 = await api('POST', '/api/members', { name: 'Test Member A', phone, type: 'retail', storeId: ra('stores')[0]?.id });
  ok('创建成功', c1.status === 200, c1.body);
  ok(`欢迎积分 = ${rules.welcomeBonus}`, c1.body?.member?.points === rules.welcomeBonus, c1.body?.member?.points);
  ok('生成 welcome 流水', (await api('GET', `/api/members/${c1.body.member.id}/transactions`)).body.items[0]?.type === 'welcome');
  const expDays = pointsLib.daysToExpiry(c1.body.member, Date.now());
  ok(`到期时间 ≈ ${rules.expiryMonths * 30} 天`, expDays > rules.expiryMonths * 28 && expDays <= rules.expiryMonths * 31, expDays);

  console.log('\n【3】手机号查重');
  const dup = await api('POST', '/api/members', { name: 'Duplicate', phone, type: 'retail' });
  ok('重复手机号被拒（409）', dup.status === 409, dup.status);

  console.log('\n【4】消费自动算分（全等级统一费率，无倍率）');
  const mid = c1.body.member.id;
  const p1 = await api('POST', `/api/members/${mid}/purchase`, { amount: 3000000 });
  ok('消费 ₱3,000,000 → 300,000 分（每 ₱10 = 1 分）', p1.body?.earn?.points === 300000, p1.body?.earn);
  ok('本单费率 = ₱10 积 1 分', p1.body?.earn?.spendPerPoint === 10, p1.body?.earn);
  ok('等级升级到 platinum', p1.body?.member?.level === 'platinum', p1.body?.member?.level);
  ok('升级事件回传', p1.body?.levelUp?.to === 'platinum', p1.body?.levelUp);
  ok('余额 = 500 + 300,000', p1.body?.member?.points === 300500, p1.body?.member?.points);

  const p2 = await api('POST', `/api/members/${mid}/purchase`, { amount: 1000000 });
  ok('铂金会员再消费 ₱1,000,000 → 仍是 100,000 分（费率全等级统一）', p2.body?.earn?.points === 100000, p2.body?.earn);
  ok('流水不再带倍率字段', p2.body?.transaction?.multiplier === undefined, p2.body?.transaction);
  ok('余额 = 400,500', p2.body?.member?.points === 400500, p2.body?.member?.points);

  console.log('\n【5】核销报价：无比例上限，受订单金额约束');
  const q = await api('GET', `/api/members/${mid}/quote?purchaseAmount=1000`);
  ok('比例 10:1 → 每积分 ₱0.1', q.body?.rules?.redeemRatio === '10:1' && q.body.redeem.unitValue === 0.1, q.body?.redeem);
  ok('无比例上限标记 noCap = true', q.body?.redeem?.noCap === true, q.body?.redeem);
  ok('₱1000 订单最多可用 10,000 分（受订单金额约束）', q.body?.redeem?.maxPoints === 10000, q.body?.redeem);
  ok('约束来源 = order', q.body?.redeem?.limitedBy === 'order', q.body?.redeem?.limitedBy);

  const r1 = await api('POST', `/api/members/${mid}/transactions`, { type: 'redeem', amount: 500, purchaseAmount: 1000 });
  ok('核销 500 分成功（抵 ₱50）', r1.status === 200 && r1.body?.member?.points === 400000, r1.body);

  const r2 = await api('POST', `/api/members/${mid}/transactions`, { type: 'redeem', amount: 20000, purchaseAmount: 1000 });
  ok('超过订单金额的核销被拒（400）', r2.status === 400, r2.status);
  ok('错误信息说明订单金额约束', /order|cover/i.test(r2.body?.error || ''), r2.body?.error);

  console.log('\n【6】无上限：大额订单可一次抵掉绝大部分');
  const q2 = await api('GET', `/api/members/${mid}/quote?purchaseAmount=10000`);
  ok('₱10,000 订单最多可用 100,000 分（不再受 30% 限制）', q2.body?.redeem?.maxPoints === 100000, q2.body?.redeem?.maxPoints);
  const r3 = await api('POST', `/api/members/${mid}/transactions`, { type: 'redeem', amount: 50000, purchaseAmount: 10000 });
  ok('核销 50,000 分成功（抵 ₱5,000 = 订单 50%）', r3.status === 200, r3.body);
  ok('抵扣金额 = ₱5,000', r3.body?.transaction?.reason?.includes('5000.00'), r3.body?.transaction?.reason);
  ok('余额 = 350,000', r3.body?.member?.points === 350000, r3.body?.member?.points);

  console.log('\n【7】无起兑门槛（10 分也能抵 ₱1）');
  const c2 = await api('POST', '/api/members', { name: 'Test Member B', phone: rndPhone(), type: 'retail', storeId: ra('stores')[0]?.id });
  const mid2 = c2.body.member.id;
  await api('PUT', `/api/members/${mid2}`, { points: 10 });
  const r4 = await api('POST', `/api/members/${mid2}/transactions`, { type: 'redeem', amount: 10, purchaseAmount: 500 });
  ok('10 分核销成功（旧规则需 1000 分门槛）', r4.status === 200, r4.body);
  ok('余额清零', (ra('members').find(m => m.id === mid2).points) === 0);
  const r5 = await api('POST', `/api/members/${mid2}/transactions`, { type: 'redeem', amount: 100, purchaseAmount: 500 });
  ok('余额不足被拒（400）', r5.status === 400 && /Insufficient/i.test(r5.body?.error || ''), r5.body?.error);

  console.log('\n【8】人工改积分留痕');
  const txs2 = (await api('GET', `/api/members/${mid2}/transactions`)).body.items;
  ok('产生 adjust 流水', txs2.some(t => t.type === 'adjust'), txs2.map(t => t.type));

  console.log('\n【9】积分到期扫描');
  const ms = ra('members');
  ms.find(m => m.id === mid).pointsExpireAt = new Date(Date.now() - 86400000).toISOString();
  wa('members', ms);
  const preview = expiryLib.scan({ dryRun: true });
  ok('试算识别出 1 位过期会员', preview.expiredMembers === 1, preview);
  ok('试算不扣减余额', (ra('members').find(m => m.id === mid).points) === 350000);
  const real = expiryLib.scan();
  ok('正式扫描扣减积分', (ra('members').find(m => m.id === mid).points) === 0, real);
  const expTx = ra('transactions').find(t => t.type === 'expire' && t.memberId === mid);
  ok('生成 expire 流水 -350,000', !!expTx && expTx.amount === -350000, expTx);

  console.log('\n【10】等级名称英文化 + 倍率已移除');
  const lvls = ra('rules').levels;
  ok('等级名称 = Silver/Gold/Platinum', JSON.stringify(lvls.map(l => l.name)) === JSON.stringify(['Silver', 'Gold', 'Platinum']), lvls.map(l => l.name));
  ok('等级表已无 multiplier 字段', lvls.every(l => !('multiplier' in l)), lvls);
  ok('规则 schemaVersion = 4', Number(ra('rules').schemaVersion) === 4, ra('rules').schemaVersion);
  ok('计分费率 = 每 ₱10 得 1 分', Number(ra('rules').spendPerPoint) === 10, ra('rules').spendPerPoint);
  const b2b = ra('rules').b2bTiers.map(l => l.name);
  ok('B2B 阶梯名称已英文化', b2b.every(n => /^[\x20-\x7E]+$/.test(n)), b2b);

  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(2); });
