// 会员积分自助查询 · 纯函数层
// ============================================================
// 面向门店顾客的公开查询（不需要登录）。本文件只做纯计算：
//   归一化输入 → 姓名匹配 → 脱敏 → 组装可对外返回的字段
// 路由、限流、审计在 server.js 里，便于这里的每个函数都能单测。
//
// 安全边界（改这里必须想清楚）：
//   · 手机号 + 姓名**两个都要对**才返回结果 —— 光知道手机号查不到别人的余额。
//   · 返回体一律脱敏：姓名只留首段，手机号中间打码。
//   · **绝不返回** operatorId / operatorName / 内部备注等门店内部信息。
// ============================================================

const { pointValue, levelOf, daysToExpiry, parseRedeemRatio } = require('./points');

/** 流水类型白名单：不在表里的一律按人工调整展示，避免把新类型原样透给顾客 */
const TX_TYPES = ['earn', 'welcome', 'redeem', 'adjust', 'expire'];

/**
 * 手机号归一化，统一成 09xxxxxxxxx 形态。
 * +63 917 482 1129 / 0917-482-1129 / 917 482 1129 → 09174821129
 */
function normalizePhone(input) {
  let d = String(input == null ? '' : input).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('63')) d = '0' + d.slice(2);
  else if (d.length === 10 && d.startsWith('9')) d = '0' + d;
  return d;
}

