// lib/reports.js
// 经营报表聚合算法（纯函数 / 可单测 / 不依赖 ledger 副作用）
// 输入：完整数据快照；输出：结构化指标，前端可直接渲染
//
// 所有"金额"单位都是 ₱；所有"积分"都是 point（1 点 = rules.pointValue = 1/10 ₱）

const { pointValue } = require('./points');

// 分桶口径统一按菲律宾时间（UTC+8，菲律宾不实行夏令时）。
// 用 UTC 分桶会让每月头 8 小时的流水被归到上一个月。
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 时间戳 → 菲律宾本地时间的 "YYYY-MM" */
function monthKeyManila(ts) {
  const d = new Date(Number(ts) + TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 把时间戳整体平移 n 个自然月（锚定到当月 1 号，避免月末溢出） */
function shiftMonths(ts, n) {
  const d = new Date(Number(ts) + TZ_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) - TZ_OFFSET_MS;
}

// 沉睡阈值：最近一次消费距今超过 N 天（默认 60）
// 即将过期阈值：未来 N 天内将过期（默认 90）
function overview({ members = [], transactions = [], stores = [], rules = {}, now = Date.now() } = {}) {
  const day = 86400000;
  const SLEEP_DAYS = 60;
  const SOON_DAYS = 90;
  const TREND_MONTHS = 6;
  const RETENTION_DAYS = 30;
  const pv = pointValue(rules || {}) || 0.1;     // 每点价值 ₱（空 rules 兜底 0.1）

  // 索引：会员 id → 会员对象
  const memberById = new Map();
  members.forEach(m => memberById.set(m.id, m));

  // 会员在本表中的累计消费（含历史），用于 Top10；流水中的 purchaseAmount 之和做对照
  const spendByMember = new Map();           // 历史累计
  members.forEach(m => spendByMember.set(m.id, Number(m.spend) || 0));

  // 最近一次 earn/purchase 时间（不计入 adjust/redeem/expire）
  const lastPurchaseAtByMember = new Map();
  members.forEach(m => {
    if (m.lastPurchaseAt) lastPurchaseAtByMember.set(m.id, new Date(m.lastPurchaseAt).getTime());
  });
  transactions.forEach(t => {
    if (t.type !== 'earn' || !t.purchaseAmount) return;
    const ts = new Date(t.createdAt).getTime();
    if (!Number.isFinite(ts)) return;
    const prev = lastPurchaseAtByMember.get(t.memberId) || 0;
    if (ts > prev) lastPurchaseAtByMember.set(t.memberId, ts);
  });

  // ====== 头部 4 张卡：积分负债 + 30 天运营总览 ======
  let pointsOutstanding = 0;
  let activeMembers = 0;                       // 状态正常
  let frozenMembers = 0;
  let b2bMembers = 0;
  let retailMembers = 0;
  members.forEach(m => {
    pointsOutstanding += Number(m.points) || 0;
    if (m.status === 'frozen') frozenMembers++;
    else activeMembers++;
    if (m.type === 'b2b') b2bMembers++;
    else retailMembers++;
  });
  const liabilityPHP = pointsOutstanding * pv;       // 积分负债 ₱

  // 30 天窗口
  const winStart = now - RETENTION_DAYS * day;
  let txCount30 = 0;                                // 30 天流水条数
  let earn30 = 0;                                   // 30 天发放积分
  let redeem30 = 0;                                 // 30 天核销积分
  let spend30 = 0;                                  // 30 天消费 ₱
  const activeM30 = new Set();                      // 30 天内有过消费的会员
  const txCountByM30 = new Map();                   // 30 天内会员消费笔数
  const earnByStore30 = new Map();                  // 30 天每店发放积分
  stores.forEach(s => earnByStore30.set(s.id, 0));

  transactions.forEach(t => {
    const ts = new Date(t.createdAt).getTime();
    if (!Number.isFinite(ts)) return;
    if (ts >= winStart && ts <= now) {
      txCount30++;
      if (t.type === 'earn') {
        earn30 += Number(t.amount) || 0;
        const m = memberById.get(t.memberId);
        if (m) earnByStore30.set(m.storeId, (earnByStore30.get(m.storeId) || 0) + (Number(t.amount) || 0));
      } else if (t.type === 'redeem') {
        redeem30 += Math.abs(Number(t.amount) || 0);
      }
      if (t.type === 'earn' && t.purchaseAmount) {
        spend30 += Number(t.purchaseAmount) || 0;
        activeM30.add(t.memberId);
        txCountByM30.set(t.memberId, (txCountByM30.get(t.memberId) || 0) + 1);
      }
    }
  });

  const repeatBuyers30 = Array.from(txCountByM30.values()).filter(n => n >= 2).length;
  // 注意：这里算的是「30 天内买过 2 次以上的人 / 30 天内买过的人」= 复购率，
  // 不是留存率。字段名与界面文案都已按复购率统一。
  const repeatRate30 = activeM30.size > 0 ? repeatBuyers30 / activeM30.size : 0;

  // ====== 沉睡会员 ======
  // 定义：①有过消费但距今 ≥ 60 天；或 ②从未消费且注册 ≥ 30 天
  const SLEEP_REGISTER_DAYS = 30;   // 从未消费的新会员，超过此天数即沉睡
  const sleepList = [];
  members.forEach(m => {
    if (m.status === 'frozen') return;            // 已冻结不算沉睡
    const last = lastPurchaseAtByMember.get(m.id) || 0;
    const created = new Date(m.createdAt).getTime();
    let days;
    let kind;
    if (last) {
      days = Math.floor((now - last) / day);
      kind = 'last';
    } else {
      days = Math.floor((now - (created || now)) / day);
      kind = 'register';
      if (days < SLEEP_REGISTER_DAYS) return;     // 刚注册且无消费，不算沉睡
    }
    if (days >= SLEEP_DAYS || (kind === 'register' && days >= SLEEP_REGISTER_DAYS)) {
      // 带上 storeId：前端靠它解析「当前」店名，而不是那份可能过期的 storeName 副本
      sleepList.push({ id: m.id, name: m.name, phone: m.phone, storeId: m.storeId || '', storeName: m.storeName || '', level: m.level || 'silver', points: m.points || 0, lastPurchaseDays: days, kind });
    }
  });
  sleepList.sort((a, b) => b.lastPurchaseDays - a.lastPurchaseDays);

  // ====== Top10 客户（按累计消费） ======
  const topSpenders = members
    .map(m => ({ id: m.id, name: m.name, phone: m.phone, type: m.type, storeId: m.storeId || '', storeName: m.storeName || '', level: m.level || 'silver', spend: Number(m.spend) || 0, points: m.points || 0 }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  // ====== 6 个月趋势 ======
  // 桶：自然月（YYYY-MM）
  // 用自然月生成桶。旧实现用 now - i*30天 近似，在 2 月和 31 天的月份附近
  // 会出现重复或跳过的月份标签。
  const monthBuckets = [];
  for (let i = TREND_MONTHS - 1; i >= 0; i--) {
    monthBuckets.push({ key: monthKeyManila(shiftMonths(now, -i)), earn: 0, redeem: 0, spend: 0 });
  }
  const monthKeyOf = monthKeyManila;
  transactions.forEach(t => {
    const ts = new Date(t.createdAt).getTime();
    if (!Number.isFinite(ts)) return;
    const key = monthKeyOf(ts);
    const bucket = monthBuckets.find(b => b.key === key);
    if (!bucket) return;
    if (t.type === 'earn') bucket.earn += Number(t.amount) || 0;
    else if (t.type === 'redeem') bucket.redeem += Math.abs(Number(t.amount) || 0);
    if (t.type === 'earn' && t.purchaseAmount) bucket.spend += Number(t.purchaseAmount) || 0;
  });

  // ====== 等级构成 / 类型构成 ======
  const levelDist = {};
  const typeDist = {};
  members.forEach(m => {
    const lv = m.level || 'silver';
    levelDist[lv] = (levelDist[lv] || 0) + 1;
    const ty = m.type || 'retail';
    typeDist[ty] = (typeDist[ty] || 0) + 1;
  });

  // ====== 即将过期积分（90 天内） ======
  const expiringSoon = [];
  members.forEach(m => {
    if (!m.pointsExpireAt) return;
    const exp = new Date(m.pointsExpireAt).getTime();
    if (!Number.isFinite(exp)) return;
    if (exp <= now) return;                       // 已过期不在此列
    const daysLeft = Math.floor((exp - now) / day);
    if (daysLeft > SOON_DAYS) return;
    if (!m.points) return;
    expiringSoon.push({
      id: m.id, name: m.name, phone: m.phone, points: m.points, expireAt: m.pointsExpireAt, daysLeft,
    });
  });
  expiringSoon.sort((a, b) => a.daysLeft - b.daysLeft);

  // ====== 门店排行（30 天发放积分） ======
  const storeRanking = stores.map(s => {
    const earn = earnByStore30.get(s.id) || 0;
    const mems = members.filter(m => m.storeId === s.id);
    const spendHere = mems.reduce((sum, m) => sum + (Number(m.spend) || 0), 0);
    const ptsHere = mems.reduce((sum, m) => sum + (Number(m.points) || 0), 0);
    return { storeId: s.id, storeName: s.name, city: s.city || '', memberCount: mems.length, earn30: earn, spendTotal: spendHere, pointsTotal: ptsHere };
  }).sort((a, b) => b.earn30 - a.earn30);

  return {
    generatedAt: new Date(now).toISOString(),
    thresholds: { sleepDays: SLEEP_DAYS, soonDays: SOON_DAYS, retentionDays: RETENTION_DAYS, trendMonths: TREND_MONTHS },
    summary: {
      membersTotal: members.length,
      membersActive: activeMembers,
      membersFrozen: frozenMembers,
      membersRetail: retailMembers,
      membersB2B: b2bMembers,
      pointsOutstanding,
      liabilityPHP: Math.round(liabilityPHP * 100) / 100,
      pointValue: pv,
    },
    activity30: {
      txCount: txCount30,
      spendPHP: Math.round(spend30 * 100) / 100,
      earnPoints: earn30,
      redeemPoints: redeem30,
      activeMembers: activeM30.size,
      repeatBuyers: repeatBuyers30,
      repeatRate: Math.round(repeatRate30 * 1000) / 1000,
    },
    storeRanking,
    sleepList: sleepList.slice(0, 20),
    sleepCount: sleepList.length,
    topSpenders,
    monthlyTrend: monthBuckets,
    levelDist,
    typeDist,
    expiringSoon: expiringSoon.slice(0, 20),
    expiringSoonCount: expiringSoon.length,
  };
}

module.exports = { overview };