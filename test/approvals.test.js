// 积分审核的纯函数单测（自带 fixture，不依赖 data/ 下的真实数据）
const a = require('../lib/approvals');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}
function eq(name, actual, expected) {
  ok(`${name}（=${JSON.stringify(expected)}）`, JSON.stringify(actual) === JSON.stringify(expected));
}

console.log('\n【1】validateRequest —— 消费登记');
{
  const v = a.validateRequest({ kind: 'purchase', purchaseAmount: 500 });
  ok('正常消费金额通过', v.ok);
  eq('kind 归一为 purchase', v.value.kind, 'purchase');
  eq('purchase 的 points 先留空（通过时才算）', v.value.points, null);
  ok('金额为 0 被拒', !a.validateRequest({ kind: 'purchase', purchaseAmount: 0 }).ok);
  ok('负数金额被拒', !a.validateRequest({ kind: 'purchase', purchaseAmount: -100 }).ok);
  ok('非数字被拒（NaN）', !a.validateRequest({ kind: 'purchase', purchaseAmount: 'abc' }).ok);
  ok('超大金额被拒', !a.validateRequest({ kind: 'purchase', purchaseAmount: 1e12 }).ok);
}

console.log('\n【2】validateRequest —— 手工补录');
{
  const v = a.validateRequest({ kind: 'earn', points: 50, reason: '上线前历史消费' });
  ok('正常积分通过', v.ok);
  eq('points 保留', v.value.points, 50);
  eq('reason 保留', v.value.reason, '上线前历史消费');
  ok('小数积分被拒', !a.validateRequest({ kind: 'earn', points: 10.5 }).ok);
  ok('0 分被拒', !a.validateRequest({ kind: 'earn', points: 0 }).ok);
  ok('负分被拒', !a.validateRequest({ kind: 'earn', points: -5 }).ok);
  ok('超大积分被拒', !a.validateRequest({ kind: 'earn', points: 2e6 }).ok);
  ok('超长备注被拒', !a.validateRequest({ kind: 'earn', points: 1, reason: 'x'.repeat(201) }).ok);
}

console.log('\n【3】buildPending —— 待审核记录');
{
  const member = { id: 'm1', name: 'Maria Santos', phone: '0917 482 1129', storeId: 's1', storeName: 'Iloilo' };
  const user = { id: 'u1', name: 'Ben', username: 'iloilo' };
  const v = a.validateRequest({ kind: 'earn', points: 80, reason: '补录' });
  const rec = a.buildPending(member, user, v.value, 'p1', '2026-09-19T00:00:00.000Z');
  eq('初始状态为 pending', rec.status, 'pending');
  eq('会员信息快照', rec.memberName, 'Maria Santos');
  eq('门店快照', rec.storeId, 's1');
  eq('提交人记录完整', [rec.requestedBy, rec.requestedByName], ['u1', 'Ben']);
  eq('决策字段初始为空', [rec.decidedBy, rec.decidedAt, rec.decisionNote], [null, null, null]);
  eq('未通过前不关联流水', rec.transactionId, null);

  const pv = a.validateRequest({ kind: 'purchase', purchaseAmount: 1000 });
  const prec = a.buildPending(member, user, pv.value, 'p2', '2026-09-19T00:00:00.000Z');
  eq('消费登记的积分为 null（通过时按规则算）', prec.points, null);
  eq('消费金额被记住', prec.purchaseAmount, 1000);
}

console.log('\n【4】canDecide —— 防重复审核');
{
  ok('pending 可以审核', a.canDecide({ status: 'pending' }).ok);
  ok('已通过不能再审', !a.canDecide({ status: 'approved' }).ok);
  ok('已驳回不能再审', !a.canDecide({ status: 'rejected' }).ok);
  ok('空记录被拒', !a.canDecide(null).ok);
}

console.log('\n【5】validateDecision —— 驳回说明');
{
  ok('正常说明通过', a.validateDecision({ note: '金额与单据不符' }).ok);
  ok('空说明也通过（是否必填由路由决定）', a.validateDecision({}).ok);
  ok('超长说明被拒', !a.validateDecision({ note: 'x'.repeat(201) }).ok);
  eq('说明会 trim', a.validateDecision({ note: '  好的  ' }).value.note, '好的');
}

console.log('\n【6】visibleFor / countPending —— 门店隔离');
{
  const recs = [
    { id: '1', storeId: 's1', status: 'pending' },
    { id: '2', storeId: 's2', status: 'pending' },
    { id: '3', storeId: 's1', status: 'approved' },
  ];
  eq('管理员看全部', a.visibleFor(recs, { role: 'admin', storeId: null }).length, 3);
  const mine = a.visibleFor(recs, { role: 'manager', storeId: 's1' });
  eq('店长只看本店', mine.map(r => r.id), ['1', '3']);
  eq('店长待审核数', a.countPending(recs, { role: 'manager', storeId: 's1' }), 1);
  eq('管理员待审核数', a.countPending(recs, { role: 'admin' }), 2);
  eq('未登录看不到', a.visibleFor(recs, null).length, 0);
}

console.log(`\n====== ${pass} passed, ${fail} failed ======\n`);
process.exit(fail ? 1 : 0);