/** 姓名归一化：去变音符号与标点、转小写、压缩空白 */
function normalizeName(input) {
  return String(input == null ? '' : input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 姓名是否匹配（顾客凭记忆输入，要够宽松；但也不能一句话就猜到）。
 *   · 与全名完全一致 → 通过
 *   · 否则按段比对：查询的每一段都要能对上姓名的某一段**前缀**
 *     - "santos"  → 命中 "Maria Santos"
 *     - "maria s" → 命中 "Maria Santos"
 *     - "sa"      → 命中（前缀，够 2 字符即算）
 *     - "s"       → 不通过（少于 2 字符）
 */
function nameMatches(fullName, query) {
  const q = normalizeName(query);
  if (q.length < 2) return false;
  const n = normalizeName(fullName);
  if (!n) return false;
  if (n === q) return true;
  const tokens = n.split(' ');
  return q.split(' ').every(qt => tokens.some(t => t.startsWith(qt)));
}

/** 姓名脱敏：首段保留，"Maria Santos" → "Maria S."（顾客自己认得出，旁人看不出全名） */
function maskName(name) {
  const parts = String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts.slice(1).map(p => p.charAt(0).toUpperCase() + '.').join(' ');
}

/** 手机号脱敏：09174821129 → "0917 *** 1129" */
function maskPhone(input) {
  const d = normalizePhone(input);
  if (d.length < 7) return '—';
  return d.slice(0, 4) + ' *** ' + d.slice(-4);
}

/**
 * 等级进度：算出「当前档 + 离下一档还差多少」。
 * 零售用 rules.levels，B2B 用 rules.b2bTiers（两套独立体系）。
 *
 * levelKey 必须传**当前展示的等级**：
 *   · 零售的等级由累计消费推导，传进来的是 levelOf() 的结果；
 *   · **B2B 的等级是总部人工设定的**，未必等于按消费计算出来的档位。
 * 如果这里改用「按消费算」，就会出现「Strategic Partner · 还差 ₱2,155,000 升 Strategic Partner」
 * 这种自相矛盾的显示（已实测踩到）。所以有 levelKey 时以它为准，找不到才退回按消费算。
 */
function tierProgress(member, rules, levelKey) {
  const list = ((member.type === 'retail' ? rules.levels : rules.b2bTiers) || []);
  const tiers = list.slice().sort((a, b) => (a.threshold || 0) - (b.threshold || 0));
  if (!tiers.length) return null;

  const spend = Number(member.spend) || 0;
  let idx = -1;
  if (levelKey) idx = tiers.findIndex(t => t.key === levelKey);
  if (idx < 0) {
    idx = 0;
    tiers.forEach((t, i) => { if (spend >= (t.threshold || 0)) idx = i; });
  }

  const cur = tiers[idx];
  const next = tiers[idx + 1] || null;

  const span = next ? Math.max(1, (next.threshold || 0) - (cur.threshold || 0)) : 1;
  const done = next ? (spend - (cur.threshold || 0)) / span : 1;
  const percent = Math.max(0, Math.min(1, done));
  const remaining = next ? Math.max(0, (next.threshold || 0) - spend) : 0;

  return {
    currentKey: cur.key || '',
    currentName: cur.name || cur.key || '',
    nextKey: next ? (next.key || '') : null,
    nextName: next ? (next.name || next.key || '') : null,
    nextThreshold: next ? (next.threshold || 0) : null,
    // remaining = 0 但仍有下一档 → 消费已够、只是等级还没人工调上去（B2B 常见）
    qualifies: !!next && remaining === 0,
    remaining,
    percent: Math.round(percent * 1000) / 1000,
  };
}

/**
 * 组装对外的查询结果。members / stores / rules / transactions 由调用方传入，
 * 方便单测；now 也允许注入。
 */
function buildLookup({ member, stores, rules, transactions, now }) {
  const ts = Number(now) || Date.now();
  const r = rules || {};
  const pv = pointValue(r);
  const points = Number(member.points) || 0;
  const store = (stores || []).find(s => s.id === member.storeId) || null;
  // 零售等级由累计消费推导；B2B 等级是人工设定的，直接用存的值
  const level = member.type === 'retail' ? levelOf(member, r) : (member.level || '');

  // 只取最近 10 笔。操作人、内部备注等字段**不对外返回**。
  const recent = (transactions || [])
    .filter(t => t.memberId === member.id)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 10)
    .map(t => ({
      type: TX_TYPES.indexOf(t.type) !== -1 ? t.type : 'adjust',
      amount: Number(t.amount) || 0,
      purchaseAmount: Number(t.purchaseAmount) || 0,
      storeName: t.storeName || (store ? store.name : ''),
      createdAt: t.createdAt || null,
    }));

  const days = daysToExpiry(member, ts);
  const ratio = parseRedeemRatio(r.redeemRatio);

  return {
    ok: true,
    member: {
      name: maskName(member.name),
      phone: maskPhone(member.phone),
      type: member.type || 'retail',
      level,
      status: member.status || 'active',
      storeName: store ? store.name : (member.storeName || ''),
      points,
      pointsValue: Math.round(points * pv * 100) / 100,
      spend: Number(member.spend) || 0,
      memberSince: member.createdAt || null,
    },
    tier: tierProgress({ ...member, level }, r, level),
    // 只有「还没过期且确实有到期时间」才提示；过期扣减由后台任务负责，不在顾客页展示负数
    expiring: (days !== null && days > 0) ? { at: member.pointsExpireAt, days, points } : null,
    recent,
    rules: {
      spendPerPoint: Number(r.spendPerPoint) || 10,
      ratioPoints: ratio.points,
      ratioValue: ratio.value,
      pointValue: pv,
      minPoints: Number(r.redeemMinPoints) || 0,
      expiryMonths: Number(r.expiryMonths) || 0,
    },
  };
}

/** 按手机号找出候选会员（同一号码理论上唯一，但仍返回数组以容错） */
function findCandidates(members, phone) {
  const p = normalizePhone(phone);
  if (!p) return [];
  return (members || []).filter(m => normalizePhone(m.phone) === p);
}

/** 从候选里挑出姓名匹配的那一位 */
function pickMember(candidates, name) {
  return (candidates || []).find(m => nameMatches(m.name, name)) || null;
}

module.exports = {
  normalizePhone,
  normalizeName,
  nameMatches,
  maskName,
  maskPhone,
  tierProgress,
  buildLookup,
  findCandidates,
  pickMember,
  TX_TYPES,
};
