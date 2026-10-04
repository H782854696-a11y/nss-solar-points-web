// 积分审核：店长提交的新增积分申请，需管理员通过后才能真正计入会员余额。
//
// 设计约定（改动前请先读完）：
// 1. 申请只是一条「待办」，在管理员通过之前**不写流水、不动余额** —— 
//    交易流水 transactions 是账本，只记录真实发生的积分变动，不能掺入未生效的申请。
// 2. 通过时才统一更新 points / spend / earnedTotal / level / pointsExpireAt，
//    避免「余额已加、等级没升」这类半更新状态。
// 3. 本模块是纯函数（不读文件、不落盘），落盘由 server.js 负责，方便单测。

const STATUS = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' };
const KIND = { PURCHASE: 'purchase', EARN: 'earn' };

const MAX_PURCHASE = 100000000; // ₱1 亿，防止手滑多按几个 0
const MAX_POINTS = 1000000;
const MAX_REASON = 200;

/** 校验一条新增积分申请的输入。返回 { ok, error } 或 { ok:true, value } */
function validateRequest(input = {}) {
  const kind = input.kind === KIND.EARN ? KIND.EARN : KIND.PURCHASE;
  const reason = String(input.reason == null ? '' : input.reason).trim();
  if (reason.length > MAX_REASON) return { ok: false, error: `备注过长（最多 ${MAX_REASON} 字）` };

  if (kind === KIND.PURCHASE) {
    const amount = Number(input.purchaseAmount);
    if (!(amount > 0)) return { ok: false, error: '请输入正确的消费金额' };
    if (amount > MAX_PURCHASE) return { ok: false, error: '消费金额过大，请核对' };
    return { ok: true, value: { kind, purchaseAmount: amount, points: null, reason } };
  }

  const pts = Number(input.points);
  if (!(pts > 0)) return { ok: false, error: '请输入正确的积分数量' };
  if (!Number.isInteger(pts)) return { ok: false, error: '积分数量必须是整数' };
  if (pts > MAX_POINTS) return { ok: false, error: '单次补录积分过大，请核对' };
  const pa = Number(input.purchaseAmount);
  return {
    ok: true,
    value: { kind, purchaseAmount: pa > 0 ? pa : null, points: pts, reason },
  };
}

/**
 * 生成一条待审核记录（纯函数：id 与时间戳由调用方传入，方便测试断言）
 * points 为 null 时表示「按消费金额在通过时计算」（消费登记就是这种）。
 */
function buildPending(member, user, value, id, nowIso) {
  return {
    id,
    kind: value.kind,
    memberId: member.id,
    memberName: member.name,
    memberPhone: member.phone || '',
    storeId: member.storeId,
    storeName: member.storeName,
    // purchase 由通过时的规则算出，所以这里先留 null
    points: value.kind === KIND.EARN ? value.points : null,
    purchaseAmount: value.purchaseAmount,
    reason: value.reason || '',
    status: STATUS.PENDING,
    requestedBy: user.id,
    requestedByName: user.name || user.username,
    requestedByName2: user.username,
    requestedAt: nowIso,
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    decisionNote: null,
    transactionId: null,
    grantedPoints: null,
  };
}

/** 这条申请现在还能被审核吗（防止重复通过 / 重复驳回） */
function canDecide(rec) {
  if (!rec) return { ok: false, error: '申请不存在' };
  if (rec.status !== STATUS.PENDING) return { ok: false, error: '该申请已处理，无法重复操作' };
  return { ok: true };
}

/** 驳回时必须留一句说明，方便店长知道为什么被打回 */
function validateDecision(input = {}) {
  const note = String(input.note == null ? '' : input.note).trim();
  if (note.length > MAX_REASON) return { ok: false, error: `说明过长（最多 ${MAX_REASON} 字）` };
  return { ok: true, value: { note } };
}

/** 列表筛选：管理员看全部，店长只看自己门店的 */
function visibleFor(recs, user) {
  const all = Array.isArray(recs) ? recs : [];
  if (!user) return [];
  if (user.role === 'admin') return all;
  return all.filter(r => r.storeId === user.storeId);
}

/** 统计待审核条数（用于侧栏角标） */
function countPending(recs, user) {
  return visibleFor(recs, user).filter(r => r.status === STATUS.PENDING).length;
}

module.exports = {
  STATUS, KIND, MAX_REASON,
  validateRequest, buildPending, canDecide, validateDecision,
  visibleFor, countPending,
};
