// 积分商城的纯函数单测（自带 fixture，不依赖 data/ 下的真实数据）
const m = require('../lib/mall');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}
function eq(name, actual, expected) {
  ok(`${name}（=${JSON.stringify(expected)}）`, JSON.stringify(actual) === JSON.stringify(expected));
}

const NOW = '2026-09-19T00:00:00.000Z';

console.log('\n【1】validateProduct —— 商品校验');
{
  ok('正常商品通过', m.validateProduct({ name: 'Solar Lamp', points: 500 }).ok);
  ok('缺名称被拒', !m.validateProduct({ points: 500 }).ok);
  ok('空白名称被拒', !m.validateProduct({ name: '   ', points: 500 }).ok);
  ok('积分为 0 被拒', !m.validateProduct({ name: 'X', points: 0 }).ok);
  ok('负积分被拒', !m.validateProduct({ name: 'X', points: -1 }).ok);
  ok('小数积分被拒', !m.validateProduct({ name: 'X', points: 12.5 }).ok);
  ok('超长名称被拒', !m.validateProduct({ name: 'x'.repeat(61), points: 1 }).ok);
  ok('超长描述被拒', !m.validateProduct({ name: 'X', points: 1, description: 'x'.repeat(301) }).ok);
  eq('名称会 trim', m.validateProduct({ name: '  Lamp  ', points: 1 }).value.name, 'Lamp');
}

console.log('\n【2】buildProduct / patchProduct');
{
  const b = m.buildProduct({ name: 'Fan', points: 300, description: 'd' }, 'p1', NOW);
  ok('创建成功', b.ok);
  eq('默认上架', b.value.active, true);
  eq('默认无图', b.value.image, null);
  eq('sort 默认 0', b.value.sort, 0);
  eq('显式下架生效', m.buildProduct({ name: 'X', points: 1, active: false }, 'p2', NOW).value.active, false);

  const patched = m.patchProduct(b.value, { points: 250 }, 'LATER');
  ok('局部更新成功', patched.ok);
  eq('新积分生效', patched.value.points, 250);
  eq('未传的字段保持原值', patched.value.name, 'Fan');
  eq('更新时间被刷新', patched.value.updatedAt, 'LATER');
  eq('image 未传时不丢', m.patchProduct({ ...b.value, image: 'a.png' }, { points: 1 }, NOW).value.image, 'a.png');
  eq('image 传 null 表示清掉', m.patchProduct({ ...b.value, image: 'a.png' }, { image: null, points: 1 }, NOW).value.image, null);
}

console.log('\n【3】validateRedeem —— 能不能换');
{
  const member = { id: 'm1', name: 'Juan', points: 500, status: 'active' };
  const product = { id: 'p1', name: 'Lamp', points: 300, active: true };
  ok('余额足够可换', m.validateRedeem(member, product).ok);
  eq('扣分数 = 商品所需', m.validateRedeem(member, product).value.points, 300);

  ok('余额不足被拒', !m.validateRedeem({ ...member, points: 100 }, product).ok);
  eq('不足时返回差额', m.validateRedeem({ ...member, points: 100 }, product).short, 200);
  ok('冻结会员被拒', !m.validateRedeem({ ...member, status: 'frozen' }, product).ok);
  ok('下架商品被拒', !m.validateRedeem(member, { ...product, active: false }).ok);
  ok('商品不存在被拒', !m.validateRedeem(member, null).ok);
  ok('恰好等于余额可以换', m.validateRedeem({ ...member, points: 300 }, product).ok);
}

console.log('\n【4】buildRedemption —— 兑换单');
{
  const member = { id: 'm1', name: 'Juan', phone: '0918', storeId: 's1', storeName: 'Iloilo' };
  const product = { id: 'p1', name: 'Lamp', points: 300, image: 'a.png' };
  const user = { id: 'u1', name: 'Ben', username: 'iloilo' };
  const rec = m.buildRedemption(member, product, user, 'r1', NOW, 'tx1');
  eq('初始状态为待发放', rec.status, 'pending');
  eq('关联扣分流水', rec.transactionId, 'tx1');
  eq('商品名做快照（下架/改名也不影响历史单）', rec.productName, 'Lamp');
  eq('商品图做快照', rec.productImage, 'a.png');
  eq('会员与门店快照', [rec.memberName, rec.storeName], ['Juan', 'Iloilo']);
  eq('履约字段初始为空', [rec.fulfilledBy, rec.fulfilledAt], [null, null]);
}

console.log('\n【5】canFulfill / canCancel');
{
  ok('待发放可以确认', m.canFulfill({ status: 'pending' }).ok);
  ok('已发放不能重复确认', !m.canFulfill({ status: 'fulfilled' }).ok);
  ok('已取消不能确认', !m.canFulfill({ status: 'cancelled' }).ok);
  ok('已发放不能取消（积分已退过就不该再退）', !m.canCancel({ status: 'fulfilled' }).ok);
  ok('待发放可以取消', m.canCancel({ status: 'pending' }).ok);
}

console.log('\n【6】visibleProducts / sortProducts');
{
  const list = [
    { id: 'a', active: true, sort: 5, createdAt: '2026-01-02' },
    { id: 'b', active: false, sort: 1, createdAt: '2026-01-01' },
    { id: 'c', active: true, sort: 1, createdAt: '2026-01-01' },
  ];
  eq('店长只看见上架的', m.visibleProducts(list, { role: 'manager' }).map(p => p.id), ['a', 'c']);
  eq('管理员看见全部', m.visibleProducts(list, { role: 'admin' }).length, 3);
  eq('按 sort 再按时间排序', m.sortProducts(list).map(p => p.id), ['b', 'c', 'a']);
}

console.log(`\n====== ${pass} passed, ${fail} failed ======\n`);
process.exit(fail ? 1 : 0);
