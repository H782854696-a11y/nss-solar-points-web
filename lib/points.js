// 积分引擎
// ============================================================
// 把 data/rules.json 里的规则真正接到业务动作上：
//   - 消费金额 → 自动算积分（全等级统一费率，等级不再影响赚分速度）
//   - 新会员 → 自动发欢迎积分
//   - 核销 → 校验最低门槛与单笔抵扣比例
//   - 积分有效期 → 滚动刷新 + 到期扣减
// 所有金额单位为菲律宾比索 ₱。
// ============================================================

const DEFAULT_SPEND_PER_POINT = 10; // 每 ₱10 得 1 分（2026-09-11 起，实际返利 1%）

/** 消除浮点误差，保留 6 位小数 */
function round6(n) { return Math.round(Number(n) * 1e6) / 1e6; }

/** 月度加减，处理月末溢出（1/31 + 1 个月 → 2/28） */
function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

/** 解析 "100:10" → { points: 100, value: 10 }，即 100 积分抵 ₱10 */
function parseRedeemRatio(str) {
  const m = String(str || '').match(/(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)/);
  if (!m) return { points: 100, value: 10 };
  const points = Number(m[1]);
  const value = Number(m[2]);
  if (!points || points <= 0 || !(value > 0)) return { points: 100, value: 10 };
  return { points, value };
}

/** 1 积分值多少 ₱ */
function pointValue(rules) {
  const r = parseRedeemRatio(rules.redeemRatio);
  return r.value / r.points;
}

function levelOf(member, rules) {
  if (member.type !== 'retail') return member.level;
  const lvls = (rules.levels || []).slice().sort((a, b) => a.threshold - b.threshold);
  let key = lvls[0]?.key || 'silver';
  for (const lv of lvls) { if ((member.spend || 0) >= lv.threshold) key = lv.key; }
  return key;
}

/**
 * 消费金额 → 可获得积分
 *
 * 2026-09-11：取消等级倍率。所有零售会员同一费率，等级只表示身份与后续权益，
 * 不再影响赚分速度（此前 Gold×1.5 / Platinum×2 的返利过重）。
 *
 * @returns {{basePoints:number, points:number, spendPerPoint:number}}
 */
function calcEarnPoints(amount, member, rules) {
  // 显式判断而不是用 || ：0 是 falsy，会让「设为 0」被静默替换成默认值 10 ——
  // 规则页显示 0，实际却按 10 计算。（服务端已禁止 <1，这里再兜一层防御）
  const raw = Number(rules.spendPerPoint);
  const spendPerPoint = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SPEND_PER_POINT;
  const basePoints = Math.floor(Number(amount || 0) / spendPerPoint);
  return { basePoints, points: basePoints, spendPerPoint };
}

/**
 * 核销报价：给出本次最多可用多少积分、能抵多少钱
 *
 * 抵扣上限规则（取三者中最紧的一条）：
 *   1) 账户积分余额
 *   2) 单笔抵扣比例 redeemMaxPercent —— 设为 0 表示**不限制比例（无上限）**
 *   3) 抵扣金额不得超过订单本身金额
 *
 * @param purchaseAmount 本次订单金额（₱）；传 0 或省略表示不关联订单，跳过节比校验
 */
function redeemQuote(member, rules, purchaseAmount) {
  const ratio = parseRedeemRatio(rules.redeemRatio);
  const unit = ratio.value / ratio.points;              // 每积分价值 ₱
  const balance = Number(member.points) || 0;
  const minPoints = Number(rules.redeemMinPoints) || 0;
  const maxPercent = Number(rules.redeemMaxPercent) || 0; // 0 = 无上限
  const amount = Number(purchaseAmount) || 0;

  const eligible = balance >= minPoints;
  const byBalanceValue = round6(balance * unit);                          // 余额能抵扣的上限 ₱
  const byPercentValue = amount > 0 && maxPercent > 0
    ? amount * maxPercent / 100
    : Infinity;                                                          // 无上限时不受比例约束
  const byOrderValue = amount > 0 ? amount : Infinity;                   // 抵扣不超过订单金额

  const caps = [
    { key: 'balance', value: byBalanceValue },
    { key: 'percent', value: byPercentValue },
    { key: 'order', value: byOrderValue },
  ];
  const binding = caps.reduce((m, c) => (c.value < m.value ? c : m), caps[0]);
  const maxValue = Math.max(0, round6(binding.value));
  const maxPoints = Math.max(0, Math.floor(maxValue / unit + 1e-9));

  return {
    ratioPoints: ratio.points,
    ratioValue: ratio.value,
    unitValue: unit,
    balance,
    minPoints,
    maxPercent,
    noCap: maxPercent <= 0,                             // 是否「不限制抵扣比例」
    eligible,
    purchaseAmount: amount,
    maxPoints,                                          // 本次最多可用积分
    maxValue,                                           // 对应最多抵扣 ₱
    limitedBy: binding.key,                             // balance | percent | order
    percentApplied: binding.key === 'percent',           // 是否被「单笔抵扣比例」限制住
    percentCap: amount > 0 && maxPercent > 0 ? amount * maxPercent / 100 : null,
  };
}

/** 校验一次核销请求是否合规 */
function validateRedeem(member, rules, points, purchaseAmount) {
  const amt = Number(points) || 0;
  if (amt <= 0) return { ok: false, error: 'Points must be greater than 0.' };
  const q = redeemQuote(member, rules, purchaseAmount);
  // 先看账户有没有达到起兑门槛（这条信息比"余额不足"更有指导性）
  if (!q.eligible) {
    return { ok: false, error: `At least ${q.minPoints} points are required before redeeming. Current balance: ${q.balance}.`, quote: q };
  }
  if (amt > (member.points || 0)) return { ok: false, error: 'Insufficient points balance.', quote: q };
  if (amt > q.maxPoints) {
    const why = q.limitedBy === 'percent'
      ? `This order is ₱${q.purchaseAmount}; up to ${q.maxPercent}% (₱${q.maxValue.toFixed(2)}) can be paid with points, i.e. max ${q.maxPoints} points.`
      : q.limitedBy === 'order'
        ? `This order is ₱${q.purchaseAmount}; points alone cannot cover the full amount — max ${q.maxPoints} points (₱${q.maxValue.toFixed(2)}).`
        : `Maximum redeemable this time is ${q.maxPoints} points.`;
    return { ok: false, error: why, quote: q };
  }
  return { ok: true, quote: q, value: round6(amt * q.unitValue) };
}

/** 本次获得的积分何时过期（滚动有效期：每次获得积分都从当天重新计算） */
function expiryFrom(now, rules) {
  const months = Number(rules.expiryMonths) || 0;
  if (months <= 0) return null; // 0 = 永不过期
  return addMonths(new Date(now), months).toISOString();
}

/** 该会员的积分是否已到期待扣减 */
function isExpired(member, now) {
  if (!member.pointsExpireAt) return false;
  if (!(member.points > 0)) return false;
  return new Date(member.pointsExpireAt).getTime() <= new Date(now).getTime();
}

/** 距过期还有多少天（无到期时间返回 null） */
function daysToExpiry(member, now) {
  if (!member.pointsExpireAt) return null;
  return Math.ceil((new Date(member.pointsExpireAt).getTime() - new Date(now).getTime()) / 86400000);
}

module.exports = {
  addMonths,
  round6,
  parseRedeemRatio,
  pointValue,
  levelOf,
  calcEarnPoints,
  redeemQuote,
  validateRedeem,
  expiryFrom,
  isExpired,
  daysToExpiry,
  DEFAULT_SPEND_PER_POINT,
};
