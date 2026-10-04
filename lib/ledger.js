// 积分账本：所有积分变动都必须经过这里，保证「余额 + 流水」永远对得上
// 注意：grantPoints / deductPoints 只修改传入的 member 对象，不负责落盘，
//       调用方必须自己 writeAll('members', ...)，以保证一次业务动作只写一次文件。
const { nanoid } = require('nanoid');
const { readAll, writeAll } = require('./seed');
const points = require('./points');

function nowIso() { return new Date().toISOString(); }

/**
 * 写一条积分流水（统一出口，保证对账字段齐全）
 * type: earn 消费获得 | welcome 新人礼 | redeem 核销 | expire 到期扣减 | adjust 人工调整
 */
function recordTransaction(member, type, signedAmount, opts = {}) {
  const txs = readAll('transactions') || [];
  const tx = {
    id: nanoid(),
    memberId: member.id,
    memberName: member.name,
    type,
    amount: signedAmount,
    reason: opts.reason || type,
    storeId: member.storeId,
    storeName: member.storeName,
    operatorId: opts.operator ? opts.operator.id : null,
    operatorName: opts.operator ? opts.operator.name : 'system',
    createdAt: nowIso(),
    purchaseAmount: opts.purchaseAmount ?? null,
    basePoints: opts.basePoints ?? null,
    balanceAfter: Number(member.points) || 0,
  };
  txs.unshift(tx);
  writeAll('transactions', txs);
  return tx;
}

/** 给会员加积分：刷新滚动有效期、累计获得数，并写流水 */
function grantPoints(member, amount, rules, type, opts = {}) {
  const amt = Number(amount) || 0;
  member.points = (Number(member.points) || 0) + amt;
  member.earnedTotal = (Number(member.earnedTotal) || 0) + amt;
  member.lastEarnAt = nowIso();
  member.pointsExpireAt = points.expiryFrom(Date.now(), rules);
  member.updatedAt = nowIso();
  return recordTransaction(member, type, amt, opts);
}

/** 从会员扣积分 */
function deductPoints(member, amount, type, opts = {}) {
  const amt = Number(amount) || 0;
  member.points = (Number(member.points) || 0) - amt;
  if (type === 'redeem') member.redeemedTotal = (Number(member.redeemedTotal) || 0) + amt;
  member.updatedAt = nowIso();
  return recordTransaction(member, type, -amt, opts);
}

/**
 * 取消兑换时把积分退回去。
 * 与 grantPoints 的区别：退款不算「新赚到的积分」，所以不刷新有效期、不累加 earnedTotal，
 * 只把余额加回去并冲减 redeemedTotal，避免统计口径被退款污染。
 */
function refundPoints(member, amount, type, opts = {}) {
  const amt = Number(amount) || 0;
  member.points = (Number(member.points) || 0) + amt;
  if (type === 'redeem') {
    member.redeemedTotal = Math.max(0, (Number(member.redeemedTotal) || 0) - amt);
  }
  member.updatedAt = nowIso();
  return recordTransaction(member, type, amt, opts);
}

module.exports = { recordTransaction, grantPoints, deductPoints, refundPoints, nowIso };
