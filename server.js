// SolarPoints 会员积分系统 - 后端服务
// 数据存储：本地 JSON（data/ 目录）
// Google Sheets 同步：浏览器直连（OAuth Client ID 与 Sheet ID 存后端）
// 鉴权：bcrypt 密码 + Cookie Session（HttpOnly）

const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');

const { ensureSeeded, readAll, writeAll } = require('./lib/seed');
const store = require('./lib/store');
const { readCollection, writeCollection } = store;
const rbac = require('./lib/rbac');
const guard = require('./lib/rbac-guard');
const sheetsSync = require('./lib/sheets-sync'); // retired routes remain inert until removed
const points = require('./lib/points');
const { recordTransaction, grantPoints, deductPoints, refundPoints } = require('./lib/ledger');
const approvals = require('./lib/approvals'); // 积分审核（2026-09-19）
const mall = require('./lib/mall');           // 积分商城（2026-09-19）
const pointsExpiry = require('./lib/points-expiry'); // retired routes remain inert
const controlReminders = require('./lib/control-reminders');
const reports = require('./lib/reports');
const lookup = require('./lib/lookup');
const controlCenter = require('./lib/control-center');

const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = 'sp_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 小时

// ---------- 会话存储（内存版） ----------
const sessions = new Map();
function makeSession(userId) {
  const sid = nanoid(32);
  sessions.set(sid, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return sid;
}
function getSessionUser(req) {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(sid); return null; }
  const users = readAll('users') || [];
  const user = users.find(u => u.id === s.userId);
  if (!user) return null;
  // 账号被停用后，已存在的会话立即失效（不能只靠登录那一刻拦截）
  if (user.disabled) { sessions.delete(sid); return null; }
  // 临时口令只能访问会话资料、改密和退出接口；所有业务 API 一律 fail closed。
  if (user.mustChangePassword && !['/api/auth/me', '/api/auth/change-password'].includes(req.path)) return null;
  const { password, ...safe } = user;
  return safe;
}

// ---------- 登录失败限流（防暴力破解） ----------
// 同一 IP + 账号连续失败 5 次锁定 5 分钟。失败尝试也写审计，便于事后发现异常。
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const loginFails = new Map();

function clientIp(req) {
  return req.ip || 'unknown';
}
function loginKey(req, username) { return `${clientIp(req)}|${String(username || '').toLowerCase()}`; }
function lockRemaining(key) {
  const rec = loginFails.get(key);
  if (!rec || !rec.lockedUntil) return 0;
  const left = rec.lockedUntil - Date.now();
  if (left <= 0) { loginFails.delete(key); return 0; }
  return left;
}
function noteLoginFail(key) {
  const rec = loginFails.get(key) || { count: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILS) rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
  loginFails.set(key, rec);
  // 顺手清理过期记录，避免长期运行内存堆积
  if (loginFails.size > 500) {
    const now = Date.now();
    for (const [k, v] of loginFails) {
      if (!v.lockedUntil || v.lockedUntil < now) loginFails.delete(k);
    }
  }
  return rec;
}

// ---------- 工具 ----------
function nowIso() { return new Date().toISOString(); }
function parseControlDueDate(value) {
  if (!value) return null;
  const raw = String(value);
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59+08:00` : raw);
}
function pick(obj, keys) { const o = {}; keys.forEach(k => o[k] = obj[k]); return o; }
const { auditLog, readAuditLog } = require('./lib/audit');

// ---------- 应用 ----------
const app = express();
// Only the local Nginx hop may supply a client address; direct requests cannot spoof it.
app.set('trust proxy', 'loopback');
// RBAC：把「从请求取登录用户」的函数注入守卫层（避免守卫层反向依赖本文件）
guard.configure(getSessionUser);
// RBAC：注入「storeId → regionId」解析器。
// 会员 / 流水等业务对象只带 storeId，没有 regionId，其区域归属需从所属门店派生；
// 否则区域负责人的 region 范围会判定为空（角色形同不可用）。
guard.configureRegionResolver(() => {
  // 返回 Map 供 guard 内部一次构建、批量复用（避免逐条读门店表）
  const map = new Map();
  (readAll('stores') || []).forEach(s => { if (s.regionId) map.set(s.id, s.regionId); });
  return map;
});
// 15mb permits a 10MB stocktake spreadsheet encoded as base64; decoded limits are checked below.
app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());

// 静态资源
const RETIRED_POINTS_PATH = /^\/(?:check(?:\.[^/]*)?|api\/(?:members|pending|products|redemptions|rules|sheets|dashboard|transactions|reports|mall|public\/points-lookup)(?:\/|$))/i;
app.use((req, res, next) => {
  if (RETIRED_POINTS_PATH.test(req.path)) return res.status(410).json({ error: '旧版积分系统已下线' });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// 启动时种子
ensureSeeded();

// ============ 鉴权 ============

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });
  const key = loginKey(req, username);
  const left = lockRemaining(key);
  if (left > 0) {
    auditLog(`login blocked (too many failures): ${username} from ${clientIp(req)}`);
    return res.status(429).json({ error: `登录失败次数过多，请 ${Math.ceil(left / 60000)} 分钟后再试` });
  }
  const users = readAll('users') || [];
  const user = users.find(u => u.username === username);
  if (!user) {
    const rec = noteLoginFail(key);
    auditLog(`login failed (no such user): ${username} from ${clientIp(req)}, attempt ${rec.count}`);
    return res.status(401).json({ error: '账号或密码错误' });
  }
  if (!bcrypt.compareSync(password, user.password)) {
    const rec = noteLoginFail(key);
    auditLog(`login failed (bad password): ${username} from ${clientIp(req)}, attempt ${rec.count}`);
    return res.status(401).json({ error: '账号或密码错误' });
  }
  loginFails.delete(key);
  // 放在密码校验之后，避免通过错误码探测账号是否存在
  if (user.disabled) {
    auditLog(`login denied (disabled): ${user.username}`);
    return res.status(403).json({ error: '该账号已停用，请联系总部管理员' });
  }
  const sid = makeSession(user.id);
  // 生产走 Nginx 反代，req.secure 恒为 false，要读 x-forwarded-proto 才能判断真实协议
  const isHttps = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  res.cookie(SESSION_COOKIE, sid, { httpOnly: true, sameSite: 'lax', secure: isHttps, maxAge: SESSION_TTL_MS });
  const { password: _pw, ...safe } = user;
  auditLog(`login: ${user.username}`);
  res.json({ ok: true, user: safe, mustChangePassword: !!user.mustChangePassword });
});

app.post('/api/auth/logout', (req, res) => {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (sid) sessions.delete(sid);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const u = getSessionUser(req);
  if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：把后端**已经算好的**权限清单原样下发给前端。
  // 这只是「暴露既有结果」，不改动权限模型、矩阵或任何判定函数。
  // 前端据此做菜单/按钮显隐（纯 UI 层）；**真正的安全边界仍在后端** ——
  // 前端即使被篡改或直接调 API，后端仍会按权限返回 403。
  //   role   ：规范化后的角色名（仅用于界面显示标签）
  //   grants ：[{ p: 权限, s: 数据范围 }]，前端按此判断「有没有某权限 / 该权限是什么范围」
  res.json({
    user: u,
    role: rbac.normalizeRole(u.role),
    grants: rbac.grantsFor(u.role),
    mustChangePassword: !!u.mustChangePassword,
  });
});

app.post('/api/auth/change-password', (req, res) => {
  const u = getSessionUser(req);
  if (!u) return res.status(401).json({ error: '未登录' });
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: '请填写当前密码和新密码' });
  if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  const users = readAll('users');
  const user = users.find(x => x.id === u.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(400).json({ error: '当前密码不正确' });
  }
  if (bcrypt.compareSync(newPassword, user.password)) return res.status(400).json({ error: '新密码不能与当前密码相同' });
  const wasForcedPasswordChange = !!user.mustChangePassword;
  user.password = bcrypt.hashSync(newPassword, 12);
  user.mustChangePassword = false;
  writeAll('users', users);
  if (wasForcedPasswordChange && user.username === 'admin') {
    try { fs.rmSync(path.join(store.DATA_DIR, 'INITIAL_ADMIN_CREDENTIALS.txt'), { force: true }); }
    catch (err) { auditLog(`initial admin credential file cleanup failed for ${user.username}`); }
  }
  // 安全审计 2026-09-20 修复：改密后清掉该用户的所有旧 session，
  // 防止账号被盗后攻击者的旧会话在 12 小时 TTL 内继续有效。
  const uid = u.id;
  for (const [sid, s] of sessions) {
    if (s.userId === uid) sessions.delete(sid);
  }
  const replacementSid = makeSession(uid);
  const isHttps = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  res.cookie(SESSION_COOKIE, replacementSid, { httpOnly: true, sameSite: 'lax', secure: isHttps, maxAge: SESSION_TTL_MS });
  auditLog(`change-password: ${user.username} (旧 session 已全部失效)`);
  res.json({ ok: true, mustChangePassword: false });
});

// ============ 会员管理 ============

// —— 安全审计 2026-09-20：消费金额上限与数值校验 ——
// 防止手滑多打几个 0 就造出天文数字积分（实测 1e15 金额能发放 1e14 分）。
// 放在文件最前面（会员管理段落开头），确保建档接口引用时已定义。
const MAX_PURCHASE = 100000000; // ₱1 亿，正常光伏零售单品远不到
const MAX_POINTS_OPENING = 10000000; // 期初余额上限

function recalcLevel(member, rules) {
  // 等级完全由积分引擎的等级规则决定（零售按累计消费升级；B2B 等级手动设置）
  return points.levelOf(member, rules);
}

app.get('/api/members', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：member.view
  if (!guard.checkPerm(req, res, 'member.view')) return;
  const { q, type, storeId, level, status, page = 1, pageSize = 20 } = req.query;
  let list = readAll('members') || [];
  if (q) {
    const s = String(q).toLowerCase();
    list = list.filter(m => String(m.name || '').toLowerCase().includes(s) || String(m.phone || '').replace(/[\s\-()]/g, '').includes(s.replace(/[\s\-()]/g, '')));
  }
  if (type) list = list.filter(m => m.type === type);
  if (storeId) list = list.filter(m => m.storeId === storeId);
  if (level) list = list.filter(m => m.level === level);
  if (status) list = list.filter(m => m.status === status);
  // RBAC：数据范围（后端强制的安全边界，前端过滤不算数）
  list = guard.filterList(list, req, 'member');
  list = list.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const ps = Math.max(1, Math.min(100, parseInt(pageSize) || 20));
  const total = list.length;
  const start = (Math.max(1, parseInt(page) || 1) - 1) * ps;
  const items = list.slice(start, start + ps);
  res.json({ total, items, page: Math.max(1, parseInt(page) || 1), pageSize: ps });
});

// 按 ID 取单个会员（积分商城选会员后要用，按 q 搜索拿不到完整字段）
app.get('/api/members/:id', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const m = (readAll('members') || []).find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: '会员不存在' });
  // RBAC：member.view + 数据范围
  if (!guard.check(req, res, 'member.view', m)) return;
  res.json(m);
});

app.post('/api/members', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：member.create
  if (!guard.checkPerm(req, res, 'member.create')) return;
  const b = req.body || {};
  if (!b.name || !b.phone) return res.status(400).json({ error: '请填写姓名和手机号' });
  const stores = readAll('stores');
  const members = readAll('members');
  const rules = readAll('rules');

  // 解析归属门店。旧实现解析不出来会静默回退到第一家门店，
  // 结果是「店长被解绑后建出 storeId 为空的会员」或「管理员传错门店被悄悄改掉」。
  let targetStore = null;
  // RBAC：数据范围为 store / region 的角色，建档门店由后端强制，不信任入参。
  const createScope = guard.scopeOf(req, 'member');
  if (createScope.level === 'store') {
    // store 范围：强制落在自己门店（原有行为，保持不变）
    targetStore = stores.find(s => s.id === createScope.storeId) || null;
    if (!targetStore) return res.status(400).json({ error: '当前账号未绑定门店，无法登记会员，请联系总部管理员' });
  } else if (createScope.level === 'region') {
    // region 范围：只能建在本区域内 —— 全部 fail-closed
    //   传了 storeId  → 必须是本区域的门店，否则拒绝（不能建到别的区域去）
    //   没传 storeId  → 只回退到「本区域第一家门店」，绝不回退到全连锁第一家
    //   本区域没有门店 → 拒绝
    if (!createScope.regionId) {
      return res.status(403).json({ error: '当前账号未绑定管辖区域，无法登记会员，请联系总部管理员' });
    }
    const regionStores = stores.filter(s => s.regionId === createScope.regionId);
    if (b.storeId) {
      targetStore = regionStores.find(s => s.id === b.storeId) || null;
      if (!targetStore) {
        return res.status(403).json({ error: '所选门店不在你的管辖区域内，无权在该门店登记会员' });
      }
    } else {
      targetStore = regionStores[0] || null;
      if (!targetStore) {
        return res.status(400).json({ error: '你管辖的区域内还没有门店，请联系总部管理员' });
      }
    }
  } else {
    // global / hq / philippines 等：保持原有行为
    if (b.storeId) {
      targetStore = stores.find(s => s.id === b.storeId) || null;
      if (!targetStore) return res.status(400).json({ error: '所选门店不存在，请重新选择' });
    } else {
      targetStore = stores[0] || null;
    }
    if (!targetStore) return res.status(400).json({ error: '系统中还没有门店，请先创建门店' });
  }

  // 手机号查重：整条连锁内一人一号，避免同一顾客在两个门店各建一份、积分被分散
  const phone = String(b.phone).replace(/[\s\-()]/g, '');
  const dup = members.find(m => String(m.phone).replace(/[\s\-()]/g, '') === phone);
  if (dup) return res.status(409).json({ error: `该手机号已登记过（${dup.name}），请勿重复建档`, existing: dup });
  // RBAC：敏感字段（spend / status）与建档发分由 points.adjust 控制。
  // 原为 role === 'admin'；迁移后不再依赖角色名 —— 凡拥有 points.adjust 的角色
  // （当前为 admin 与 philippines_manager）才可录入期初消费 / 发欢迎积分。
  const canGrantOnCreate = rbac.hasPermission(u, 'points.adjust');
  const newM = {
    id: nanoid(),
    name: String(b.name).trim(),
    phone: String(b.phone).trim(),
    type: b.type === 'b2b' ? 'b2b' : 'retail',
    level: b.level || 'silver',
    points: 0,
    // 安全审计 2026-09-20：建档不得带 spend/points/status，否则「建档即发分」会绕过积分审核。
    // RBAC：这些敏感字段由 points.adjust 控制（不再写死角色名）。
    spend: canGrantOnCreate ? Number(b.spend || 0) : 0,
    storeId: targetStore.id,
    storeName: targetStore.name,
    status: canGrantOnCreate && b.status === 'frozen' ? 'frozen' : 'active',
    notes: b.notes || '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    pointsExpireAt: null,
    lastEarnAt: null,
    lastPurchaseAt: null,
    earnedTotal: 0,
    redeemedTotal: 0,
  };
  newM.level = recalcLevel(newM, rules);
  members.push(newM);
  // —— 安全审计 2026-09-20 修复：建档不得带 spend/points，否则「建档即发分」会绕过积分审核。
  //    RBAC：由 points.adjust 控制（原为 role === 'admin'）
  if (canGrantOnCreate) {
    // 欢迎积分：规则里配了多少就发多少（此前该配置从未生效）
    const welcome = Number(rules.welcomeBonus) || 0;
    if (welcome > 0) {
      grantPoints(newM, welcome, rules, 'welcome', {
        reason: 'Welcome bonus',
        operator: u,
      });
    }
    // 管理员建档时可录入期初消费，一并补记积分
    if (Number(b.spend) > 0 && Number.isFinite(Number(b.spend)) && Number(b.spend) <= MAX_PURCHASE) {
      const earn = points.calcEarnPoints(Number(b.spend), newM, rules);
      if (earn.points > 0) {
        grantPoints(newM, earn.points, rules, 'earn', {
          reason: `Opening purchase ₱${Number(b.spend)}`,
          purchaseAmount: Number(b.spend),
          basePoints: earn.basePoints,
          operator: u,
        });
        newM.lastPurchaseAt = nowIso();
        newM.level = recalcLevel(newM, rules);
      }
    }
    // 批量导入历史会员时可能带着旧余额：作为「期初余额」入账，保证流水能对上
    const opening = Number(b.points) || 0;
    if (opening > 0 && Number.isFinite(opening) && opening <= MAX_POINTS_OPENING) {
      newM.points = (Number(newM.points) || 0) + opening;
      newM.earnedTotal = (Number(newM.earnedTotal) || 0) + opening;
      newM.updatedAt = nowIso();
      recordTransaction(newM, 'adjust', opening, {
        reason: 'Opening balance (imported)',
        operator: u,
      });
    }
  }
  writeAll('members', members);
  const welcomeLog = canGrantOnCreate ? `(+${Number(rules.welcomeBonus) || 0} welcome, ${newM.points} pts)` : `(0 welcome, 0 pts)`;
  auditLog(`create member: ${newM.name} ${welcomeLog} by ${u.username}`);
  res.json({ ok: true, member: newM });
});

app.put('/api/members/:id', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const id = req.params.id;
  const members = readAll('members');
  const idx = members.findIndex(m => m.id === id);
  if (idx < 0) return res.status(404).json({ error: '会员不存在' });
  const m = members[idx];
  // RBAC：member.edit + 数据范围（后端强制安全边界）
  if (!guard.check(req, res, 'member.edit', m)) return;
  const b = req.body || {};
  // —— 字段级权限（RBAC，替代原先手写的 role === 'admin' 判断）——
  //   基础字段 name / phone / notes：有 member.edit 即可改
  //   敏感字段 type / level / spend / storeId / status：需要 member.manage
  //   积分余额 points：需要 points.adjust（另有下方显式校验）
  //   这样「有 member.edit」不会顺带获得「member.manage」。
  const canManage = rbac.hasPermission(u, 'member.manage');
  const stores = readAll('stores');
  const rules = readAll('rules');
  if (b.name) m.name = String(b.name).trim();
  if (b.phone) m.phone = String(b.phone).trim();
  if (canManage && b.type && b.type !== m.type) {
    if (!['retail', 'b2b'].includes(b.type)) return res.status(400).json({ error: '会员类型无效' });
    // 零售与 B2B 是两套独立的等级体系，直接改类型会把零售等级挂在 B2B 阶梯里，
    // 导致「等级构成」统计出现不属于该体系的档位。跨体系转换时重置到目标体系的起始档。
    m.type = b.type;
    const lowest = (rules.b2bTiers || []).slice().sort((x, y) => (x.threshold || 0) - (y.threshold || 0))[0];
    m.level = b.type === 'b2b' ? (lowest?.key || 'bronze') : 'silver';
  }
  // 人工改积分余额：需要 points.adjust，且必须留痕（旧实现是直接覆盖，无法对账）
  if (typeof b.points === 'number' && Number.isFinite(b.points) && b.points !== m.points
      && rbac.hasPermission(u, 'points.adjust')) {
    const diff = b.points - (Number(m.points) || 0);
    const before = Number(m.points) || 0;
    m.points = b.points;
    m.updatedAt = nowIso();
    recordTransaction(m, 'adjust', diff, {
      reason: `Manual adjustment (${before} → ${b.points})`,
      operator: u,
    });
    auditLog(`adjust points: ${m.name} ${diff > 0 ? '+' : ''}${diff} by ${u.username}`);
  }
  if (canManage && typeof b.spend === 'number') m.spend = b.spend;
  if (canManage && b.storeId && b.storeId !== m.storeId) {
    const s = stores.find(x => x.id === b.storeId);
    if (!s) return res.status(400).json({ error: '所选门店不存在，请重新选择' });
    m.storeId = s.id;
    m.storeName = s.name;
  }
  if (canManage && b.status) m.status = b.status;
  if (typeof b.notes === 'string') m.notes = b.notes;
  m.level = recalcLevel(m, rules);
  m.updatedAt = nowIso();
  members[idx] = m;
  writeAll('members', members);
  auditLog(`update member: ${m.name} by ${u.username}`);
  res.json({ ok: true, member: m });
});

app.delete('/api/members/:id', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：member.delete（权限判定，不依赖角色名）
  if (!guard.checkPerm(req, res, 'member.delete')) return;
  const id = req.params.id;
  const members = readAll('members');
  const idx = members.findIndex(m => m.id === id);
  if (idx < 0) return res.status(404).json({ error: '会员不存在' });
  const removed = members[idx];
  // RBAC：数据范围（后端强制）
  if (!guard.check(req, res, 'member.delete', removed)) return;
  members.splice(idx, 1);
  writeAll('members', members);
  // 连带删除该会员的积分流水：否则会留下找不到主人的孤儿流水，
  // 永远留在流水表和 Google 表格里，也无法对账。
  const txs = readAll('transactions') || [];
  const kept = txs.filter(t => t.memberId !== removed.id);
  const removedTx = txs.length - kept.length;
  if (removedTx > 0) writeAll('transactions', kept);
  auditLog(`delete member: ${removed.name} by ${u.username} (同时移除 ${removedTx} 条流水, 余额 ${removed.points})`);
  res.json({ ok: true, removedTransactions: removedTx });
});

/** 实时报价：门店输入消费金额时，前端拿它显示「将获得 X 分 / 最多可用 Y 分」 */
app.get('/api/members/:id/quote', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const m = (readAll('members') || []).find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: '会员不存在' });
  // 只读接口同样要按门店隔离，否则店长能查到他店会员的余额与报价
  // RBAC：points.view + 数据范围（后端强制）
  if (!guard.check(req, res, 'points.view', m)) return;
  const rules = readAll('rules');
  const amount = Number(req.query.purchaseAmount) || 0;
  const earn = points.calcEarnPoints(amount, m, rules);
  const redeem = points.redeemQuote(m, rules, amount);
  res.json({
    memberId: m.id,
    purchaseAmount: amount,
    earn: { ...earn, amount },
    redeem,
    rules: {
      spendPerPoint: rules.spendPerPoint,
      redeemRatio: rules.redeemRatio,
      redeemMinPoints: rules.redeemMinPoints,
      redeemMaxPercent: rules.redeemMaxPercent,
      expiryMonths: rules.expiryMonths,
    },
    daysToExpiry: points.daysToExpiry(m, Date.now()),
  });
});

/**
 * 登记一笔消费：输入订单金额，系统按规则自动算分发放
 * body: { amount, note? }
 */
// —— 新增积分的统一出口 ——
// 消费登记（purchase）与手工补录（earn）都走这里，保证「管理员直接操作」和
// 「店长提交后由管理员审核通过」两条路径算出来的积分完全一致。
// 只修改传入的 member 对象，不落盘；调用方负责 writeAll('members', ...)。
function applyEarnPoints(m, payload, rules, operator) {
  if (payload.kind === 'purchase') {
    const amount = Number(payload.purchaseAmount);
    const earn = points.calcEarnPoints(amount, m, rules);
    m.spend = (Number(m.spend) || 0) + amount;
    m.lastPurchaseAt = nowIso();
    m.updatedAt = nowIso();
    const before = m.level;
    const tx = grantPoints(m, earn.points, rules, 'earn', {
      reason: payload.reason || `Purchase ₱${amount}`,
      purchaseAmount: amount,
      basePoints: earn.basePoints,
      operator,
    });
    m.level = recalcLevel(m, rules); // 等级仅作身份标识，不再影响赚分速度
    return {
      tx, granted: earn.points, earn,
      levelUp: before !== m.level ? { from: before, to: m.level } : null,
    };
  }
  const amt = Math.abs(Number(payload.points) || 0);
  const before = m.level;
  const tx = grantPoints(m, amt, rules, 'earn', {
    reason: payload.reason || 'Manual bonus',
    purchaseAmount: payload.purchaseAmount || null,
    basePoints: null,
    operator,
  });
  m.level = recalcLevel(m, rules);
  return {
    tx, granted: amt, earn: null,
    levelUp: before !== m.level ? { from: before, to: m.level } : null,
  };
}

app.post('/api/members/:id/purchase', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const amount = Number((req.body || {}).amount);
  if (!(amount > 0) || !Number.isFinite(amount)) return res.status(400).json({ error: '请输入正确的消费金额' });
  if (amount > MAX_PURCHASE) return res.status(400).json({ error: '消费金额过大，请核对' });
  const members = readAll('members');
  const idx = members.findIndex(m => m.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '会员不存在' });
  const m = members[idx];
  // RBAC：points.grant + 数据范围（后端强制）
  if (!guard.check(req, res, 'points.grant', m)) return;
  if (m.status === 'frozen') return res.status(400).json({ error: '该会员已冻结，无法登记消费' });
  const rules = readAll('rules');

  // 2026-09-19 起：店长登记消费不再立即到账，先进入待审核；管理员自己操作则直接生效
  // 「直发 or 进审核」由 points.grant.direct 决定（独立能力，不依赖 approval.approve）：
  //   拥有 points.grant.direct（admin / philippines_manager）→ 直接发放
  //   否则（store_manager / regional_manager 等）→ 提交待审核
  if (!rbac.hasPermission(u, 'points.grant.direct')) {
    const v = approvals.validateRequest({
      kind: 'purchase', purchaseAmount: amount, reason: (req.body || {}).note,
    });
    if (!v.ok) return res.status(400).json({ error: v.error });
    const rec = approvals.buildPending(m, u, v.value, nanoid(), nowIso());
    // 预计发放多少分：审核列表要显示这个数字，管理员才好判断批不批。
    // 实际发放以通过那一刻的规则为准（规则可能在这期间被改过）。
    rec.estPoints = points.calcEarnPoints(amount, m, rules).points;
    const list = readAll('pending') || [];
    list.unshift(rec);
    writeAll('pending', list);
    auditLog(`pending: ${m.name} purchase ₱${amount} submitted by ${u.username} (await approval)`);
    return res.json({
      ok: true, pending: true, member: m, request: rec,
      message: '已提交，待管理员审核通过后计入积分',
    });
  }

  const result = applyEarnPoints(m, {
    kind: 'purchase', purchaseAmount: amount, reason: (req.body || {}).note,
  }, rules, u);
  members[idx] = m;
  writeAll('members', members);
  auditLog(`purchase: ${m.name} ₱${amount} → +${result.granted} pts by ${u.username}`);
  res.json({
    ok: true,
    member: m,
    transaction: result.tx,
    earn: { ...(result.earn || {}), amount },
    levelUp: result.levelUp,
  });
});

app.post('/api/members/:id/transactions', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const id = req.params.id;
  const { type, amount, reason, purchaseAmount } = req.body || {};
  const raw = Number(amount || 0);
  if (!['earn', 'redeem', 'adjust'].includes(type)) return res.status(400).json({ error: '交易类型无效' });
  if (!raw) return res.status(400).json({ error: '请填写正确的积分变动数量' });
  const members = readAll('members');
  const idx = members.findIndex(m => m.id === id);
  if (idx < 0) return res.status(404).json({ error: '会员不存在' });
  const m = members[idx];
  // RBAC：按交易类型判定权限（earn→points.grant / redeem→points.deduct / adjust→points.adjust）
  const permByType = { earn: 'points.grant', redeem: 'points.deduct', adjust: 'points.adjust' };
  if (!guard.check(req, res, permByType[type], m)) return;
  const rules = readAll('rules');

  let tx;
  if (type === 'earn') {
    const amt = Math.abs(raw);
    // 手工补录积分（例如系统上线前的历史消费）
    // 2026-09-19 起：店长补录需管理员审核，管理员自己操作直接生效
    // RBAC：与 purchase 一致，用 points.grant.direct 判定「直发 or 进审核」
    if (!rbac.hasPermission(u, 'points.grant.direct')) {
      const v = approvals.validateRequest({ kind: 'earn', points: amt, purchaseAmount, reason });
      if (!v.ok) return res.status(400).json({ error: v.error });
      const rec = approvals.buildPending(m, u, v.value, nanoid(), nowIso());
      rec.estPoints = amt; // 手工补录的积分是写死的，不随规则变
      const list = readAll('pending') || [];
      list.unshift(rec);
      writeAll('pending', list);
      auditLog(`pending: ${m.name} earn +${amt} submitted by ${u.username} (await approval)`);
      return res.json({
        ok: true, pending: true, member: m, request: rec,
        message: '已提交，待管理员审核通过后计入积分',
      });
    }
    const result = applyEarnPoints(
      m,
      { kind: 'earn', points: amt, purchaseAmount: Number(purchaseAmount) || null, reason },
      rules, u,
    );
    tx = result.tx;
  } else if (type === 'redeem') {
    const amt = Math.abs(raw);
    // 核销：按规则校验最低门槛与单笔抵扣比例
    const check = points.validateRedeem(m, rules, amt, purchaseAmount);
    if (!check.ok) return res.status(400).json({ error: check.error, quote: check.quote || null });
    tx = deductPoints(m, amt, 'redeem', {
      reason: reason || `Points redeemed${check.value ? ` (₱${check.value.toFixed(2)})` : ''}`,
      purchaseAmount: Number(purchaseAmount) || null,
      operator: u,
    });
  } else {
    // 人工调整：可正可负，必须留痕
    // RBAC：points.adjust（权限与范围已在路由入口校验，这里再做一次显式权限判定）
    if (!rbac.hasPermission(u, 'points.adjust')) return res.status(403).json({ error: '无权限手动调整积分' });
    if (raw < 0 && Math.abs(raw) > (Number(m.points) || 0)) return res.status(400).json({ error: '积分余额不足' });
    const before = Number(m.points) || 0;
    m.points = before + raw;
    m.updatedAt = nowIso();
    tx = recordTransaction(m, 'adjust', raw, {
      reason: reason || `Manual adjustment (${before} → ${m.points})`,
      operator: u,
    });
  }
  members[idx] = m;
  writeAll('members', members);
  auditLog(`transaction: ${m.name} ${type} ${raw > 0 ? '+' : ''}${raw} by ${u.username}`);
  res.json({ ok: true, member: m, transaction: tx });
});

app.get('/api/members/:id/transactions', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const id = req.params.id;
  const target = (readAll('members') || []).find(x => x.id === id);
  if (!target) return res.status(404).json({ error: '会员不存在' });
  // RBAC：points.view + 数据范围（后端强制）
  if (!guard.check(req, res, 'points.view', target)) return;
  const txs = (readAll('transactions') || []).filter(t => t.memberId === id).slice(0, 100);
  res.json({ items: txs });
});

// ============ 积分审核（2026-09-19 上线）============
// 店长提交的新增积分（消费登记 / 手工补录）先进这里，管理员通过后才会计入会员余额。
// 交易流水 transactions 是账本，只记真实发生的变动，所以待审核期间**不写流水**。

app.get('/api/pending', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：approval.view（原来只校验登录，任何登录用户都能看待审核列表）
  if (!guard.checkPerm(req, res, 'approval.view')) return;
  const status = String((req.query || {}).status || 'pending');
  // RBAC：数据范围（取代原先业务层的 approvals.visibleFor —— 范围判定统一收口到 RBAC）
  let list = guard.filterList(readAll('pending'), req, 'approval');
  if (status && status !== 'all') list = list.filter(r => r.status === status);
  list.sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')));
  res.json({ items: list, count: list.length });
});

app.post('/api/pending/:id/approve', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC（L1）责任：这个用户有没有资格审批 → 只看 approval.approve
  if (!guard.checkPerm(req, res, 'approval.approve')) return;
  const list = readAll('pending') || [];
  const idx = list.findIndex(r => r.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '申请不存在' });
  const rec = list[idx];
  // RBAC：数据范围（不能审批其他门店的申请）
  if (!guard.check(req, res, 'approval.approve', rec)) return;
  // L2 业务状态守卫：这个申请现在还能不能审批（已处理过的不行）→ 只看状态，不看角色
  const can = approvals.canDecide(rec);
  if (!can.ok) return res.status(400).json({ error: can.error });

  const members = readAll('members');
  const mi = members.findIndex(x => x.id === rec.memberId);
  if (mi < 0) return res.status(404).json({ error: '该申请关联的会员已不存在，无法发放' });
  const m = members[mi];
  if (m.status === 'frozen') return res.status(400).json({ error: '该会员已冻结，无法发放积分' });

  const rules = readAll('rules');
  // 流水的 operator 记提交人（店长），因为活是他干的；decidedBy 记审核人
  const result = applyEarnPoints(m, {
    kind: rec.kind,
    purchaseAmount: rec.purchaseAmount,
    points: rec.points,
    reason: rec.reason,
  }, rules, { id: rec.requestedBy, name: rec.requestedByName });

  members[mi] = m;
  writeAll('members', members);

  rec.status = approvals.STATUS.APPROVED;
  rec.decidedBy = u.id;
  rec.decidedByName = u.name || u.username;
  rec.decidedAt = nowIso();
  rec.decisionNote = String(((req.body || {}).note) || '').trim() || null;
  rec.transactionId = result.tx.id;
  rec.grantedPoints = result.granted;
  list[idx] = rec;
  writeAll('pending', list);

  auditLog(`approve: ${m.name} +${result.granted} pts (${rec.kind}) requested by ${rec.requestedByName2 || rec.requestedByName}, approved by ${u.username}`);
  res.json({ ok: true, member: m, request: rec, transaction: result.tx, levelUp: result.levelUp });
});

app.post('/api/pending/:id/reject', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC（L1）：审批能力 → approval.reject
  if (!guard.checkPerm(req, res, 'approval.reject')) return;
  const v = approvals.validateDecision(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  // 驳回必须写原因：店长要靠这句话知道为什么被打回，否则只会反复提交
  if (!v.value.note) return res.status(400).json({ error: '请填写驳回原因' });

  const list = readAll('pending') || [];
  const idx = list.findIndex(r => r.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '申请不存在' });
  const rec = list[idx];
  // RBAC：数据范围（不能驳回其他门店的申请）
  if (!guard.check(req, res, 'approval.reject', rec)) return;
  // L2 业务状态守卫：只看状态
  const can = approvals.canDecide(rec);
  if (!can.ok) return res.status(400).json({ error: can.error });

  rec.status = approvals.STATUS.REJECTED;
  rec.decidedBy = u.id;
  rec.decidedByName = u.name || u.username;
  rec.decidedAt = nowIso();
  rec.decisionNote = v.value.note;
  list[idx] = rec;
  writeAll('pending', list);

  auditLog(`reject: ${rec.memberName} ${rec.kind} rejected by ${u.username} (${v.value.note})`);
  res.json({ ok: true, request: rec });
});

// ============ 积分商城（2026-09-19 上线）============
// 店长代客兑换：选会员 → 选商品 → 扣分生成兑换单 → 店长点「已发放」。
// 商品图片存 data/uploads/mall/（不进 public/），因为部署时 public/ 会被整体覆盖。

const MALL_IMG_DIR = path.join(__dirname, 'data', 'uploads', 'mall');

function saveMallImage(dataUrl) {
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || ''));
  if (!m) return { ok: false, error: '图片格式不支持（仅 PNG / JPG / WEBP）' };
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return { ok: false, error: '图片内容为空' };
  if (buf.length > 3 * 1024 * 1024) return { ok: false, error: '图片过大（上限 3MB）' };
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const name = `${nanoid(12)}.${ext}`;
  fs.mkdirSync(MALL_IMG_DIR, { recursive: true });
  fs.writeFileSync(path.join(MALL_IMG_DIR, name), buf);
  return { ok: true, value: name };
}

app.post('/api/products/image', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：mall.edit（商品图片属于商品维护）
  if (!guard.checkPerm(req, res, 'mall.edit')) return;
  const saved = saveMallImage((req.body || {}).image);
  if (!saved.ok) return res.status(400).json({ error: saved.error });
  res.json({ ok: true, file: saved.value });
});

// 图片只对有商城查看权限的用户开放（商城目前只在后台使用，没有顾客端页面）
app.get('/api/mall/image/:file', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：mall.view（原来只校验登录）
  if (!guard.checkPerm(req, res, 'mall.view')) return;
  const name = path.basename(String(req.params.file || '')); // basename 防目录穿越
  if (!/^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/i.test(name)) return res.status(400).json({ error: '文件名非法' });
  const file = path.join(MALL_IMG_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '图片不存在' });
  res.type(path.extname(name)).sendFile(file);
});

app.get('/api/products', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：mall.view（原来只校验登录）
  if (!guard.checkPerm(req, res, 'mall.view')) return;
  const items = mall.sortProducts(mall.visibleProducts(readAll('products'), u));
  res.json({ items });
});

app.post('/api/products', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：mall.create
  if (!guard.checkPerm(req, res, 'mall.create')) return;
  const built = mall.buildProduct(req.body || {}, nanoid(), nowIso());
  if (!built.ok) return res.status(400).json({ error: built.error });
  const list = readAll('products') || [];
  list.push(built.value);
  writeAll('products', list);
  auditLog(`product: created ${built.value.name} (${built.value.points} pts) by ${u.username}`);
  res.json({ ok: true, product: built.value });
});

app.put('/api/products/:id', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：mall.edit
  if (!guard.checkPerm(req, res, 'mall.edit')) return;
  const list = readAll('products') || [];
  const idx = list.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '商品不存在' });
  const patched = mall.patchProduct(list[idx], req.body || {}, nowIso());
  if (!patched.ok) return res.status(400).json({ error: patched.error });
  list[idx] = patched.value;
  writeAll('products', list);
  auditLog(`product: updated ${patched.value.name} by ${u.username}`);
  res.json({ ok: true, product: patched.value });
});

app.delete('/api/products/:id', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：mall.delete
  if (!guard.checkPerm(req, res, 'mall.delete')) return;
  const list = readAll('products') || [];
  const idx = list.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '商品不存在' });
  // 软删除：历史兑换单还要显示商品名，不能真删
  list[idx] = { ...list[idx], active: false, updatedAt: nowIso() };
  writeAll('products', list);
  auditLog(`product: removed ${list[idx].name} by ${u.username}`);
  res.json({ ok: true });
});

app.get('/api/redemptions', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：mall.view（原来只校验登录）
  if (!guard.checkPerm(req, res, 'mall.view')) return;
  const status = String((req.query || {}).status || 'all');
  // RBAC：数据范围（取代原先业务层的 mall.visibleFor —— 范围判定统一收口到 RBAC）
  let list = guard.filterList(readAll('redemptions'), req, 'mall');
  if (status !== 'all') list = list.filter(r => r.status === status);
  list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json({ items: list, count: list.length });
});

app.post('/api/redemptions', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const { memberId, productId } = req.body || {};
  if (!memberId || !productId) return res.status(400).json({ error: '请选择会员与商品' });

  const members = readAll('members');
  const mi = members.findIndex(x => x.id === memberId);
  if (mi < 0) return res.status(404).json({ error: '会员不存在' });
  const m = members[mi];
  // RBAC：mall.redeem + 数据范围（后端强制）
  if (!guard.check(req, res, 'mall.redeem', m)) return;

  const products = readAll('products') || [];
  const p = products.find(x => x.id === productId);
  // L2 业务状态守卫：商品是否上架、会员是否冻结、积分是否够（只看状态，不看角色）
  const check = mall.validateRedeem(m, p);
  if (!check.ok) return res.status(400).json({ error: check.error });

  // 兑换=扣分，走账本；之后「已发放」只是履约状态，不再动账目
  const tx = deductPoints(m, check.value.points, 'redeem', {
    reason: `兑换商品：${p.name}`,
    operator: u,
  });
  const rec = mall.buildRedemption(m, p, u, nanoid(), nowIso(), tx.id);
  const list = readAll('redemptions') || [];
  list.unshift(rec);
  writeAll('redemptions', list);

  members[mi] = m;
  writeAll('members', members);

  auditLog(`redeem: ${m.name} 兑换「${p.name}」 -${check.value.points} pts by ${u.username}`);
  res.json({ ok: true, member: m, redemption: rec, transaction: tx });
});

app.post('/api/redemptions/:id/fulfill', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const list = readAll('redemptions') || [];
  const idx = list.findIndex(r => r.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '兑换单不存在' });
  const rec = list[idx];
  // RBAC：mall.fulfill + 数据范围（后端强制）
  if (!guard.check(req, res, 'mall.fulfill', rec)) return;
  // L2 业务状态守卫：已发放/已取消的单不能再发放（只看状态）
  const can = mall.canFulfill(rec);
  if (!can.ok) return res.status(400).json({ error: can.error });

  rec.status = mall.REDEEM_STATUS.FULFILLED;
  rec.fulfilledBy = u.id;
  rec.fulfilledByName = u.name || u.username;
  rec.fulfilledAt = nowIso();
  list[idx] = rec;
  writeAll('redemptions', list);
  auditLog(`fulfill: ${rec.memberName} 兑换「${rec.productName}」已发放 by ${u.username}`);
  res.json({ ok: true, redemption: rec });
});

app.post('/api/redemptions/:id/cancel', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const list = readAll('redemptions') || [];
  const idx = list.findIndex(r => r.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '兑换单不存在' });
  const rec = list[idx];
  // RBAC：mall.cancel + 数据范围（后端强制）
  if (!guard.check(req, res, 'mall.cancel', rec)) return;
  // L2 业务状态守卫：已发放/已取消的单不能再取消（只看状态）
  const can = mall.canCancel(rec);
  if (!can.ok) return res.status(400).json({ error: can.error });

  // 取消要把积分退回去，所以必须走账本，不能只改状态
  const members = readAll('members');
  const mi = members.findIndex(x => x.id === rec.memberId);
  if (mi < 0) return res.status(404).json({ error: '该兑换单关联的会员已不存在，无法退分' });
  const m = members[mi];
  const tx = refundPoints(m, rec.points, 'redeem', {
    reason: `取消兑换退回：${rec.productName}`,
    operator: u,
  });
  members[mi] = m;
  writeAll('members', members);

  rec.status = mall.REDEEM_STATUS.CANCELLED;
  rec.cancelledBy = u.id;
  rec.cancelledByName = u.name || u.username;
  rec.cancelledAt = nowIso();
  rec.refundTransactionId = tx.id;
  list[idx] = rec;
  writeAll('redemptions', list);
  auditLog(`cancel: ${rec.memberName} 兑换「${rec.productName}」已取消，退回 ${rec.points} pts by ${u.username}`);
  res.json({ ok: true, member: m, redemption: rec });
});

// ============ 门店管理 ============

app.get('/api/stores', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：store.view（原来只校验登录 —— 任何登录用户都能拿到全部门店清单）
  if (!guard.checkPerm(req, res, 'store.view')) return;
  const stores = readAll('stores');
  // RBAC：数据范围（后端强制）。门店自身的标识字段是 id，而范围判定按 storeId 比对，
  // 因此这里补一个 storeId = id 的映射再过滤。
  const scoped = guard.filterList(stores.map(s => ({ ...s, storeId: s.id })), req, 'store');
  res.json({ items: scoped.map(({ storeId, ...s }) => s) });
});

app.post('/api/stores', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：store.create（新建门店尚无目标资源，故只判权限）
  if (!guard.checkPerm(req, res, 'store.create')) return;
  const b = req.body || {};
  const storeName = String(b.name).trim();
  if (!storeName) return res.status(400).json({ error: '请填写门店名称' });
  const stores = readAll('stores');
  if (stores.some(x => String(x.name).trim() === storeName)) {
    return res.status(400).json({ error: `已存在名为「${storeName}」的门店，请换一个名称` });
  }
  const s = {
    id: nanoid(),
    name: storeName,
    storeCode: String(b.storeCode || '').trim(),
    kingdeeAccount: String(b.kingdeeAccount || '').trim(),
    city: b.city || '',
    regionId: b.regionId || null,
    address: b.address || '',
    phone: b.phone || '',
    managerId: null,
    // 门店经理：创建时可先登记姓名；正式绑定店长账号后由分配逻辑覆盖
    managerName: String(b.managerName || '').trim() || '待分配',
    createdAt: nowIso(),
  };
  const createScope = guard.scopeOf(req, 'store.create');
  if (createScope.level === 'region' && !s.regionId) s.regionId = createScope.regionId;
  if (!s.regionId) return res.status(400).json({ error: '新建门店必须选择所属区域' });
  if (s.regionId && !(readAll('regions') || []).some(x => x.id === s.regionId && x.active !== false)) return res.status(400).json({ error: '所选区域不存在或已停用' });
  if (!guard.check(req, res, 'store.create', { storeId: s.id, regionId: s.regionId, country: 'PH' })) return;
  // 门店编号若填写则不允许与其他门店重复
  if (s.storeCode && stores.some(x => (x.storeCode || '') === s.storeCode)) {
    return res.status(400).json({ error: `门店编号「${s.storeCode}」已被其他门店使用` });
  }
  stores.push(s);
  writeAll('stores', stores);
  auditLog(`create store: ${s.name} by ${u.username}`);
  res.json({ ok: true, store: s });
});

// 删除门店：有管理流程或任务时拒绝，绑定的店长一并停用。
app.delete('/api/stores/:id', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：store.delete
  if (!guard.checkPerm(req, res, 'store.delete')) return;
  const stores = readAll('stores');
  const idx = stores.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '门店不存在' });
  const target = stores[idx];
  // RBAC：数据范围（不能删除管辖范围之外的门店）
  if (!guard.check(req, res, 'store.delete', { ...target, storeId: target.id })) return;
  const linked = ['workflowInstances', 'tasks', 'storeReports', 'storeInspections', 'storeIssues']
    .some(collection => (readAll(collection) || []).some(item => item.storeId === target.id));
  if (linked) return res.status(409).json({ error: '该门店仍有关联的审批、任务或运营记录，不能删除' });
  let disabledManager = null;
  if (target.managerId) {
    const users = readAll('users') || [];
    const mgr = users.find(x => x.id === target.managerId);
    if (mgr) {
      mgr.storeId = null; mgr.disabled = true; mgr.disabledAt = nowIso();
      writeAll('users', users);
      disabledManager = mgr.username;
    }
  }
  stores.splice(idx, 1);
  writeAll('stores', stores);
  auditLog(`delete store: ${target.name} by ${u.username}${disabledManager ? ` (店长 ${disabledManager} 已停用)` : ''}`);
  res.json({ ok: true, disabledManager });
});

app.put('/api/stores/:id', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：store.edit
  if (!guard.checkPerm(req, res, 'store.edit')) return;
  const stores = readAll('stores');
  const idx = stores.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '门店不存在' });
  const s = stores[idx];
  // RBAC：数据范围（不能修改管辖范围之外的门店）
  if (!guard.check(req, res, 'store.edit', { ...s, storeId: s.id })) return;
  const b = req.body || {};
  if (typeof b.regionId === 'string') {
    const nextRegionId = b.regionId || null;
    if (nextRegionId && !(readAll('regions') || []).some(x => x.id === nextRegionId && x.active !== false)) return res.status(400).json({ error: '所选区域不存在或已停用' });
    if (!guard.check(req, res, 'store.edit', { ...s, storeId: s.id, regionId: nextRegionId, country: 'PH' })) return;
    s.regionId = nextRegionId;
  }
  if (b.name) {
    const nextName = String(b.name).trim();
    if (!nextName) return res.status(400).json({ error: '门店名称不能为空' });
    if (stores.some(x => x.id !== s.id && String(x.name).trim() === nextName)) {
      return res.status(400).json({ error: `已存在名为「${nextName}」的门店，请换一个名称` });
    }
    s.name = nextName;
  }
  if (b.city) s.city = b.city;
  if (typeof b.address === 'string') s.address = b.address;
  if (typeof b.phone === 'string') s.phone = b.phone;
  // 新字段（2026-09-25）：门店编号 / 金蝶帐套 / 门店经理
  if (typeof b.storeCode === 'string') {
    const nextCode = b.storeCode.trim();
    if (nextCode && stores.some(x => x.id !== s.id && (x.storeCode || '') === nextCode)) {
      return res.status(400).json({ error: `门店编号「${nextCode}」已被其他门店使用` });
    }
    s.storeCode = nextCode;
  }
  if (typeof b.kingdeeAccount === 'string') s.kingdeeAccount = b.kingdeeAccount.trim();
  // 门店经理：仅未绑定店长账号时允许手动登记；已绑定（managerId 非空）由分配/解绑逻辑维护，手改会被忽略
  if (typeof b.managerName === 'string' && b.managerName.trim() && !s.managerId) {
    s.managerName = b.managerName.trim();
  }
  stores[idx] = s;
  writeAll('stores', stores);
  auditLog(`update store: ${s.name} by ${u.username}`);
  res.json({ ok: true, store: s });
});

// 添加店长（创建店长账号并绑定门店）
app.post('/api/stores/:id/managers', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // ⚠ HQ 管理边界的关键接口 —— 分配店长属于「人员管理」，是 staff.assign 能力。
  //   hq_operator 按矩阵没有 staff.assign，因此这里必然 403，
  //   无论前端是否隐藏入口、无论请求体怎么改，都无法绕过。
  if (!guard.checkPerm(req, res, 'staff.assign')) return;
  const stores = readAll('stores');
  const idx = stores.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '门店不存在' });
  const store = stores[idx];
  // RBAC：数据范围必须覆盖目标门店（店长只能给自己门店配店长；区域/菲律宾按各自范围）
  if (!guard.check(req, res, 'staff.assign', { ...store, storeId: store.id })) return;
  // ── L2 业务状态护栏（2026-09-22 补）：不允许「目标 = 当前登录用户本人」──
  //   本接口下方会把门店原店长停用（一家门店只保留一位店长，见 prevManagerId 分支）。
  //   若当前登录用户**正是这家门店的现任店长**，他调用本接口就等于把自己替换/停用掉：
  //   账号一停用，getSessionUser 会立刻作废他自己的会话 → 门店失去唯一店长，
  //   而且没有任何入口能撤销（他再也登不进来）。这是纯粹的自我伤害路径，直接拒绝。
  //   换店长请由上级角色操作（admin / 全国区域负责人）；本护栏不改变其他任何角色的行为。
  if (store.managerId && store.managerId === u.id) {
    auditLog(`staff.assign rejected (self-target): ${u.username} tried to replace self as manager of ${store.name}`);
    return res.status(400).json({ error: '你不能通过本流程替换或停用自己。如需更换本店店长，请联系上级管理员操作' });
  }
  const b = req.body || {};
  if (!b.username || !b.name || !b.password) return res.status(400).json({ error: '请填写用户名、姓名、初始密码' });
  if (b.password.length < 6) return res.status(400).json({ error: '初始密码至少 6 位' });
  const users = readAll('users');
  const username = String(b.username).trim();
  const existing = users.find(x => x.username === username);
  let manager;
  if (existing) {
    // 同名账号如果是「已解绑停用」的店长，直接复用并重置：
    // 否则用户会发现解绑过的用户名再也用不了。
    if (existing.role !== 'manager' || !existing.disabled) {
      return res.status(400).json({ error: '用户名已存在' });
    }
    manager = existing;
    manager.password = bcrypt.hashSync(b.password, 12);
    manager.mustChangePassword = true;
    manager.name = String(b.name).trim();
    manager.phone = b.phone || '';
    manager.storeId = store.id;
    manager.disabled = false;
    delete manager.disabledAt;
  } else {
    manager = {
      id: nanoid(),
      username,
      password: bcrypt.hashSync(b.password, 12),
      name: String(b.name).trim(),
      role: 'manager',
      storeId: store.id,
      phone: b.phone || '',
      createdAt: nowIso(),
      disabled: false,
      mustChangePassword: true,
    };
    users.push(manager);
  }
  // 一家门店只保留一位店长：原店长（若有）一并停用，避免留下没有门店的僵尸账号
  const prevManagerId = store.managerId;
  if (prevManagerId && prevManagerId !== manager.id) {
    const prev = users.find(x => x.id === prevManagerId);
    if (prev) { prev.storeId = null; prev.disabled = true; prev.disabledAt = nowIso(); }
  }
  writeAll('users', users);

  store.managerId = manager.id;
  store.managerName = manager.name;
  writeAll('stores', stores);
  auditLog(`create manager: ${manager.username} for ${store.name} by ${u.username}`);
  const { password, ...safe } = manager;
  res.json({ ok: true, manager: safe, store });
});

app.get('/api/stores/:id/managers', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：staff.view（原来只校验登录 —— 任何登录用户都能查到任意门店的店长）
  if (!guard.checkPerm(req, res, 'staff.view')) return;
  const store = (readAll('stores') || []).find(s => s.id === req.params.id);
  if (!store) return res.status(404).json({ error: '门店不存在' });
  // RBAC：数据范围（门店自身的标识字段是 id，补 storeId = id 供范围判定）
  if (!guard.check(req, res, 'staff.view', { ...store, storeId: store.id })) return;
  const users = (readAll('users') || []).filter(x => x.role === 'manager' && x.storeId === req.params.id);
  res.json({ items: users.map(({ password, ...rest }) => rest) });
});

// 解绑店长
app.delete('/api/stores/:id/managers/:managerId', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：staff.assign（解绑店长同属「人员管理」能力，非管理员专属）
  if (!guard.checkPerm(req, res, 'staff.assign')) return;
  const stores = readAll('stores');
  const store = stores.find(s => s.id === req.params.id);
  if (!store) return res.status(404).json({ error: '门店不存在' });
  // RBAC：数据范围必须覆盖目标门店
  if (!guard.check(req, res, 'staff.assign', { ...store, storeId: store.id })) return;
  // ── L2 业务状态护栏（2026-09-22 补）：不允许解绑/停用自己 ──
  //   解绑会把该店长 disabled=true（见下方），当前用户解绑自己 = 把自己锁在门外，理由同 POST。
  if (req.params.managerId === u.id) {
    auditLog(`staff.assign rejected (self-target): ${u.username} tried to unbind self from ${store.name}`);
    return res.status(400).json({ error: '你不能通过本流程解绑或停用自己。如需离开本店，请联系上级管理员操作' });
  }
  if (store.managerId !== req.params.managerId) return res.status(400).json({ error: '该店长未绑定此门店' });
  const users = readAll('users');
  const manager = users.find(x => x.id === req.params.managerId);
  if (manager) {
    // 解绑后账号必须停用：否则它会以「无门店」状态继续登录，
    // 建出来的会员 storeId 为空，在门店筛选和报表里都不出现。
    manager.storeId = null;
    manager.disabled = true;
    manager.disabledAt = nowIso();
    writeAll('users', users);
  }
  store.managerId = null;
  store.managerName = '待分配';
  writeAll('stores', stores);
  auditLog(`unbind manager: ${manager?.username} (account disabled) from ${store.name} by ${u.username}`);
  res.json({ ok: true });
});

// ============ 用户 / 账号管理 ============

app.get('/api/users', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：system.user.view（账号属于系统登录身份，是系统级数据）
  //   「看账号」与「改账号」是两个能力：这里只要 system.user.view；
  //   修改账号需要 system.user.edit（当前矩阵仅 admin 拥有）。
  if (!guard.checkPerm(req, res, 'system.user.view')) return;
  const users = readAll('users');
  // RBAC：数据范围（防御性）。
  //   当前 system.user.view 只授予 admin（global），filterList 会原样返回全部；
  //   但若将来把它授予区域/门店级角色，这里会自动按 user.storeId 过滤，
  //   不会出现「有权限看就必然看到全连锁账号」的越权。
  const scoped = guard.filterList(users, req, 'system.user');
  // 密码哈希不外泄；disabled 字段供界面显示「已停用」
  res.json({ items: scoped.map(({ password, ...rest }) => rest) });
});

// 账号启用 / 停用（P5，2026-09-22）
//   本接口只做「启用 / 停用」这一件事：不建号、不删号、不改用户名 / 角色 / 门店绑定 / 密码。
//   权限：沿用既有 system.user.view（列表）与 system.user.edit（启停）
//         —— 零新增权限、零 ROLE_GRANTS 变更。
//   状态护栏一律是 L2（400），不是 L1 资格（403）：调用者确实有 system.user.edit，
//   只是当前业务状态不允许这次操作。
app.put('/api/users/:id/status', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：system.user.edit（「看账号」与「改账号」是两个能力；当前矩阵仅 admin 拥有）
  if (!guard.checkPerm(req, res, 'system.user.edit')) return;

  const want = (req.body || {}).disabled;
  const users = readAll('users') || [];
  const target = users.find(x => x.id === req.params.id);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  // RBAC：数据范围（防御性）。当前 system.user.edit 只授 admin（global），此处必然通过；
  //   若将来把它授予区域 / 门店级角色，会自动按目标账号的 storeId 收窄，
  //   不会出现「有权限就必然能改全连锁账号」。
  if (!guard.check(req, res, 'system.user.edit', target)) return;

  // 请求体校验要在范围门之后：无权限者不该通过参数差异反推账号是否存在
  if (typeof want !== 'boolean') return res.status(400).json({ error: 'disabled 必须是布尔值' });

  // ── L2 业务状态护栏 ──
  // ① 幂等：状态没变化就不写库（避免无意义的写入与 dataVersion 前进）
  if (!!target.disabled === want) {
    return res.status(400).json({ error: want ? '该账号已经是停用状态' : '该账号已经是启用状态' });
  }
  // ② 不能停用当前登录账号自己
  //    （停用会让 getSessionUser 立即作废自己的会话 = 把自己踢下线，属不必要的操作风险）
  if (want && target.id === u.id) {
    auditLog(`user.disable rejected (self): ${u.username} tried to disable own account`);
    return res.status(400).json({ error: '不能停用当前登录账号。' });
  }
  // ③ 不能停用「最后一个启用状态的 system.user.edit 持有者」
  //    ★ 持有者按权限矩阵实时计算（normalizeRole + ROLE_GRANTS），不写死 role === 'admin'：
  //      将来把 system.user.edit 授给别的角色，这里的保护对象会自动跟着变。
  if (want && !target.disabled && rbac.hasPermission(target, 'system.user.edit')) {
    const others = users.filter(x => !x.disabled && x.id !== target.id && rbac.hasPermission(x, 'system.user.edit'));
    if (!others.length) {
      auditLog(`user.disable rejected (last system.user.edit holder): ${u.username} tried to disable ${target.username}`);
      return res.status(400).json({ error: '不能停用最后一个拥有「账号管理」权限的账号（否则将无人能再管理账号）。' });
    }
  }
  // ④ 仍被门店绑定为店长的账号禁止停用 —— 本接口绝不自动解绑，stores 保持完全不被触碰
  //    （否则会出现 stores.managerName 显示在岗、账号却登不上的不一致状态）
  if (want) {
    const bound = (readAll('stores') || []).find(s => s.managerId === target.id);
    if (bound) {
      auditLog(`user.disable rejected (store-bound manager): ${u.username} tried to disable ${target.username} of ${bound.name}`);
      return res.status(400).json({ error: '该账号仍绑定门店，请先解除门店绑定后再停用。' });
    }
  }

  // ── 通过：只写 disabled / disabledAt 两个字段，其余字段逐字节不动 ──
  if (want) { target.disabled = true; target.disabledAt = nowIso(); }
  else { target.disabled = false; target.disabledAt = null; }
  writeAll('users', users);   // 业务集合写入 → dataVersion 正常 +1
  auditLog(`user.${want ? 'disable' : 'enable'}: ${target.username} (${target.role}) by ${u.username}`);
  res.json({ ok: true, id: target.id, disabled: !!target.disabled, disabledAt: target.disabledAt || null });
});

// 账号删除（2026-09-24，用户授权新增）
//   权限沿用既有 system.user.edit（零新增权限、零 ROLE_GRANTS 变更）。
//   ⚠ 这是**真删除、不可逆**：删掉后 stores.managerId / transactions.operatorId /
//     pending.requestedBy / redemptions.createdBy 会指向一个不存在的账号。
//     历史记录里仍留着当时的 *_ByName 文本副本，但**无法再追溯到这个账号记录**。
//   三道护栏与「停用」同源，一律是 L2 业务状态（400），不是资格问题（403）。
app.delete('/api/users/:id', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'system.user.edit')) return;

  const users = readAll('users') || [];
  const target = users.find(x => x.id === req.params.id);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  // 数据范围（防御性）：当前只授 admin（global），此处必然通过
  if (!guard.check(req, res, 'system.user.edit', target)) return;

  // ① 不能删除当前登录账号自己
  if (target.id === u.id) {
    auditLog(`user.delete rejected (self): ${u.username} tried to delete own account`);
    return res.status(400).json({ error: '不能删除当前登录账号。' });
  }
  // ② 不能删除「最后一个启用状态的 system.user.edit 持有者」（实时按权限矩阵算，不写死 admin）
  if (!target.disabled && rbac.hasPermission(target, 'system.user.edit')) {
    const others = users.filter(x => !x.disabled && x.id !== target.id && rbac.hasPermission(x, 'system.user.edit'));
    if (!others.length) {
      auditLog(`user.delete rejected (last system.user.edit holder): ${u.username} tried to delete ${target.username}`);
      return res.status(400).json({ error: '不能删除最后一个拥有「账号管理」权限的账号（否则将无人能再管理账号）。' });
    }
  }
  // ③ 仍被门店绑定为店长的账号禁止删除 —— 本接口绝不自动解绑，否则门店会留下悬空店长
  const bound = (readAll('stores') || []).find(s => s.managerId === target.id);
  if (bound) {
    auditLog(`user.delete rejected (store-bound manager): ${u.username} tried to delete ${target.username} of ${bound.name}`);
    return res.status(400).json({ error: '该账号仍绑定门店，请先解除门店绑定后再删除。' });
  }

  // ── 通过：只从 users 集合移除这一条记录；stores/transactions/pending/redemptions 一律不碰 ──
  users.splice(users.findIndex(x => x.id === target.id), 1);
  writeAll('users', users);   // dataVersion 正常 +1
  auditLog(`user.delete: ${target.username} (${target.role}) by ${u.username}`);
  res.json({ ok: true, id: target.id, deleted: true });
});

// 管理员重置密码（2026-09-24 用户授权新增）
//   权限沿用既有 system.user.edit（零新增权限、零 ROLE_GRANTS 变更）。
//   ★ 密码是 bcrypt 单向哈希，任何接口都无法「查看」旧密码 —— 只能重置。
//   ★ 新密码**不回传、不进日志**：管理员在前端输入，成功后由前端展示一次；
//     服务端只写哈希 + 写一行审计（审计里也不含密码本身）。
//   ★ 重置后立刻作废该账号的所有旧会话（与「自助改密码」同一策略），
//     否则被重置的账号可能还挂着旧会话继续用。
app.post('/api/users/:id/reset-password', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'system.user.edit')) return;

  const users = readAll('users') || [];
  const target = users.find(x => x.id === req.params.id);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  if (!guard.check(req, res, 'system.user.edit', target)) return;

  // 不能在这里重置自己的密码：自己改密码走「账号设置」（需当前密码），
  // 避免管理员手滑把自己锁在门外，也避免「无需旧密码就能改自己密码」这条弱路径。
  if (target.id === u.id) {
    auditLog(`reset-password rejected (self): ${u.username} tried to reset own password`);
    return res.status(400).json({ error: '不能在这里重置自己的密码，请用「账号设置」修改。' });
  }

  const b = req.body || {};
  const newPassword = typeof b.newPassword === 'string' ? b.newPassword : '';
  if (!newPassword) return res.status(400).json({ error: '请填写新密码' });
  if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });

  target.password = bcrypt.hashSync(newPassword, 12);
  target.mustChangePassword = true;
  writeAll('users', users);   // 只改 password 一个字段 → dataVersion 正常 +1
  // 作废该账号的全部旧会话
  let killed = 0;
  for (const [sid, s] of sessions) {
    if (s.userId === target.id) { sessions.delete(sid); killed++; }
  }
  auditLog(`reset-password: ${target.username} (${target.role}) by ${u.username}（作废旧会话 ${killed} 个）`);
  // ★ 响应体里绝不出现密码或哈希
  res.json({ ok: true, id: target.id, sessionsInvalidated: killed });
});

// ============ 积分规则 ============

app.get('/api/rules', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：points.view ——「能看规则」与「能改规则」是两回事（改规则见 PUT，需 points.rule.edit）
  // 规则是全局配置，不是门店级资源，因此只判权限、不套 store 范围。
  if (!guard.checkPerm(req, res, 'points.view')) return;
  const rules = readAll('rules');
  // 附上积分引擎的运行时信息，方便规则页确认「配置是否真的在跑」
  res.json({
    rules,
    engine: {
      expiry: pointsExpiry.status(),
      levelsWired: true,
      sampleWelcome: Number(rules.welcomeBonus) || 0,
      sampleSpendPerPoint: Number(rules.spendPerPoint) || points.DEFAULT_SPEND_PER_POINT,
      redeem: points.parseRedeemRatio(rules.redeemRatio),
    },
  });
});

/** 手动试算一次积分到期（只统计不扣减） */
app.post('/api/rules/expiry-scan', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：points.expiry.scan（全局配置操作，不套 store 范围）
  if (!guard.checkPerm(req, res, 'points.expiry.scan')) return;
  const result = pointsExpiry.scan({ dryRun: true });
  auditLog(`expiry dry-run by ${u.username}: ${result.expiredMembers} member(s) / ${result.expiredPoints} points`);
  res.json({ ok: true, preview: result });
});

app.put('/api/rules', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：points.rule.edit（全局配置；与「查看」分离，查看只要 points.view）
  if (!guard.checkPerm(req, res, 'points.rule.edit')) return;
  const b = req.body || {};
  const cur = readAll('rules');

  // —— 数值校验 ——
  // 以前这些字段直接 Number() 落库，填负数也能存下来。
  // spendPerPoint = -5 会让「消费」变成倒扣积分，而且是记成 earn 流水的。
  const RULE_NUM = [
    { key: 'spendPerPoint',    label: '每多少₱积1分',   min: 1, max: 1000000 },
    { key: 'expiryMonths',     label: '积分有效期(月)', min: 0, max: 600 },
    { key: 'welcomeBonus',     label: '欢迎积分',        min: 0, max: 1000000 },
    { key: 'redeemMaxPercent', label: '单笔抵扣上限(%)', min: 0, max: 100 },
    { key: 'redeemMinPoints',  label: '最低使用门槛',    min: 0, max: 100000000 },
  ];
  const nums = {};
  for (const f of RULE_NUM) {
    const n = Number(b[f.key] ?? cur[f.key]);
    if (!Number.isFinite(n)) return res.status(400).json({ error: `${f.label}必须是数字` });
    if (n < f.min || n > f.max) {
      return res.status(400).json({ error: `${f.label}必须在 ${f.min} ~ ${f.max} 之间` });
    }
    nums[f.key] = n;
  }

  // 兑换比例必须是「积分:金额」且两侧都大于 0（否则引擎会静默回退到默认值，界面却照原样显示）
  const ratioRaw = String(b.redeemRatio ?? cur.redeemRatio ?? '').trim();
  const rm = ratioRaw.match(/^(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)$/);
  if (!rm || !(Number(rm[1]) > 0) || !(Number(rm[2]) > 0)) {
    return res.status(400).json({ error: '兑换比例格式应为「积分:金额」，例如 10:1，且两侧都要大于 0' });
  }

  // 等级 / B2B 阶梯：标识唯一、名称非空、门槛非负、颜色是合法色值
  function normTiers(list, label) {
    if (!Array.isArray(list)) throw new Error(`${label}配置格式不正确`);
    const seen = new Set();
    return list.map(t => {
      const key = String((t && t.key) || '').trim();
      const name = String((t && t.name) || '').trim();
      const threshold = Number(t && t.threshold);
      const color = String((t && t.color) || '').trim();
      if (!key || seen.has(key)) throw new Error(`${label}存在重复或空的标识`);
      if (!name) throw new Error(`${label}的名称不能为空`);
      if (!Number.isFinite(threshold) || threshold < 0) throw new Error(`${label}的门槛必须是非负数字`);
      if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) throw new Error(`${label}的颜色需为 6 位十六进制色值（例如 #027637）`);
      seen.add(key);
      return { ...t, key, name, threshold, color };
    });
  }
  let levels, b2bTiers;
  try {
    levels = normTiers(b.levels ?? cur.levels, '等级');
    b2bTiers = normTiers(b.b2bTiers ?? cur.b2bTiers, 'B2B 阶梯');
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const updated = {
    ...cur,
    ...nums,
    redeemRatio: ratioRaw,
    requireConfirm: b.requireConfirm ?? cur.requireConfirm,
    realtimePush: b.realtimePush ?? cur.realtimePush,
    levels,
    b2bTiers,
    updatedAt: nowIso(),
  };
  delete updated.birthdayDouble; // 生日积分体系已下线（2026-09-11）
  writeAll('rules', updated);
  // 重新计算所有会员等级
  const members = readAll('members');
  members.forEach(m => { if (m.type === 'retail') m.level = recalcLevel(m, updated); });
  writeAll('members', members);
  auditLog(`update rules by ${u.username}`);
  res.json({ ok: true, rules: updated });
});

// ============ 数据总览 / 报表 ============

app.get('/api/dashboard', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：dashboard.view（本接口返回的是**按范围聚合**的经营数据，不是全局汇总，
  //   因此必须 filterList —— 只判 checkPerm 会出现「能调用，但把全连锁数据都返回」的漏洞）
  if (!guard.checkPerm(req, res, 'dashboard.view')) return;
  const members = readAll('members') || [];
  const stores = readAll('stores') || [];
  const transactions = readAll('transactions') || [];
  // RBAC：数据范围 —— 会员按范围过滤（店长=本店 / 区域=本区 / 菲律宾=全菲 / admin=全部）
  const scope = guard.filterList(members, req, 'member');
  // RBAC：数据范围 —— 门店维度同样必须过滤。
  //   下面「门店分布」要用它，若直接遍历全部门店，店长就会看到其他门店的名称
  //   （计数为 0，不含会员数据，但仍是跨店信息泄露）。
  //   门店自身的标识字段是 id，补 storeId = id 供范围判定（与 /api/reports/overview 同一写法）。
  const visibleStores = guard.filterList(stores.map(s => ({ ...s, storeId: s.id })), req, 'store');
  const total = scope.length;
  const retail = scope.filter(m => m.type === 'retail').length;
  const b2b = scope.filter(m => m.type === 'b2b').length;
  const points = scope.reduce((s, m) => s + (m.points || 0), 0);
  const spend = scope.reduce((s, m) => s + (m.spend || 0), 0);
  // 近 30 天流水
  const now = Date.now();
  const day = 86400000;
  const buckets = new Array(10).fill(0).map((_, i) => ({ date: new Date(now - (9 - i) * 3 * day).toISOString().slice(5, 10), earn: 0, redeem: 0 }));
  // RBAC：数据范围 —— 流水自身带 storeId，直接按范围过滤（无需再建 member→store 索引）
  guard.filterList(transactions, req, 'points').forEach(t => {
    const d = new Date(t.createdAt).getTime();
    if (now - d > 30 * day) return;
    const idx = Math.min(9, Math.floor((now - d) / (3 * day)));
    if (idx < 0) return;
    if (t.amount > 0) buckets[9 - idx].earn += t.amount;
    else buckets[9 - idx].redeem += -t.amount;
  });
  // 门店分布（只统计可见门店，避免店长看到其他门店的名称）
  const storeDist = visibleStores.map(s => ({ storeId: s.id, storeName: s.name, count: scope.filter(m => m.storeId === s.id).length }));
  res.json({ total, retail, b2b, points, spend, buckets, storeDist });
});

// ============ 经营报表（一次性聚合，主管/管理员可访问） ============
app.get('/api/reports/overview', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：report.view（报表是**按范围聚合**的经营数据，必须 filterList）
  if (!guard.checkPerm(req, res, 'report.view')) return;
  const stores = readAll('stores') || [];
  const rules = readAll('rules') || {};
  // RBAC：数据范围 —— 会员 / 流水 / 门店三个维度都按范围过滤
  const members = guard.filterList(readAll('members') || [], req, 'member');
  const transactions = guard.filterList(readAll('transactions') || [], req, 'points');
  const visibleStores = guard.filterList(stores.map(s => ({ ...s, storeId: s.id })), req, 'store')
    .map(({ storeId, ...s }) => s);
  const data = reports.overview({ members, stores: visibleStores, transactions, rules });
  res.json(data);
});

app.get('/api/transactions', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：points.view（全局流水 —— 与「查看某会员流水」同属积分查看能力）
  if (!guard.checkPerm(req, res, 'points.view')) return;
  // RBAC：数据范围（流水自带 storeId，直接过滤）
  const txs = guard.filterList(readAll('transactions') || [], req, 'points');
  res.json({ items: txs.slice(0, 200) });
});

// ============ Google Sheets 配置（浏览器直连 Google Apps Script） ============

app.get('/api/sheets/status', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // 云同步属于系统级配置：响应里含 GAS Web App URL、表格 ID 与密钥，
  // 页面只给系统管理员看，接口必须同样收口，否则店长仍能直接读到配置。
  // RBAC：sync.view（system/global 能力，不套 store 范围）
  if (!guard.checkPerm(req, res, 'sync.view')) return;
  const cfg = readAll('sheets') || {};
  // 兼容旧 clientId 字段：如果只有 clientId 没 gasUrl，提示用户重新配置
  if (cfg.clientId && !cfg.gasUrl) {
    cfg._legacy = 'clientId 已弃用，请重新配置 GAS Web App URL';
  }
  delete cfg.clientId;
  delete cfg.enabled;          // 历史死字段：早期 schema 遗留，引擎从不读取
  delete cfg.syncedSignature;  // 内部字段不外泄
  const rt = sheetsSync.getRuntimeState();
  res.json({
    ...cfg,
    // 自动同步默认开启：只有显式关掉才为 false
    autoSync: cfg.autoSync !== false,
    autoSyncInterval: sheetsSync.intervalMinutes(cfg),
    configured: !!(cfg.gasUrl && cfg.spreadsheetId),
    runtime: rt,
    nextSyncAt: rt.nextSyncAt,
  });
});

app.post('/api/sheets/config', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：sync.config（修改同步配置 —— 与「查看状态」「手动触发」分开授权）
  if (!guard.checkPerm(req, res, 'sync.config')) return;
  const cfg = readAll('sheets') || {};
  const b = req.body || {};
  if (typeof b.gasUrl === 'string') cfg.gasUrl = b.gasUrl.trim();
  if (typeof b.spreadsheetId === 'string') cfg.spreadsheetId = b.spreadsheetId.trim();
  if (typeof b.autoSync === 'boolean') cfg.autoSync = b.autoSync;
  if (b.autoSyncInterval !== undefined) {
    const m = Number(b.autoSyncInterval);
    if (Number.isFinite(m)) cfg.autoSyncInterval = Math.max(5, Math.min(1440, Math.round(m)));
  }
  if (b.secret !== undefined) cfg.secret = String(b.secret || '');
  // 清字段
  if (typeof b.clearGasUrl === 'boolean' && b.clearGasUrl) cfg.gasUrl = '';
  if (typeof b.clearSpreadsheetId === 'boolean' && b.clearSpreadsheetId) cfg.spreadsheetId = '';
  // 废弃字段：清掉
  if (cfg.clientId) delete cfg.clientId;
  cfg.updatedAt = nowIso();
  writeAll('sheets', cfg);
  auditLog(`sheets config updated by ${u.username} (autoSync=${cfg.autoSync !== false}, interval=${cfg.autoSyncInterval}min)`);
  // 配置变更 → 立即排队一次同步，让用户马上看到结果
  if (cfg.gasUrl && cfg.spreadsheetId) sheetsSync.markDirty();
  res.json({ ok: true, cfg });
});

// 服务端立即同步（服务器直连 Google，国内网络同样可用）
app.post('/api/sheets/sync-now', async (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：sync.run（手动触发同步 —— 与 sync.config 分开授权）
  if (!guard.checkPerm(req, res, 'sync.run')) return;
  const result = await sheetsSync.syncNow('manual');
  if (!result.ok) return res.status(400).json(result);
  res.json({ ...result, status: (readAll('sheets') || {}) });
});

app.post('/api/sheets/log', (req, res) => {
  // 浏览器侧 push 结果回报到后端审计日志
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：sync.run（回报同步执行结果 —— 属于「执行同步」能力，不是配置或查看）
  if (!guard.checkPerm(req, res, 'sync.run')) return;
  const { action, status, detail } = req.body || {};
  const cfg = readAll('sheets') || {};
  cfg.lastAction = action || '';
  cfg.lastActionStatus = status || '';
  cfg.lastError = status === 'failed' ? (detail || '') : null;
  if (status === 'success' && action === 'push') cfg.lastSyncAt = nowIso();
  cfg.lastSyncResult = (action === 'push' && status) ? status : (cfg.lastSyncResult || null);
  cfg.updatedAt = nowIso();
  writeAll('sheets', cfg);
  auditLog(`sheets ${action} ${status} by ${u.username}: ${detail || ''}`);
  res.json({ ok: true });
});

// ============ 数据主库（只读查看 / 导出） ============
// 让管理员在浏览器里直接查看服务器主库的原始记录，只读、不改动生产数据。

const DB_COLLECTIONS = [
  { key: 'stores',       label: '门店',        kind: 'array',  desc: '门店档案与店长绑定' },
  { key: 'users',        label: '账号',        kind: 'array',  desc: '登录账号（密码已打码）', sensitive: ['password'] },
  { key: 'workflowInstances', label: '审批流程', kind: 'array', desc: '管理流程实例' },
  { key: 'tasks',        label: '协作任务',    kind: 'array', desc: '任务与执行记录' },
  { key: 'announcements', label: '内容公告', kind: 'array', desc: '中控公告' },
  { key: 'audit',        label: '操作审计日志', kind: 'lines',  desc: '服务器操作日志（倒序）' },
];

// 备份文件名：每日自动备份是 .tar.gz，上线前的代码备份是 .tgz，两种都要认。
// 旧实现只匹配 .tar.gz，导致界面上永远看不到 code-*.tgz，点下载还会 400。
const BACKUP_RE = /^(?!\._)[A-Za-z0-9._-]+\.(?:tar\.gz|tgz)$/;

const DB_FIELD_LABELS = {
  members: { name: '姓名', phone: '手机号', type: '类型', level: '等级', points: '积分余额', spend: '累计消费(₱)', storeId: '门店ID', storeName: '所属门店', status: '状态', notes: '备注', pointsExpireAt: '积分到期', lastEarnAt: '最近获得积分', lastPurchaseAt: '最近消费', earnedTotal: '累计获得', redeemedTotal: '累计核销' },
  stores: { name: '门店名', city: '城市', address: '地址', phone: '电话', managerId: '店长ID', managerName: '店长姓名' },
  transactions: { memberId: '会员ID', memberName: '会员姓名', type: '类型', amount: '积分变动', reason: '原因', storeId: '门店ID', storeName: '门店名', operatorId: '操作人ID', operatorName: '操作人', purchaseAmount: '消费金额(₱)', basePoints: '计分基数', balanceAfter: '变动后余额' },
  users: { username: '账号', password: '密码', name: '姓名', role: '角色', storeId: '绑定门店ID', phone: '手机号', disabled: '已停用', disabledAt: '停用时间' },
  rules: { spendPerPoint: '每多少₱积1分', expiryMonths: '有效期(月)', welcomeBonus: '欢迎积分', redeemRatio: '兑换比例', redeemMaxPercent: '抵扣上限(%)', redeemMinPoints: '最低使用门槛', requireConfirm: '二次确认', realtimePush: '实时推送', levels: '等级配置', b2bTiers: 'B2B阶梯' },
  sheets: { enabled: '启用', spreadsheetId: 'Google Sheet ID', gasUrl: 'Apps Script URL', autoSync: '自动同步', autoSyncInterval: '心跳间隔(分钟)', lastSyncAt: '上次同步时间', lastSyncResult: '上次结果', lastSyncSource: '触发方式', lastSyncSummary: '同步内容', lastSyncCostMs: '耗时(ms)', lastSyncFailedAt: '上次失败时间', lastError: '错误信息', syncCount: '累计同步次数', lastAction: '最后动作', lastActionStatus: '动作结果', secret: '密钥' },
  audit: { _line: '行号', text: '日志内容' },
};
const DB_GENERIC_LABELS = { id: 'ID', createdAt: '创建时间', updatedAt: '更新时间', serverTime: '服务器时间' };

function labelFor(collKey, field) {
  return (DB_FIELD_LABELS[collKey] && DB_FIELD_LABELS[collKey][field]) || DB_GENERIC_LABELS[field] || field;
}

function dbCollectionFile(key) {
  if (!DB_COLLECTIONS.some(c => c.key === key)) return null;
  return key === 'audit'
    ? path.join(__dirname, 'data', 'audit.log')
    : path.join(__dirname, 'data', key + '.json');
}

function maskRecord(rec, sensitive) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
  const out = { ...rec };
  (sensitive || []).forEach(f => { if (f in out) out[f] = '••••••（已隐藏）'; });
  return out;
}

/**
 * 数据主库权限守卫。
 *
 * RBAC 迁移（2026-09-22）：不再按角色名判断，改为按能力判断 ——
 *   db.view   查看集合 / 导出（只读查看）
 *   db.export 导出数据与下载备份文件
 * 两者在权限矩阵中**只授予 admin（global）**：数据主库是系统级高风险能力
 * （能看到全库原始数据、下载完整备份），不能因为「方便运营」而扩大授权。
 * owner / hq_operator / philippines_manager 等角色一律无此权限（见 rbac-api-batch5 测试）。
 */
function requireDbPerm(req, res, permission) {
  const u = getSessionUser(req);
  if (!u) { res.status(401).json({ error: '未登录' }); return null; }
  if (!rbac.hasPermission(u, permission)) { res.status(403).json({ error: '无权限访问数据主库' }); return null; }
  return u;
}

/**
 * 集合的「大小 / 更新时间」。
 *
 * ⚠️ 2026-09-21 存储升级（重要）：
 *    迁移到 SQLite 后 data/<集合>.json 不再是主数据源。若继续 stat 那些文件，
 *    页面会显示「再也不会更新的历史快照」的大小与时间，管理员会误判系统状态。
 *    因此改为向存储层要真实统计 —— 两个驱动下都有正确实现：
 *      · JSON 驱动   → 原来的 fs.statSync（行为与之前完全一致）
 *      · SQLite 驱动 → SELECT 统计 + _meta 里记录的最后写入时间
 *    audit.log 仍是纯文本日志，继续用文件 stat（其实现路径不变）。
 */
function dbFileStat(key) {
  if (key === 'audit') {
    const f = dbCollectionFile(key);
    try {
      const st = fs.statSync(f);
      return { size: st.size, updatedAt: st.mtime.toISOString() };
    } catch (e) { return { size: 0, updatedAt: null }; }
  }
  return store.stats(key);
}

function dbCount(meta) {
  const f = dbCollectionFile(meta.key);
  if (meta.kind === 'array') return (readAll(meta.key) || []).length;
  if (meta.kind === 'object') return readAll(meta.key) ? 1 : 0;
  try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length; } catch (e) { return 0; }
}

app.get('/api/db/overview', (req, res) => {
  // RBAC：db.view（数据主库 = 系统级能力，仅 admin）
  if (!requireDbPerm(req, res, 'db.view')) return;
  const collections = DB_COLLECTIONS.map(meta => {
    const st = dbFileStat(meta.key);
    return { key: meta.key, label: meta.label, kind: meta.kind, desc: meta.desc, count: dbCount(meta), size: st.size, updatedAt: st.updatedAt };
  });
  // 备份文件
  let backups = [];
  try {
    const bdir = path.join(__dirname, 'backups');
    backups = fs.readdirSync(bdir)
      .filter(n => BACKUP_RE.test(n))
      .map(n => {
        const st = fs.statSync(path.join(bdir, n));
        return { name: n, size: st.size, updatedAt: st.mtime.toISOString() };
      })
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .slice(0, 8);
  } catch (e) {}
  res.json({
    dataDir: path.join(__dirname, 'data'),
    backupsDir: path.join(__dirname, 'backups'),
    collections,
    backups,
    totalSize: collections.reduce((s, c) => s + (c.size || 0), 0),
    // 存储来源信息：让管理员一眼看到「数据现在到底存在哪」，而不是靠猜
    storage: (() => {
      const driver = store.driver();
      const marker = store.readMarker() || {};
      let dbSize = 0;
      try { dbSize = fs.statSync(path.join(__dirname, 'data', 'solarpoints.db')).size; } catch (e) {}
      return {
        driver,
        dbFile: driver === 'sqlite' ? 'data/solarpoints.db' : null,
        dbSize: driver === 'sqlite' ? dbSize : 0,
        schemaVersion: marker.schemaVersion || null,
        migratedAt: marker.migratedAt || null,
        jsonBackupDir: marker.jsonBackupDir || null,
      };
    })(),
    serverTime: nowIso(),
  });
});

app.get('/api/db/collection/:key', (req, res) => {
  // RBAC：db.view（查看原始集合 —— 含全库数据，仅 admin）
  if (!requireDbPerm(req, res, 'db.view')) return;
  const meta = DB_COLLECTIONS.find(c => c.key === req.params.key);
  if (!meta) return res.status(404).json({ error: '未知数据表' });

  let items = [];
  if (meta.kind === 'lines') {
    let lines = [];
    try { lines = fs.readFileSync(dbCollectionFile(meta.key), 'utf8').split('\n').filter(Boolean); } catch (e) {}
    items = lines.reverse().map((text, i) => ({ _line: lines.length - i, text }));
  } else if (meta.kind === 'object') {
    const obj = readAll(meta.key);
    items = obj ? [maskRecord(obj, meta.sensitive)] : [];
  } else {
    items = (readAll(meta.key) || []).map(r => maskRecord(r, meta.sensitive));
  }

  const q = String(req.query.q || '').trim();
  if (q) {
    const s = q.toLowerCase();
    items = items.filter(it => Object.values(it).some(v =>
      (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && String(v).toLowerCase().includes(s)));
  }

  // 列：按所有记录中首次出现的顺序合并，最多 24 列
  const columns = [];
  const seen = new Set();
  for (const it of items) {
    for (const k of Object.keys(it)) {
      if (!seen.has(k)) { seen.add(k); columns.push({ key: k, label: labelFor(meta.key, k) }); }
      if (columns.length >= 24) break;
    }
    if (columns.length >= 24) break;
  }

  const ps = Math.max(1, Math.min(200, parseInt(req.query.pageSize) || 20));
  const p = Math.max(1, parseInt(req.query.page) || 1);
  const st = dbFileStat(meta.key);
  res.json({
    key: meta.key, label: meta.label, kind: meta.kind, desc: meta.desc,
    columns,
    items: items.slice((p - 1) * ps, p * ps),
    total: items.length, page: p, pageSize: ps,
    size: st.size, updatedAt: st.updatedAt,
    filtered: !!q,
  });
});

// 导出：单个数据表支持 CSV / JSON；整库导出 JSON
app.get('/api/db/export', (req, res) => {
  // RBAC：db.export（导出整库 / 单表 —— 与「查看」分开的能力，仅 admin）
  if (!requireDbPerm(req, res, 'db.export')) return;
  const key = String(req.query.key || '');
  const format = String(req.query.format || 'csv').toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10);

  function rowsOf(meta) {
    if (meta.kind === 'lines') {
      let lines = [];
      try { lines = fs.readFileSync(dbCollectionFile(meta.key), 'utf8').split('\n').filter(Boolean); } catch (e) {}
      return lines.map((text, i) => ({ _line: i + 1, text }));
    }
    if (meta.kind === 'object') {
      const obj = readAll(meta.key);
      return obj ? [maskRecord(obj, meta.sensitive)] : [];
    }
    return (readAll(meta.key) || []).map(r => maskRecord(r, meta.sensitive));
  }

  if (key === 'all') {
    if (format !== 'json') return res.status(400).json({ error: '整库导出请选择 JSON，单个数据表才支持 CSV' });
    const payload = {};
    for (const meta of DB_COLLECTIONS) {
      if (meta.key === 'audit') continue;
      payload[meta.key] = meta.kind === 'object' ? maskRecord(readAll(meta.key), meta.sensitive) : rowsOf(meta);
    }
    payload._exportedAt = nowIso();
    res.setHeader('Content-Disposition', `attachment; filename="solarpoints-db-${stamp}.json"`);
    res.type('application/json; charset=utf-8');
    return res.send(JSON.stringify(payload, null, 2));
  }

  const meta = DB_COLLECTIONS.find(c => c.key === key);
  if (!meta) return res.status(404).json({ error: '未知数据表' });
  const rows = rowsOf(meta);

  if (format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="solarpoints-${key}-${stamp}.json"`);
    res.type('application/json; charset=utf-8');
    return res.send(JSON.stringify(rows, null, 2));
  }

  const cols = [];
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return '"' + s.replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  };
  const csv = '\ufeff' + [cols.map(c => esc(labelFor(key, c))).join(',')]
    .concat(rows.map(r => cols.map(c => esc(r[c])).join(',')))
    .join('\r\n');
  res.setHeader('Content-Disposition', `attachment; filename="solarpoints-${key}-${stamp}.csv"`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(csv);
});

// 下载每日备份
app.get('/api/db/backup/:name', (req, res) => {
  // RBAC：db.export（下载完整备份文件 —— 备份含全部业务数据，仅 admin）
  if (!requireDbPerm(req, res, 'db.export')) return;
  const name = String(req.params.name || '');
  if (!BACKUP_RE.test(name)) return res.status(400).json({ error: '非法文件名' });
  const file = path.join(__dirname, 'backups', name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '备份文件不存在' });
  auditLog(`download backup: ${name} by ${getSessionUser(req).username}`);
  res.download(file, name);
});

// 健康检查
app.get('/api/health', (req, res) => res.json({ ok: true, time: nowIso() }));

// 审计日志（只读）
// ------------------------------------------------------------
// 设计约定（P4，2026-09-22）：
// 1. **纯只读**：本接口只会读 lib/audit 的日志文件，没有任何写入/删除/清空路径。
//    审计日志保持 append-only，唯一会动它的是 lib/audit.js 的 auditLog()。
// 2. **权限沿用 system.audit.view**（矩阵里已存在，且只授予 admin/global）——
//    不新增权限、不扩大任何角色的授权。
// 3. **路径与写入方一致**：日志文件由 lib/audit 的 LOG_DIR 决定（尊重 SP_DATA_DIR），
//    因此沙箱测试读到的也是沙箱日志，不会碰到真实 data/audit.log。
// 4. **不做字段猜测**：日志是自由文本，只有时间戳可可靠解析（见 lib/audit 的说明）。
//    筛选用关键词匹配原始 message，不臆造「用户/结果」等列。
app.get('/api/audit-log', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  // RBAC：system.audit.view（审计日志是系统级数据，跨全连锁、无资源对象可范围化，
  //   因此只授予 admin（global）；不套 store 范围，也不新增 audit.delete / audit.export
  //   —— 当前并不存在对应的删除/导出接口）
  if (!guard.checkPerm(req, res, 'system.audit.view')) return;

  const q = String((req.query || {}).q || '').trim().toLowerCase();
  const page = Math.max(1, parseInt((req.query || {}).page, 10) || 1);
  const pageSize = Math.max(1, Math.min(200, parseInt((req.query || {}).pageSize, 10) || 50));

  let all = readAuditLog();                       // 已按时间倒序（最新在前）
  if (q) all = all.filter(x => String(x.message).toLowerCase().indexOf(q) !== -1);
  const total = all.length;
  const items = all.slice((page - 1) * pageSize, page * pageSize);
  res.json({
    items, total, page, pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

// ============ NSS Solar V2 管理域 / 通用审批 ==========
// 新功能使用独立集合和 workflow.* 权限，不复用旧的积分审核 pending 集合。
function controlVisible(req, permission, item) {
  const currentUser = getSessionUser(req);
  if (!currentUser || !item || !rbac.hasPermission(currentUser, permission)) return false;
  if (permission === 'workflow.view' && item.type === 'store_remediation' && item.assigneeId === currentUser.id) return true;
  // This helper receives an exact permission (for example workflow.view).
  // scopeOf expects a resource prefix, so use can() to apply that permission's actual scope.
  if (rbac.permScope(currentUser, permission) === 'self' && item.userId && (item.userId === currentUser.id || item.userId === currentUser.employeeId)) return true;
  let regionId = item.regionId || null;
  if (!regionId && item.storeId) regionId = (readAll('stores') || []).find(x => x.id === item.storeId)?.regionId || null;
  if (!regionId && item.warehouseId) regionId = (readAll('warehouses') || []).find(x => x.id === item.warehouseId)?.regionId || null;
  return rbac.can(currentUser, permission, { ...item, regionId, country: item.country || item.countryCode || 'PH' });
}
function canExecuteRemediation(req, res, item) {
  const user = getSessionUser(req);
  if (!user) { res.status(401).json({ error: '未登录' }); return false; }
  if (!item.assigneeId) { res.status(409).json({ error: '请先指派整改负责人' }); return false; }
  if (item.assigneeId !== user.id || !rbac.can(user, 'workflow.execute', item) || !controlVisible(req, 'workflow.view', item)) {
    res.status(403).json({ error: '只有当前整改负责人可以执行此流程' }); return false;
  }
  return true;
}
function eligibleRemediationAssignee(actor, target) {
  return target && !target.disabled && rbac.hasPermission(target, 'workflow.view') && rbac.hasPermission(target, 'workflow.execute') && rbac.canAssign(actor, target, 'task').ok;
}
function recordControlAudit(req, user, action, resourceType, resourceId, details = {}) {
  const events = readAll('auditEvents') || [];
  events.unshift({
    id: nanoid(), actorId: user?.id || null, actorName: user?.name || user?.username || 'system',
    action, resourceType, resourceId: resourceId || null, result: 'success', details,
    ip: clientIp(req), createdAt: nowIso(),
  });
  writeAll('auditEvents', events);
}
function normalizeTaskChecklist(raw) {
  if (raw == null || raw === '') return { ok: true, value: [] };
  if (typeof raw !== 'string' || raw.length > 12000) return { ok: false, error: '任务清单格式无效或内容过长' };
  const lines = raw.split(/\r?\n/).map(line => controlCenter.cleanText(line, 240)).filter(Boolean);
  if (lines.length > 40) return { ok: false, error: '任务清单最多可添加 40 项' };
  return { ok: true, value: lines.map(title => ({ id: nanoid(), title, completed: false, completedAt: null, completedBy: null, completedByName: null })) };
}
function canActOnTask(req, res, permission, task) {
  const user = getSessionUser(req);
  if (!user) { res.status(401).json({ error: '未登录' }); return false; }
  if (!rbac.hasPermission(user, permission) || !controlVisible(req, permission, task)) {
    res.status(403).json({ error: '无权限执行此操作' }); return false;
  }
  return true;
}
function canCollaborateOnTask(req, res, task) {
  const user = getSessionUser(req);
  if (!user) { res.status(401).json({ error: '未登录' }); return false; }
  const allowed = ['task.close','task.edit'].some(permission => rbac.hasPermission(user, permission) && controlVisible(req, permission, task));
  if (!allowed) { res.status(403).json({ error: '无权限操作此任务' }); return false; }
  return true;
}
function notifyUser(userId, type, title, body, resourceType, resourceId) {
  if (!userId) return;
  const items = readAll('notifications') || [];
  items.unshift({ id: nanoid(), userId, type, title, body, resourceType, resourceId, readAt: null, createdAt: nowIso() });
  writeAll('notifications', items.slice(0, 20000));
}
function approvalSlotsForUser(instance, user) {
  const step = (instance.approvalSteps || [])[instance.currentStep];
  if (!step || !user) return [];
  return (step.approvers || []).filter(a => a.kind === 'user' ? a.id === user.id : rbac.normalizeRole(a.id) === rbac.normalizeRole(user.role)).map(a => `${a.kind}:${a.id}`);
}
function approvalSlotForActor(instance, user) {
  if (!user) return null;
  const stepApprovals = (instance.stepApprovals || []).filter(x => x.step === instance.currentStep);
  const signed = new Set(stepApprovals.map(x => x.approverKey));
  const delegations = (instance.approvalDelegations || []).filter(x => x.step === instance.currentStep);
  const delegated = delegations.find(x => x.userId === user.id && !signed.has(x.approverKey));
  if (delegated) return delegated.approverKey;
  const delegatedKeys = new Set(delegations.map(x => x.approverKey));
  return approvalSlotsForUser(instance, user).find(key => !delegatedKeys.has(key) && !signed.has(key)) || null;
}
function notifyCurrentApprovers(instance) {
  if (instance.status !== 'pending_approval') return;
  const step = (instance.approvalSteps || [])[instance.currentStep]; if (!step) return;
  const users = readAll('users') || [], ids = new Set();
  for (const approver of step.approvers || []) {
    const approverKey = `${approver.kind}:${approver.id}`;
    const delegation = (instance.approvalDelegations || []).find(x => x.step === instance.currentStep && x.approverKey === approverKey);
    if (delegation) {
      const user = users.find(x => x.id === delegation.userId && !x.disabled);
      if (user && rbac.hasPermission(user, 'workflow.approve') && rbac.hasPermission(user, 'workflow.view') && rbac.can(user, 'workflow.approve', { ...instance, country: 'PH' }) && rbac.can(user, 'workflow.view', { ...instance, country: 'PH' })) ids.add(user.id);
      continue;
    }
    if (approver.kind === 'user') {
      const user = users.find(x => x.id === approver.id && !x.disabled);
      if (user && rbac.hasPermission(user, 'workflow.approve') && rbac.hasPermission(user, 'workflow.view') && rbac.can(user, 'workflow.approve', { ...instance, country: 'PH' }) && rbac.can(user, 'workflow.view', { ...instance, country: 'PH' })) ids.add(user.id);
    } else {
      users.filter(x => !x.disabled && (x.role === approver.id || rbac.normalizeRole(x.role) === rbac.normalizeRole(approver.id)))
        .filter(x => rbac.hasPermission(x, 'workflow.approve') && rbac.hasPermission(x, 'workflow.view') && rbac.can(x, 'workflow.approve', { ...instance, country: 'PH' }) && rbac.can(x, 'workflow.view', { ...instance, country: 'PH' }))
        .forEach(x => ids.add(x.id));
    }
  }
  ids.delete(instance.createdBy);
  for (const id of ids) notifyUser(id, 'workflow.pending', '待审批申请', instance.title, 'workflow', instance.id);
}

function nextApprovalDueAt(hours, base = Date.now()) {
  const value = Number(hours);
  return Number.isInteger(value) && value >= 1 && value <= 720 ? new Date(base + value * 60 * 60 * 1000).toISOString() : null;
}
function isIsoCalendarDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

app.get('/api/v2/organizations', (req, res) => {
  if (!guard.checkPerm(req, res, 'org.view')) return;
  const u = getSessionUser(req);
  const items = (readAll('organizations') || []).filter(x => controlVisible(req, 'org.view', x));
  res.json({ items, countryCenters: [{ code: 'CN', name: '中国管理中心' }, { code: 'PH', name: '菲律宾管理中心' }] });
});
app.post('/api/v2/users', (req, res) => {
  const actor = getSessionUser(req); if (!actor) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'system.user.edit')) return;
  const b = req.body || {}, username = controlCenter.cleanText(b.username, 48), name = controlCenter.cleanText(b.name, 120);
  const password = String(b.password || ''), role = String(b.role || '');
  const allowedRoles = ['admin','owner','hq_operator','philippines_manager','regional_manager','manager','sales','warehouse','service'];
  if (!/^[a-zA-Z0-9_]{3,48}$/.test(username)) return res.status(400).json({ error: '用户名须为 3 至 48 位英文字母、数字或下划线' });
  if (!name || password.length < 6) return res.status(400).json({ error: '请填写姓名，并设置至少 6 位的初始密码' });
  if (!allowedRoles.includes(role)) return res.status(400).json({ error: '角色无效' });
  const users = readAll('users') || [];
  if (users.some(x => x.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: '用户名已存在' });
  const stores = readAll('stores') || [], regions = readAll('regions') || [], employees = readAll('employees') || [];
  const store = b.storeId ? stores.find(x => x.id === b.storeId) : null;
  const region = b.regionId ? regions.find(x => x.id === b.regionId && x.active !== false) : null;
  if (b.storeId && !store) return res.status(400).json({ error: '所选门店不存在' });
  if (b.regionId && !region) return res.status(400).json({ error: '所选区域不存在或已停用' });
  if (['manager','sales','warehouse','service'].includes(role) && !store) return res.status(400).json({ error: '该岗位必须绑定门店' });
  if (role === 'regional_manager' && !region) return res.status(400).json({ error: '区域经理必须绑定区域' });
  if (store && region && store.regionId && store.regionId !== region.id) return res.status(400).json({ error: '所选门店与区域不匹配' });
  const employee = b.employeeId ? employees.find(x => x.id === b.employeeId && x.active !== false) : null;
  if (b.employeeId && !employee) return res.status(400).json({ error: '员工档案不存在或已停用' });
  if (employee?.userId) return res.status(409).json({ error: '该员工已关联登录账号' });
  if (employee?.storeId && store && employee.storeId !== store.id) return res.status(400).json({ error: '员工档案门店与账号绑定门店不一致' });
  if (role === 'regional_manager' && employee?.storeId && region && stores.find(x => x.id === employee.storeId)?.regionId !== region.id) return res.status(400).json({ error: '员工所属门店与账号绑定区域不一致' });
  if (role === 'manager' && store?.managerId) return res.status(409).json({ error: '该门店已有店长账号，请先在门店管理中更换或解绑' });
  const user = { id: nanoid(), username, password: bcrypt.hashSync(password, 12), name, role, storeId: store?.id || null, regionId: role === 'regional_manager' ? region.id : (region?.id || store?.regionId || null), employeeId: employee?.id || null, phone: controlCenter.cleanText(b.phone, 80), createdAt: nowIso(), disabled: false, mustChangePassword: true };
  users.push(user); writeAll('users', users);
  if (employee) { employee.userId = user.id; employee.name = name; if (!employee.storeId && store) employee.storeId = store.id; if (!employee.regionId) employee.regionId = user.regionId; employee.updatedAt = nowIso(); writeAll('employees', employees); }
  if (role === 'manager' && store) { store.managerId = user.id; store.managerName = name; writeAll('stores', stores); }
  recordControlAudit(req, actor, 'user.create', 'user', user.id, { role, storeId: user.storeId, regionId: user.regionId, employeeId: user.employeeId });
  const { password: _password, ...safe } = user; res.status(201).json({ item: safe });
});
app.post('/api/v2/organizations', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'org.manage')) return;
  const b = req.body || {}, name = controlCenter.cleanText(b.name, 120), code = controlCenter.cleanText(b.code, 40).toUpperCase();
  if (!name || !code) return res.status(400).json({ error: '组织名称和编码不能为空' });
  const items = readAll('organizations') || [];
  if (items.some(x => x.code.toLowerCase() === code.toLowerCase())) return res.status(409).json({ error: '组织编码已存在' });
  const item = { id: nanoid(), code, name, type: controlCenter.cleanText(b.type || 'unit', 40), countryCode: controlCenter.cleanText(b.countryCode || 'PH', 2).toUpperCase(), parentId: b.parentId || null, timezone: controlCenter.cleanText(b.timezone || 'Asia/Manila', 80), active: true, createdAt: nowIso(), updatedAt: nowIso() };
  items.push(item); writeAll('organizations', items); recordControlAudit(req, u, 'organization.create', 'organization', item.id, { code, name });
  res.status(201).json({ item });
});
app.get('/api/v2/regions', (req, res) => {
  if (!guard.checkPerm(req, res, 'org.view')) return;
  res.json({ items: (readAll('regions') || []).filter(x => x.active !== false && controlVisible(req, 'org.view', x)) });
});
app.post('/api/v2/regions', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'org.manage')) return;
  const b = req.body || {}, code = controlCenter.cleanText(b.code, 40).toUpperCase(), name = controlCenter.cleanText(b.name, 120);
  if (!code || !name) return res.status(400).json({ error: '区域编码和名称不能为空' });
  const items = readAll('regions') || [];
  if (items.some(x => x.code.toLowerCase() === code.toLowerCase())) return res.status(409).json({ error: '区域编码已存在' });
  const now = nowIso(), item = { id: nanoid(), code, name, organizationId: b.organizationId || null, countryCode: controlCenter.cleanText(b.countryCode || 'PH', 2).toUpperCase(), active: true, createdAt: now, updatedAt: now };
  items.push(item); writeAll('regions', items); recordControlAudit(req, u, 'region.create', 'region', item.id, { code, name }); res.status(201).json({ item });
});
for (const directory of [
  { path: 'departments', collection: 'departments', name: '部门' },
  { path: 'positions', collection: 'positions', name: '岗位' },
]) {
  app.get(`/api/v2/${directory.path}`, (req, res) => {
    if (!guard.checkPerm(req, res, 'org.view')) return;
    res.json({ items: (readAll(directory.collection) || []).filter(x => x.active !== false && controlVisible(req, 'org.view', x)) });
  });
  app.post(`/api/v2/${directory.path}`, (req, res) => {
    const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
    if (!guard.checkPerm(req, res, 'org.manage')) return;
    const b = req.body || {}, code = controlCenter.cleanText(b.code, 40).toUpperCase(), name = controlCenter.cleanText(b.name, 120);
    if (!code || !name) return res.status(400).json({ error: `${directory.name}编码和名称不能为空` });
    const items = readAll(directory.collection) || [];
    if (items.some(x => x.code.toLowerCase() === code.toLowerCase())) return res.status(409).json({ error: `${directory.name}编码已存在` });
    const now = nowIso(), item = { id: nanoid(), code, name, organizationId: b.organizationId || null, parentId: b.parentId || null, departmentId: b.departmentId || null, active: true, createdAt: now, updatedAt: now };
    items.push(item); writeAll(directory.collection, items); recordControlAudit(req, u, `${directory.path}.create`, directory.path, item.id, { code, name }); res.status(201).json({ item });
  });
}

app.all('/api/v2/warehouses', (req, res) => res.status(410).json({ error: '集团中控不再维护仓库档案' }));
app.all('/api/v2/warehouses/:id', (req, res) => res.status(410).json({ error: '集团中控不再维护仓库档案' }));
app.get('/api/v2/employees', (req, res) => {
  if (!guard.checkPerm(req, res, 'staff.view')) return;
  const items = (readAll('employees') || []).filter(x => x.active !== false && controlVisible(req, 'staff.view', x));
  res.json({ items });
});
app.post('/api/v2/employees', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'staff.create')) return;
  const b = req.body || {}, name = controlCenter.cleanText(b.name, 120), employeeCode = controlCenter.cleanText(b.employeeCode, 40).toUpperCase();
  if (!name || !employeeCode) return res.status(400).json({ error: '员工姓名和员工编号不能为空' });
  if (b.warehouseId) return res.status(400).json({ error: '当前版本不维护仓库负责人关系' });
  const storeId = b.storeId || (guard.scopeOf(req, 'staff.create').level === 'store' ? u.storeId : null);
  if (!guard.check(req, res, 'staff.create', { storeId, country: 'PH' })) return;
  const items = readAll('employees') || [];
  if (items.some(x => x.employeeCode.toLowerCase() === employeeCode.toLowerCase())) return res.status(409).json({ error: '员工编号已存在' });
  const linkedStore = storeId ? (readAll('stores') || []).find(x => x.id === storeId) : null;
  const now = nowIso(), item = { id: nanoid(), employeeCode, name, email: controlCenter.cleanText(b.email, 180), phone: controlCenter.cleanText(b.phone, 80), organizationId: b.organizationId || null, departmentId: b.departmentId || null, positionId: b.positionId || null, storeId, warehouseId: null, regionId: linkedStore?.regionId || null, userId: b.userId || null, active: true, createdAt: now, updatedAt: now };
  items.push(item); writeAll('employees', items); recordControlAudit(req, u, 'employee.create', 'employee', item.id, { employeeCode, name });
  res.status(201).json({ item });
});
app.put('/api/v2/employees/:id', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const items = readAll('employees') || [], item = items.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '员工档案不存在' });
  if (!guard.check(req, res, 'staff.edit', item)) return;
  const b = req.body || {};
  if (b.warehouseId !== undefined) return res.status(400).json({ error: '当前版本不维护仓库负责人关系' });
  const nextStoreId = b.storeId !== undefined ? (b.storeId || null) : item.storeId;
  const nextStore = nextStoreId ? (readAll('stores') || []).find(x => x.id === nextStoreId) : null;
  if (nextStoreId && !nextStore) return res.status(400).json({ error: '门店不存在' });
  const nextRegionId = nextStore?.regionId || null;
  if (!guard.check(req, res, 'staff.edit', { ...item, storeId: nextStoreId, regionId: nextRegionId })) return;
  for (const k of ['name','email','phone','departmentId','positionId','userId']) if (b[k] !== undefined) item[k] = controlCenter.cleanText(b[k], k === 'name' ? 120 : 180) || null;
  if (b.userId) {
    const user = (readAll('users') || []).find(x => x.id === b.userId && !x.disabled);
    if (!user || (user.employeeId && user.employeeId !== item.id)) return res.status(400).json({ error: '所选账号不存在、已停用或已关联其他员工' });
    user.employeeId = item.id; if (!user.storeId && nextStoreId) user.storeId = nextStoreId; if (!user.regionId) user.regionId = nextRegionId;
    writeAll('users', (readAll('users') || []).map(x => x.id === user.id ? user : x));
  }
  item.storeId = nextStoreId; item.regionId = nextRegionId;
  if (b.active !== undefined) item.active = !!b.active;
  item.updatedAt = nowIso(); writeAll('employees', items); recordControlAudit(req, u, 'employee.update', 'employee', item.id);
  res.json({ item });
});

app.get('/api/v2/workflows/types', (req, res) => {
  if (!guard.checkPerm(req, res, 'workflow.view')) return;
  res.json({ items: Object.entries(controlCenter.WORKFLOW_TYPES).map(([key, x]) => ({ key, label: x.label, required: x.required, amountField: x.money })) });
});
app.get('/api/v2/workflows/definitions', (req, res) => {
  if (!guard.checkPerm(req, res, 'workflow.configure')) return;
  res.json({ items: (readAll('workflowDefinitions') || []).filter(x => x.active !== false && controlCenter.WORKFLOW_TYPES[x.type]) });
});
app.get('/api/v2/workflows/:id/delegates', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const item = (readAll('workflowInstances') || []).find(x => x.id === req.params.id);
  if (!item || !controlCenter.WORKFLOW_TYPES[item.type]) return res.status(404).json({ error: '申请不存在' });
  if (!guard.check(req, res, 'workflow.approve', item)) return;
  if (item.status !== 'pending_approval' || item.createdBy === u.id) return res.status(409).json({ error: '当前申请不能转交给其他审批人' });
  const signedSlots = new Set((item.stepApprovals || []).filter(x => x.step === item.currentStep).map(x => x.approverKey));
  const delegatedSlots = new Set((item.approvalDelegations || []).filter(x => x.step === item.currentStep).map(x => x.approverKey));
  const slots = approvalSlotsForUser(item, u).filter(key => !signedSlots.has(key) && !delegatedSlots.has(key));
  if (!slots.length) return res.status(403).json({ error: '你不是当前步骤可转交的审批人' });
  const eligible = (readAll('users') || []).filter(target => !target.disabled && target.id !== u.id && target.id !== item.createdBy && rbac.hasPermission(target, 'workflow.approve') && rbac.hasPermission(target, 'workflow.view') && rbac.can(target, 'workflow.approve', { ...item, country: 'PH' }) && rbac.can(target, 'workflow.view', { ...item, country: 'PH' }));
  res.json({ slots: slots.map(key => ({ key, label: key.startsWith('role:') ? key.slice(5) : (readAll('users') || []).find(x => x.id === key.slice(5))?.name || key.slice(5) })), users: eligible.map(x => ({ id: x.id, name: x.name || x.username, username: x.username })) });
});
app.get('/api/v2/workflows/:id/assignees', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const item = (readAll('workflowInstances') || []).find(x => x.id === req.params.id);
  if (!item || item.type !== 'store_remediation') return res.status(404).json({ error: '整改申请不存在' });
  if (!['approved','execution_pending'].includes(item.status)) return res.status(409).json({ error: '当前阶段不能指派整改负责人' });
  if (!guard.check(req, res, 'task.assign', item)) return;
  if (!guard.check(req, res, 'workflow.view', item)) return;
  const users = (readAll('users') || []).filter(x => eligibleRemediationAssignee(u, x));
  res.json({ items: users.map(x => ({ id: x.id, name: x.name || x.username, username: x.username })) });
});
app.put('/api/v2/workflows/definitions/:type', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'workflow.configure')) return;
  const type = String(req.params.type), b = req.body || {};
  if (!controlCenter.WORKFLOW_TYPES[type]) return res.status(404).json({ error: '流程类型不存在' });
  const steps = Array.isArray(b.steps) ? b.steps : [];
  if (!steps.length || steps.length > 10) return res.status(400).json({ error: '审批步骤须为 1 至 10 步' });
  const slaHours = b.slaHours == null || b.slaHours === '' ? null : Number(b.slaHours);
  if (slaHours !== null && (!Number.isInteger(slaHours) || slaHours < 1 || slaHours > 720)) return res.status(400).json({ error: '审批时限须为 1 至 720 小时；留空表示不设时限' });
  const validRoles = ['admin','owner','hq_operator','philippines_manager','regional_manager','store_manager','sales','warehouse','service'];
  const activeUsers = readAll('users') || [];
  const normalized = [];
  for (const step of steps) {
    const approvers = Array.isArray(step.approvers) ? step.approvers.map(a => ({ kind: a.kind === 'user' ? 'user' : 'role', id: controlCenter.cleanText(a.id, 100) })).filter(a => a.id) : [];
    if (!approvers.length || approvers.length > 20) return res.status(400).json({ error: '每个审批步骤至少需要 1 名用户或角色，最多 20 名' });
    if (approvers.some(a => a.kind === 'role' && !validRoles.includes(a.id))) return res.status(400).json({ error: '审批角色不在系统角色清单内' });
    if (approvers.some(a => a.kind === 'role' && (!rbac.hasPermission({ role: a.id }, 'workflow.approve') || !rbac.hasPermission({ role: a.id }, 'workflow.view')))) return res.status(400).json({ error: `角色“${a.id}”缺少流程查看或审批权限` });
    if (approvers.some(a => a.kind === 'user' && !activeUsers.some(x => x.id === a.id && !x.disabled))) return res.status(400).json({ error: '审批用户不存在或已停用' });
    if (approvers.some(a => a.kind === 'user' && (!rbac.hasPermission(activeUsers.find(x => x.id === a.id), 'workflow.approve') || !rbac.hasPermission(activeUsers.find(x => x.id === a.id), 'workflow.view')))) return res.status(400).json({ error: '指定审批账号缺少流程查看或审批权限' });
    normalized.push({ label: controlCenter.cleanText(step.label || 'Approval', 100), mode: step.mode === 'all' ? 'all' : 'any', approvers });
  }
  const defs = readAll('workflowDefinitions') || [], existing = defs.find(x => x.type === type);
  const now = nowIso();
  if (existing) { existing.name = controlCenter.WORKFLOW_TYPES[type].label; existing.version = Number(existing.version || 0) + 1; existing.config = { steps: normalized, slaHours }; existing.updatedAt = now; }
  else defs.push({ id: nanoid(), type, name: controlCenter.WORKFLOW_TYPES[type].label, version: 1, active: true, config: { steps: normalized, slaHours }, createdAt: now, updatedAt: now });
  writeAll('workflowDefinitions', defs); recordControlAudit(req, u, 'workflow.definition.update', 'workflowDefinition', existing?.id || defs[defs.length - 1].id, { type, version: existing?.version || 1 });
  res.json({ item: existing || defs[defs.length - 1] });
});
app.get('/api/v2/workflows', (req, res) => {
  if (!guard.checkPerm(req, res, 'workflow.view')) return;
  const u = getSessionUser(req), status = String(req.query.status || ''), type = String(req.query.type || ''), query = controlCenter.cleanText(req.query.q, 160).toLocaleLowerCase();
  const counts = {}, countsByType = {};
  const visible = (readAll('workflowInstances') || []).filter(x => controlVisible(req, 'workflow.view', x));
  visible.forEach(x => {
    counts[x.status] = (counts[x.status] || 0) + 1;
    countsByType[x.type] = countsByType[x.type] || {};
    countsByType[x.type][x.status] = (countsByType[x.type][x.status] || 0) + 1;
  });
  const actionableIds = new Set(visible.filter(x => x.status === 'pending_approval' && x.createdBy !== u.id && controlCenter.WORKFLOW_TYPES[x.type] && controlVisible(req, 'workflow.approve', x) && approvalSlotForActor(x, u)).map(x => x.id));
  const pendingForMe = actionableIds.size;
  let items = visible;
  if (status) items = items.filter(x => x.status === status);
  if (type) items = items.filter(x => x.type === type);
  if (req.query.mine === '1') items = items.filter(x => x.createdBy === u.id);
  if (req.query.actionable === '1') items = items.filter(x => actionableIds.has(x.id));
  if (query) items = items.filter(x => [x.title, x.createdByName, x.assigneeName, x.storeId, x.regionId, x.externalDocumentNumber, ...Object.entries(x.form || {}).filter(([key]) => key !== 'items').map(([, value]) => value)].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
  items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const total = items.length, limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 25));
  const rawOffset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const offset = total ? Math.min(rawOffset, Math.floor((total - 1) / limit) * limit) : 0;
  res.json({ items: items.slice(offset, offset + limit).map(x => ({ ...x, actionableForMe: actionableIds.has(x.id) })), total, offset, limit, counts, countsByType, pendingForMe });
});
app.post('/api/v2/workflows', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'workflow.create')) return;
  const b = req.body || {}, type = String(b.type || '');
  // 2026-10-07：门店整改已停用新建（前端三个入口一并移除）。
  // 服务端同步拦截，防止绕过界面直接调 API 建单；存量申请不受影响，仍可审批/整改/关闭。
  if (type === 'store_remediation') return res.status(400).json({ error: '门店整改流程已停用新建，如有需要请联系集团管理员' });
  if (b.sourceFile && type !== 'stocktake') return res.status(400).json({ error: '只有盘点申请可以直接附加表格' });
  const sourceResult = b.sourceFile ? parseStocktakeSourceFile(b.sourceFile) : null;
  if (sourceResult?.error) return res.status(400).json({ error: sourceResult.error });
  const source = sourceResult?.value || null;
  const valid = controlCenter.validateWorkflow(type, b.form, { allowEmptyStocktakeItems: !!source });
  if (!valid.ok) return res.status(400).json({ error: valid.error });
  const form = valid.value;
  if (source) form.sourceFileName = source.name;
  const sourceInspectionId = controlCenter.cleanText(b.sourceInspectionId, 100);
  const sourceInspection = sourceInspectionId ? (readAll('storeInspections') || []).find(x => x.id === sourceInspectionId) : null;
  if (sourceInspectionId && !sourceInspection) return res.status(404).json({ error: '来源巡检记录不存在' });
  if (sourceInspection && type !== 'store_remediation') return res.status(400).json({ error: '巡检记录只能转为门店整改申请' });
  if (sourceInspection) {
    const sourceStore = (readAll('stores') || []).find(x => x.id === sourceInspection.storeId);
    if (!sourceStore || form.storeName !== sourceStore.name) return res.status(400).json({ error: '整改门店必须与来源巡检门店一致' });
    const existingRequest = (readAll('workflowInstances') || []).find(x => x.type === 'store_remediation' && x.sourceInspectionId === sourceInspection.id && !['rejected','cancelled','completed'].includes(x.status));
    if (existingRequest) return res.status(409).json({ error: `该巡检已关联未完成的门店整改申请（${existingRequest.id}）` });
  }
  if (sourceInspection && !guard.check(req, res, 'workflow.create', sourceInspection)) return;
  const scope = guard.scopeOf(req, 'workflow.create');
  const storesKnown = readAll('stores') || [];
  const storeId = scope.level === 'store' ? u.storeId : null;
  const linkedStore = storesKnown.find(x => x.id === storeId);
  const warehouseId = null;
  if (linkedStore && type === 'store_remediation') form.storeName = linkedStore.name;
  if (scope.level === 'store' && !storeId) return res.status(403).json({ error: '账号尚未绑定门店' });
  const regionId = scope.level === 'region' ? scope.regionId : (linkedStore?.regionId || null);
  const scopeResource = { storeId, regionId, country: 'PH', createdBy: u.id };
  if (!guard.check(req, res, 'workflow.create', scopeResource)) return;
  let assignee = null;
  if (type === 'store_remediation' && form.assigneeId) {
    if (!guard.checkPerm(req, res, 'task.assign') || !guard.check(req, res, 'task.assign', { storeId, regionId, country: 'PH', createdBy: u.id })) return;
    assignee = (readAll('users') || []).find(x => x.id === form.assigneeId && !x.disabled);
    if (!assignee) return res.status(400).json({ error: '整改负责人账号不存在或已停用' });
    const assignment = rbac.canAssign(u, assignee, 'task');
    if (!assignment.ok) return res.status(403).json({ error: assignment.reason || '无权指派该整改负责人' });
    if (!rbac.hasPermission(assignee, 'workflow.view') || !rbac.hasPermission(assignee, 'workflow.execute')) return res.status(400).json({ error: '该账号没有整改流程查看或执行权限' });
  }
  delete form.assigneeId;
  const items = readAll('workflowInstances') || [];
  const spec = controlCenter.WORKFLOW_TYPES[type];
  const item = { id: nanoid(), type, title: controlCenter.cleanText(b.title || spec.label, 180), status: 'pending_approval', assigneeId: assignee?.id || null, assigneeName: assignee ? (assignee.name || assignee.username) : null, form, definitionId: null, definitionVersion: 1, storeId, warehouseId, regionId, organizationId: b.organizationId || null, sourceInspectionId: sourceInspection?.id || null, createdBy: u.id, createdByName: u.name || u.username, createdAt: nowIso(), updatedAt: nowIso(), currentStep: 0, approvalSlaHours: null, approvalDueAt: null, approvalReminderAt: null, approvalDelegations: [], executionRound: 0, externalDocumentNumber: null, executionStatus: null, executedBy: null, executedAt: null, comments: [], attachments: [] };
  const def = (readAll('workflowDefinitions') || []).find(x => x.type === type && x.active !== false);
  item.definitionId = def ? def.id : null;
  item.definitionVersion = def ? Number(def.version || 1) : 1;
  item.approvalSlaHours = Number.isInteger(def?.config?.slaHours) ? def.config.slaHours : null;
  item.approvalDueAt = nextApprovalDueAt(item.approvalSlaHours, new Date(item.createdAt).getTime());
  item.approvalSteps = def?.config?.steps?.length ? JSON.parse(JSON.stringify(def.config.steps)) : [{ label: 'Management approval', mode: 'any', approvers: [{ kind: 'role', id: 'admin' }, { kind: 'role', id: 'owner' }, { kind: 'role', id: 'philippines_manager' }] }];
  item.stepApprovals = [];
  if (sourceInspection) {
    const sourceAttachments = Array.isArray(sourceInspection.attachments) ? sourceInspection.attachments : [];
    const validAttachments = sourceAttachments.filter(x => workflowAttachmentTypes[x.mimeType]?.ext && /^[A-Za-z0-9_-]+\.(pdf|png|jpg)$/.test(x.storedName || '') && fs.existsSync(path.join(storeOperationAttachmentDir, x.storedName)));
    if (validAttachments.length > 10 || validAttachments.reduce((sum, x) => sum + Number(x.size || 0), 0) > 20 * 1024 * 1024) return res.status(409).json({ error: '来源巡检附件过多，请分批创建整改申请' });
    fs.mkdirSync(path.dirname(workflowAttachmentDir), { recursive: true, mode: 0o700 }); fs.mkdirSync(workflowAttachmentDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(workflowAttachmentDir), 0o700); fs.chmodSync(workflowAttachmentDir, 0o700);
    try {
      for (const source of validAttachments) {
        const ext = workflowAttachmentTypes[source.mimeType].ext, id = nanoid(), storedName = `${id}${ext}`;
        fs.copyFileSync(path.join(storeOperationAttachmentDir, source.storedName), path.join(workflowAttachmentDir, storedName), fs.constants.COPYFILE_EXCL);
        item.attachments.push({ id, name: source.name, mimeType: source.mimeType, evidenceType: 'supporting', executionRound: null, size: source.size, storedName, uploadedBy: u.id, uploadedByName: u.name || u.username, sourceRecordKind: 'storeInspection', sourceRecordId: sourceInspection.id, createdAt: nowIso() });
      }
    } catch (err) {
      for (const attachment of item.attachments) { try { fs.unlinkSync(path.join(workflowAttachmentDir, attachment.storedName)); } catch (cleanupError) {} }
      return res.status(500).json({ error: '复制巡检凭证失败，整改申请未创建' });
    }
  }
  if (source) {
    try { saveStocktakeSource(item, u, source); }
    catch (err) { return res.status(500).json({ error: '保存盘点表格失败，申请未创建' }); }
  }
  item.history = [{ action: 'submit', actorId: u.id, actorName: item.createdByName, note: '', createdAt: item.createdAt }];
  items.unshift(item);
  try {
    writeAll('workflowInstances', items);
  } catch (err) {
    for (const attachment of item.attachments) {
      try { fs.unlinkSync(path.join(workflowAttachmentDir, attachment.storedName)); } catch (cleanupError) {}
    }
    return res.status(500).json({ error: '保存申请失败，请重试' });
  }
  if (sourceInspection) {
    sourceInspection.remediationWorkflowId = item.id;
    sourceInspection.updatedAt = item.updatedAt;
    try { writeAll('storeInspections', (readAll('storeInspections') || []).map(x => x.id === sourceInspection.id ? sourceInspection : x)); } catch (err) {}
  }
  recordControlAudit(req, u, 'workflow.submit', type, item.id, { title: item.title, assigneeId: item.assigneeId });
  if (sourceInspection && item.attachments.length) recordControlAudit(req, u, 'workflow.attachment.import', type, item.id, { sourceInspectionId: sourceInspection.id, count: item.attachments.length });
  notifyCurrentApprovers(item);
  if (assignee) notifyUser(assignee.id, 'store.remediation.assigned', '收到门店整改任务', item.title, 'workflow', item.id);
  res.status(201).json({ item });
});
app.post('/api/v2/workflows/:id/actions', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const items = readAll('workflowInstances') || [], item = items.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '申请不存在' });
  const action = controlCenter.cleanText(req.body?.action, 40);
  if (!controlCenter.WORKFLOW_TYPES[item.type]) return res.status(409).json({ error: '该流程已停用，仅保留历史记录' });
  if (action === 'assign') {
    if (item.type !== 'store_remediation' || !['approved','execution_pending'].includes(item.status)) return res.status(409).json({ error: '当前阶段不能指派整改负责人' });
    if (!guard.check(req, res, 'task.assign', item)) return;
    if (!guard.check(req, res, 'workflow.view', item)) return;
    const target = (readAll('users') || []).find(x => x.id === req.body?.assigneeId);
    if (!eligibleRemediationAssignee(u, target)) return res.status(403).json({ error: '目标账号无整改执行权限或不在可指派范围内' });
    if (target.id === item.assigneeId) return res.status(409).json({ error: '该账号已是当前整改负责人' });
    const priorAssigneeId = item.assigneeId;
    const round = Math.max(1, Number(item.executionRound) || 1);
    if ((item.attachments || []).some(x => Number(x.executionRound) === round && ['before','after'].includes(x.evidenceType))) item.executionRound = round + 1;
    item.assigneeId = target.id;
    item.assigneeName = target.name || target.username;
    item.executionStatus = item.status === 'execution_pending' ? 'in_progress' : null;
    item.executedBy = null;
    item.executedAt = null;
    item.overdueReminderAt = null;
    item.updatedAt = nowIso();
    item.history = Array.isArray(item.history) ? item.history : [];
    item.history.push({ action: 'assignee.update', actorId: u.id, actorName: u.name || u.username, note: item.assigneeName, createdAt: item.updatedAt });
    writeAll('workflowInstances', items);
    recordControlAudit(req, u, 'workflow.assignee.update', item.type, item.id, { previousAssigneeId: priorAssigneeId, assigneeId: target.id, executionRound: item.executionRound });
    notifyUser(target.id, 'store.remediation.assigned', '收到门店整改任务', item.title, 'workflow', item.id);
    notifyUser(item.createdBy, 'workflow.assignee.update', '门店整改负责人已更新', item.title, 'workflow', item.id);
    return res.json({ item });
  }
  if (action === 'delegate') {
    if (!guard.check(req, res, 'workflow.approve', item)) return;
    if (item.status !== 'pending_approval' || item.createdBy === u.id) return res.status(409).json({ error: '当前申请不能转交给其他审批人' });
    const signedSlots = new Set((item.stepApprovals || []).filter(x => x.step === item.currentStep).map(x => x.approverKey));
    const delegatedSlots = new Set((item.approvalDelegations || []).filter(x => x.step === item.currentStep).map(x => x.approverKey));
    const availableSlots = approvalSlotsForUser(item, u).filter(key => !signedSlots.has(key) && !delegatedSlots.has(key));
    const approverKey = controlCenter.cleanText(req.body?.approverKey, 120);
    if (!availableSlots.includes(approverKey)) return res.status(403).json({ error: '你不能转交这个审批名额' });
    const target = (readAll('users') || []).find(x => x.id === req.body?.delegateUserId && !x.disabled);
    if (!target || target.id === u.id || target.id === item.createdBy || !rbac.hasPermission(target, 'workflow.approve') || !rbac.hasPermission(target, 'workflow.view') || !rbac.can(target, 'workflow.approve', { ...item, country: 'PH' }) || !rbac.can(target, 'workflow.view', { ...item, country: 'PH' })) return res.status(400).json({ error: '转交对象无有效审批权限或不在数据范围内' });
    const createdAt = nowIso(), note = controlCenter.cleanText(req.body?.note, 1000);
    item.approvalDelegations = Array.isArray(item.approvalDelegations) ? item.approvalDelegations : [];
    item.approvalDelegations.push({ step: item.currentStep, approverKey, userId: target.id, userName: target.name || target.username, delegatedBy: u.id, delegatedByName: u.name || u.username, note, createdAt });
    item.approvalReminderAt = null; item.updatedAt = createdAt;
    item.history = Array.isArray(item.history) ? item.history : [];
    item.history.push({ action: 'delegate', actorId: u.id, actorName: u.name || u.username, note: `${approverKey} → ${target.name || target.username}${note ? ` · ${note}` : ''}`, createdAt });
    writeAll('workflowInstances', items);
    recordControlAudit(req, u, 'workflow.delegate', item.type, item.id, { approverKey, delegateUserId: target.id });
    notifyUser(item.createdBy, 'workflow.delegate', '审批人已转交', item.title, 'workflow', item.id);
    notifyCurrentApprovers(item);
    return res.json({ item });
  }
  if (action === 'comment') {
    const note = controlCenter.cleanText(req.body?.comment, 2000);
    if (!note) return res.status(400).json({ error: '备注内容不能为空' });
    const isOwner = item.createdBy === u.id, isAssignee = item.assigneeId === u.id;
    if (isOwner) { if (!guard.check(req, res, 'workflow.create', item)) return; }
    else if (isAssignee) { if (!canExecuteRemediation(req, res, item)) return; }
    else if (!guard.check(req, res, 'workflow.approve', item)) return;
    if (!isOwner && !isAssignee && item.status !== 'pending_approval') return res.status(409).json({ error: '当前流程不接受审批备注' });
    if (isAssignee && !['approved','execution_pending','awaiting_review'].includes(item.status)) return res.status(409).json({ error: '整改当前阶段不接受执行备注' });
    if (!isOwner && !isAssignee) {
      if (!approvalSlotForActor(item, u)) return res.status(403).json({ error: '当前审批步骤未授权此账号' });
    }
    if (['rejected','cancelled','completed'].includes(item.status)) return res.status(409).json({ error: '已结束的流程不能添加备注' });
    item.comments = Array.isArray(item.comments) ? item.comments : [];
    const comment = { id: nanoid(), actorId: u.id, actorName: u.name || u.username, comment: note, createdAt: nowIso() };
    item.comments.push(comment);
    item.history = Array.isArray(item.history) ? item.history : [];
    item.history.push({ action: 'comment', actorId: u.id, actorName: comment.actorName, note, createdAt: comment.createdAt });
    item.updatedAt = comment.createdAt; writeAll('workflowInstances', items);
    recordControlAudit(req, u, 'workflow.comment', item.type, item.id);
    if (isOwner) notifyCurrentApprovers(item); else notifyUser(item.createdBy, 'workflow.comment', '申请收到审批备注', item.title, 'workflow', item.id);
    return res.json({ item, comment });
  }
  if (action === 'approve' || action === 'reject' || action === 'return') {
    if (!guard.check(req, res, 'workflow.approve', item)) return;
    if (item.createdBy === u.id) return res.status(403).json({ error: '申请人不能审批自己的申请' });
    {
      const step = (item.approvalSteps || [])[item.currentStep] || {};
      const assignedSlot = approvalSlotForActor(item, u);
      if (!assignedSlot) return res.status(403).json({ error: '当前审批步骤未授权此账号' });
      req.workflowApproverKey = assignedSlot;
    }
  } else if (action === 'resubmit') {
    if (item.createdBy !== u.id || !guard.check(req, res, 'workflow.create', item)) return;
    if (!controlCenter.WORKFLOW_TYPES[item.type]) return res.status(409).json({ error: '该流程类型已停止使用，历史申请仅保留查看' });
  } else if (action === 'execution') {
    if (item.type === 'store_remediation') { if (!canExecuteRemediation(req, res, item)) return; }
    else if (!guard.check(req, res, 'workflow.execute', item)) return;
    if (item.type === 'store_remediation' && req.body?.executionStatus === 'completed') {
      const round = Math.max(1, Number(item.executionRound) || 1);
      const evidenceTypes = new Set((item.attachments || []).filter(x => Number(x.executionRound) === round).map(x => x.evidenceType || 'supporting'));
      if (!evidenceTypes.has('before') || !evidenceTypes.has('after')) return res.status(409).json({ error: '提交复查前，请先上传整改前和整改后的凭证' });
    }
  } else if (action === 'review_pass' || action === 'review_return') {
    if (!guard.check(req, res, 'workflow.approve', item)) return;
    if (action === 'review_pass') {
      const round = Math.max(1, Number(item.executionRound) || 1);
      const evidenceTypes = new Set((item.attachments || []).filter(x => Number(x.executionRound) === round).map(x => x.evidenceType || 'supporting'));
      if (!evidenceTypes.has('before') || !evidenceTypes.has('after')) return res.status(409).json({ error: '缺少整改前或整改后凭证，暂时不能确认关闭' });
    }
  } else if (action === 'cancel') {
    if (item.createdBy !== u.id) return res.status(403).json({ error: '只有申请人可以撤回' });
  } else return res.status(400).json({ error: '不支持的操作' });
  let assigneeChanged = false;
  let newAssignee = null;
  let pendingSource = null;
  if (action === 'resubmit') {
    if (req.body?.sourceFile && item.type !== 'stocktake') return res.status(400).json({ error: '只有盘点申请可以直接附加表格' });
    const sourceResult = req.body?.sourceFile ? parseStocktakeSourceFile(req.body.sourceFile) : null;
    if (sourceResult?.error) return res.status(400).json({ error: sourceResult.error });
    pendingSource = sourceResult?.value || null;
    if (pendingSource && !stocktakeSourceCapacity(item, pendingSource)) return res.status(409).json({ error: '此申请附件最多 10 个，合计不超过 20MB' });
    const valid = controlCenter.validateWorkflow(item.type, req.body?.form, { allowEmptyStocktakeItems: !!pendingSource || hasStocktakeSource(item) });
    if (!valid.ok) return res.status(400).json({ error: valid.error });
    if (pendingSource) valid.value.sourceFileName = pendingSource.name;
    else if (item.type === 'stocktake' && hasStocktakeSource(item)) valid.value.sourceFileName = item.form?.sourceFileName || (item.attachments || []).find(attachment => stocktakeSourceTypes[attachment.mimeType])?.name || '';
    const scope = guard.scopeOf(req, 'workflow.create');
    const nextStoreId = scope.level === 'store' ? u.storeId : null;
    const nextStore = (readAll('stores') || []).find(x => x.id === nextStoreId);
    const nextRegionId = scope.level === 'region' ? scope.regionId : (nextStore?.regionId || null);
    if (!guard.check(req, res, 'workflow.create', { storeId: nextStoreId, regionId: nextRegionId, country: 'PH', createdBy: u.id })) return;
    if (nextStore && item.type === 'store_remediation') valid.value.storeName = nextStore.name;
    if (item.type === 'store_remediation' && Object.prototype.hasOwnProperty.call(valid.value, 'assigneeId')) {
      if (valid.value.assigneeId) {
        if (!guard.checkPerm(req, res, 'task.assign') || !guard.check(req, res, 'task.assign', { storeId: nextStoreId, regionId: nextRegionId, country: 'PH', createdBy: u.id })) return;
        newAssignee = (readAll('users') || []).find(x => x.id === valid.value.assigneeId && !x.disabled);
        if (!newAssignee) return res.status(400).json({ error: '整改负责人账号不存在或已停用' });
        const assignment = rbac.canAssign(u, newAssignee, 'task');
        if (!assignment.ok) return res.status(403).json({ error: assignment.reason || '无权指派该整改负责人' });
        if (!rbac.hasPermission(newAssignee, 'workflow.view') || !rbac.hasPermission(newAssignee, 'workflow.execute')) return res.status(400).json({ error: '该账号没有整改流程查看或执行权限' });
      }
      assigneeChanged = item.assigneeId !== (newAssignee?.id || null);
      item.assigneeId = newAssignee?.id || null;
      item.assigneeName = newAssignee ? (newAssignee.name || newAssignee.username) : null;
    }
    delete valid.value.assigneeId;
    item.form = valid.value;
    if (item.type === 'store_remediation') item.overdueReminderAt = null;
    item.storeId = nextStoreId; item.warehouseId = null; item.regionId = nextRegionId;
    item.title = controlCenter.cleanText(req.body?.title || item.title, 180);
  }
  const previousStep = item.currentStep;
  const result = controlCenter.applyTransition(item, action, { ...(req.body || {}), actorId: u.id });
  if (!result.ok) return res.status(409).json({ error: result.error });
  if (action === 'approve') {
    item.stepApprovals = item.stepApprovals || [];
    const step = item.approvalSteps[item.currentStep];
    const approverKey = req.workflowApproverKey;
    item.stepApprovals.push({ step: item.currentStep, actorId: u.id, approverKey, createdAt: nowIso() });
    const satisfied = step.mode !== 'all' || step.approvers.every(a => item.stepApprovals.some(x => x.step === previousStep && x.approverKey === `${a.kind}:${a.id}`));
    if (!satisfied) item.status = 'pending_approval';
    else {
      item.currentStep += 1;
      item.status = item.currentStep >= item.approvalSteps.length ? 'approved' : 'pending_approval';
    }
  }
  if (action === 'approve' && item.type === 'store_remediation' && item.status === 'approved') item.executionRound = Math.max(1, Number(item.executionRound) || 1);
  if (action === 'review_return' && item.type === 'store_remediation') item.executionRound = Math.max(1, Number(item.executionRound) || 1) + 1;
  if (action === 'resubmit') {
    item.currentStep = 0; item.stepApprovals = []; item.approvalDelegations = [];
    item.approvalDueAt = nextApprovalDueAt(item.approvalSlaHours);
    item.approvalReminderAt = null;
  } else if (action === 'approve' && item.status === 'pending_approval' && item.currentStep !== previousStep) {
    item.approvalDueAt = nextApprovalDueAt(item.approvalSlaHours);
    item.approvalReminderAt = null;
  } else if (item.status !== 'pending_approval') {
    item.approvalDueAt = null;
    item.approvalReminderAt = null;
  }
  item.updatedAt = nowIso(); item.history = Array.isArray(item.history) ? item.history : [];
  item.history.push({ action, actorId: u.id, actorName: u.name || u.username, note: result.note || controlCenter.cleanText(req.body?.note, 1000), createdAt: item.updatedAt });
  if (assigneeChanged) item.history.push({ action: 'assignee.update', actorId: u.id, actorName: u.name || u.username, note: item.assigneeName || '负责人已取消', createdAt: item.updatedAt });
  let savedSource = null;
  try {
    if (pendingSource) savedSource = saveStocktakeSource(item, u, pendingSource);
    writeAll('workflowInstances', items);
  } catch (err) {
    if (savedSource) { try { fs.unlinkSync(path.join(workflowAttachmentDir, savedSource.storedName)); } catch (cleanupError) {} }
    return res.status(500).json({ error: '保存申请或表格失败，请重试' });
  }
  recordControlAudit(req, u, `workflow.${action}`, item.type, item.id, { status: item.status });
  if (savedSource) recordControlAudit(req, u, 'workflow.attachment.upload', item.type, item.id, { attachmentId: savedSource.id, size: savedSource.size });
  if (assigneeChanged) recordControlAudit(req, u, 'workflow.assignee.update', item.type, item.id, { assigneeId: item.assigneeId });
  notifyUser(item.createdBy, `workflow.${action}`, `流程状态更新：${item.title}`, `当前状态：${item.status}`, 'workflow', item.id);
  if (action === 'approve') notifyCurrentApprovers(item);
  if (action === 'resubmit') notifyCurrentApprovers(item);
  if (action === 'review_return' && item.assigneeId) notifyUser(item.assigneeId, 'store.remediation.returned', '门店整改复查退回', controlCenter.cleanText(req.body?.note, 1000), 'workflow', item.id);
  if (action === 'resubmit' && assigneeChanged && newAssignee) notifyUser(newAssignee.id, 'store.remediation.assigned', '收到门店整改任务', item.title, 'workflow', item.id);
  res.json({ item });
});

const workflowAttachmentDir = path.join(store.DATA_DIR, 'uploads', 'workflow');
const taskAttachmentDir = path.join(store.DATA_DIR, 'uploads', 'tasks');
const workflowAttachmentTypes = {
  'application/pdf': { ext: '.pdf', signature: b => b.subarray(0, 5).toString() === '%PDF-' },
  'image/png': { ext: '.png', signature: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
  'image/jpeg': { ext: '.jpg', signature: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'text/csv': { ext: '.csv', signature: b => { const value = b.toString('utf8'); return !!value && !value.includes('\0') && !value.includes('\ufffd'); } },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: '.xlsx', signature: b => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  'application/vnd.ms-excel': { ext: '.xls', signature: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])) },
  'application/vnd.ms-excel.sheet.macroenabled.12': { ext: '.xlsm', signature: b => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  'application/vnd.ms-excel.sheet.binary.macroenabled.12': { ext: '.xlsb', signature: b => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
};
const stocktakeSourceTypes = Object.fromEntries(['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/vnd.ms-excel.sheet.macroenabled.12', 'application/vnd.ms-excel.sheet.binary.macroenabled.12'].map(mime => [mime, workflowAttachmentTypes[mime]]));
function parseStocktakeSourceFile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '请选择 Excel 或 CSV 文件' };
  const name = path.basename(String(raw.fileName || '')).replace(/[\\/\r\n\0]/g, '_').slice(0, 180);
  const mimeType = String(raw.mimeType || '').toLowerCase();
  const type = stocktakeSourceTypes[mimeType];
  if (!name || !type || !name.toLowerCase().endsWith(type.ext)) return { error: '仅支持 Excel（XLSX、XLS、XLSM、XLSB）或 CSV 文件' };
  if (typeof raw.data !== 'string' || raw.data.length > 14_000_000) return { error: '盘点表格不能超过 10MB' };
  const match = raw.data.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1].toLowerCase() !== mimeType) return { error: '文件上传格式无效' };
  const buffer = Buffer.from(match[2], 'base64');
  const fileSignatureMatches = type.signature(buffer);
  if (!buffer.length || buffer.length > 10 * 1024 * 1024 || !fileSignatureMatches) return { error: '请选择有效的 Excel 或 CSV 文件（最大 10MB）' };
  return { value: { name, mimeType, ext: type.ext, buffer } };
}
function hasStocktakeSource(item) {
  return (item.attachments || []).some(attachment => stocktakeSourceTypes[attachment.mimeType] && attachment.name?.toLowerCase().endsWith(stocktakeSourceTypes[attachment.mimeType].ext));
}
function stocktakeSourceCapacity(item, source) {
  const attachments = item.attachments || [];
  return attachments.length < 10 && attachments.reduce((sum, attachment) => sum + Number(attachment.size || 0), 0) + source.buffer.length <= 20 * 1024 * 1024;
}
function saveStocktakeSource(item, user, source) {
  fs.mkdirSync(path.dirname(workflowAttachmentDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(workflowAttachmentDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(workflowAttachmentDir), 0o700);
  fs.chmodSync(workflowAttachmentDir, 0o700);
  const id = nanoid(), storedName = `${id}${source.ext}`;
  fs.writeFileSync(path.join(workflowAttachmentDir, storedName), source.buffer, { mode: 0o600, flag: 'wx' });
  const attachment = { id, name: source.name, mimeType: source.mimeType, evidenceType: 'supporting', executionRound: null, size: source.buffer.length, storedName, uploadedBy: user.id, uploadedByName: user.name || user.username, createdAt: nowIso() };
  item.attachments.push(attachment);
  return attachment;
}
app.post('/api/v2/workflows/:id/attachments', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const items = readAll('workflowInstances') || [], item = items.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '申请不存在' });
  if (!controlCenter.WORKFLOW_TYPES[item.type]) return res.status(409).json({ error: '该流程已停用，仅保留历史记录' });
  const isOwner = item.createdBy === u.id, isAssignee = item.assigneeId === u.id;
  if (isOwner) { if (!guard.check(req, res, 'workflow.create', item)) return; }
  else if (isAssignee) { if (!canExecuteRemediation(req, res, item)) return; }
  else if (!guard.check(req, res, 'workflow.approve', item)) return;
  if (['rejected','cancelled','completed'].includes(item.status)) return res.status(409).json({ error: '已结束的流程不能添加附件' });
  if (isAssignee && !['approved','execution_pending','awaiting_review'].includes(item.status)) return res.status(409).json({ error: '整改当前阶段不能上传执行凭证' });
  if (!isOwner && !isAssignee) {
    if (item.status !== 'pending_approval') return res.status(409).json({ error: '当前流程不接受审批附件' });
    if (!approvalSlotForActor(item, u)) return res.status(403).json({ error: '当前审批步骤未授权此账号' });
  }
  const evidenceType = item.type === 'store_remediation' && ['before','after','supporting'].includes(req.body?.evidenceType) ? req.body.evidenceType : 'supporting';
  if (item.type === 'store_remediation' && ['before','after'].includes(evidenceType)) {
    if (!isAssignee || !['approved','execution_pending','awaiting_review'].includes(item.status)) return res.status(403).json({ error: '只有当前整改负责人可以上传本轮证据' });
    if (!canExecuteRemediation(req, res, item)) return;
  }
  const { fileName, mimeType, data } = req.body || {}, type = workflowAttachmentTypes[String(mimeType || '').toLowerCase()];
  const maxBytes = item.type === 'stocktake' && stocktakeSourceTypes[String(mimeType || '').toLowerCase()] ? 10 * 1024 * 1024 : 4 * 1024 * 1024;
  if (!type || typeof data !== 'string' || data.length > Math.ceil(maxBytes * 4 / 3) + 100) return res.status(400).json({ error: '不支持的附件格式或文件过大' });
  const match = data.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1].toLowerCase() !== mimeType.toLowerCase()) return res.status(400).json({ error: '附件格式无效' });
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > maxBytes || !type.signature(buffer)) return res.status(400).json({ error: '文件类型不匹配或超过大小限制' });
  item.attachments = Array.isArray(item.attachments) ? item.attachments : [];
  if (item.attachments.length >= 10 || item.attachments.reduce((sum, x) => sum + Number(x.size || 0), 0) + buffer.length > 20 * 1024 * 1024) return res.status(409).json({ error: '每个流程最多 10 个附件，合计不超过 20MB' });
  fs.mkdirSync(path.dirname(workflowAttachmentDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(workflowAttachmentDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(workflowAttachmentDir), 0o700);
  fs.chmodSync(workflowAttachmentDir, 0o700);
  const id = nanoid(), storedName = `${id}${type.ext}`;
  fs.writeFileSync(path.join(workflowAttachmentDir, storedName), buffer, { mode: 0o600, flag: 'wx' });
  const safeName = path.basename(String(fileName || 'attachment')).replace(/[\\/\r\n\0]/g, '_').slice(0, 180) || `attachment${type.ext}`;
  const executionRound = item.type === 'store_remediation' && ['before','after'].includes(evidenceType) ? Math.max(1, Number(item.executionRound) || 1) : null;
  const attachment = { id, name: safeName, mimeType: mimeType.toLowerCase(), evidenceType, executionRound, size: buffer.length, storedName, uploadedBy: u.id, uploadedByName: u.name || u.username, createdAt: nowIso() };
  item.attachments.push(attachment); item.updatedAt = attachment.createdAt; writeAll('workflowInstances', items);
  recordControlAudit(req, u, 'workflow.attachment.upload', item.type, item.id, { attachmentId: id, evidenceType, size: buffer.length });
  const recipient = u.id === item.createdBy ? item.assigneeId : item.createdBy;
  if (recipient && recipient !== u.id) notifyUser(recipient, 'workflow.attachment', '流程已上传凭证', item.title, 'workflow', item.id);
  return res.status(201).json({ attachment: { ...attachment, storedName: undefined } });
});
app.get('/api/v2/workflows/:id/attachments/:attachmentId/download', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const item = (readAll('workflowInstances') || []).find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '申请不存在' });
  if (!guard.checkPerm(req, res, 'workflow.view')) return;
  if (!controlVisible(req, 'workflow.view', item)) return res.status(403).json({ error: '无权限查看此流程附件' });
  const attachment = (item.attachments || []).find(x => x.id === req.params.attachmentId);
  if (!attachment || !/^[A-Za-z0-9_-]+\.(pdf|png|jpg|csv|xlsx|xls|xlsm|xlsb)$/.test(attachment.storedName || '')) return res.status(404).json({ error: '附件不存在' });
  const filePath = path.join(workflowAttachmentDir, attachment.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '附件文件不存在' });
  const asciiName = attachment.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.set({ 'Content-Type': workflowAttachmentTypes[attachment.mimeType]?.ext ? attachment.mimeType : 'application/octet-stream', 'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  res.sendFile(filePath);
});

app.post('/api/v2/tasks/:id/comments', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const items = readAll('tasks') || [], item = items.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '任务不存在' });
  if (!canCollaborateOnTask(req, res, item)) return;
  if (!['open','in_progress'].includes(item.status)) return res.status(409).json({ error: '已结束的任务不能添加备注' });
  const text = controlCenter.cleanText(req.body?.comment, 2000);
  if (!text) return res.status(400).json({ error: '备注内容不能为空' });
  item.comments = Array.isArray(item.comments) ? item.comments : [];
  if (item.comments.length >= 500) return res.status(409).json({ error: '任务备注数量已达上限' });
  const comment = { id: nanoid(), actorId: u.id, actorName: u.name || u.username, comment: text, createdAt: nowIso() };
  item.comments.push(comment); item.updatedAt = comment.createdAt; writeAll('tasks', items);
  recordControlAudit(req, u, 'task.comment', 'task', item.id, { commentId: comment.id });
  const recipient = u.id === item.createdBy ? item.assigneeId : item.createdBy;
  if (recipient && recipient !== u.id) notifyUser(recipient, 'task.comment', '任务收到新备注', item.title, 'task', item.id);
  res.status(201).json({ comment });
});
app.post('/api/v2/tasks/:id/attachments', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const items = readAll('tasks') || [], item = items.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '任务不存在' });
  if (!canCollaborateOnTask(req, res, item)) return;
  if (!['open','in_progress'].includes(item.status)) return res.status(409).json({ error: '已结束的任务不能上传凭证' });
  const { fileName, mimeType, data } = req.body || {}, type = workflowAttachmentTypes[String(mimeType || '').toLowerCase()];
  if (!type || typeof data !== 'string' || data.length > 5_600_000) return res.status(400).json({ error: '仅支持 4MB 以内的 PDF、PNG、JPG、CSV 或 XLSX 文件' });
  const match = data.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1].toLowerCase() !== String(mimeType).toLowerCase()) return res.status(400).json({ error: '附件格式无效' });
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 4 * 1024 * 1024 || !type.signature(buffer)) return res.status(400).json({ error: '文件内容与格式不匹配或超过 4MB' });
  item.attachments = Array.isArray(item.attachments) ? item.attachments : [];
  if (item.attachments.length >= 10 || item.attachments.reduce((sum, x) => sum + Number(x.size || 0), 0) + buffer.length > 20 * 1024 * 1024) return res.status(409).json({ error: '每个任务最多 10 个凭证，合计不超过 20MB' });
  fs.mkdirSync(taskAttachmentDir, { recursive: true, mode: 0o700 }); fs.chmodSync(taskAttachmentDir, 0o700);
  const id = nanoid(), storedName = `${id}${type.ext}`;
  fs.writeFileSync(path.join(taskAttachmentDir, storedName), buffer, { mode: 0o600, flag: 'wx' });
  const safeName = path.basename(String(fileName || 'attachment')).replace(/[\\/\r\n\0]/g, '_').slice(0, 180) || `attachment${type.ext}`;
  const attachment = { id, name: safeName, mimeType: String(mimeType).toLowerCase(), size: buffer.length, storedName, uploadedBy: u.id, uploadedByName: u.name || u.username, createdAt: nowIso() };
  item.attachments.push(attachment); item.updatedAt = attachment.createdAt; writeAll('tasks', items);
  recordControlAudit(req, u, 'task.attachment.upload', 'task', item.id, { attachmentId: id, size: buffer.length });
  const recipient = u.id === item.createdBy ? item.assigneeId : item.createdBy;
  if (recipient && recipient !== u.id) notifyUser(recipient, 'task.attachment', '任务已上传完成凭证', item.title, 'task', item.id);
  res.status(201).json({ attachment: { ...attachment, storedName: undefined } });
});
app.get('/api/v2/tasks/:id/attachments/:attachmentId/download', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'task.view')) return;
  const item = (readAll('tasks') || []).find(x => x.id === req.params.id);
  if (!item || !controlVisible(req, 'task.view', item)) return res.status(404).json({ error: '任务不存在' });
  const attachment = (item.attachments || []).find(x => x.id === req.params.attachmentId);
  if (!attachment || !/^[A-Za-z0-9_-]+\.(pdf|png|jpg|csv|xlsx|xls|xlsm|xlsb)$/.test(attachment.storedName || '')) return res.status(404).json({ error: '凭证不存在' });
  const filePath = path.join(taskAttachmentDir, attachment.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '凭证文件不存在' });
  const asciiName = attachment.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.set({ 'Content-Type': workflowAttachmentTypes[attachment.mimeType]?.ext ? attachment.mimeType : 'application/octet-stream', 'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  res.sendFile(filePath);
});

app.get('/api/v2/tasks', (req, res) => {
  if (!guard.checkPerm(req, res, 'task.view')) return;
  const status = String(req.query.status || ''), priority = String(req.query.priority || ''), storeId = String(req.query.storeId || ''), query = controlCenter.cleanText(req.query.q, 160).toLocaleLowerCase();
  const visible = (readAll('tasks') || []).filter(x => controlVisible(req, 'task.view', x)), counts = {};
  visible.forEach(x => { counts[x.status] = (counts[x.status] || 0) + 1; });
  let items = visible;
  if (status) items = items.filter(x => x.status === status);
  if (priority) items = items.filter(x => x.priority === priority);
  if (storeId === 'none') items = items.filter(x => !x.storeId);
  else if (storeId) items = items.filter(x => (x.storeId || '') === storeId);
  if (query) items = items.filter(x => [x.title, x.description, x.assigneeName, x.createdByName].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
  items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const total = items.length, limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 25));
  const rawOffset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const offset = total ? Math.min(rawOffset, Math.floor((total - 1) / limit) * limit) : 0;
  res.json({ items: items.slice(offset, offset + limit), total, offset, limit, counts });
});
app.get('/api/v2/store-operations', (req, res) => {
  if (!guard.checkPerm(req, res, 'store.view')) return;
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 10));
  const page = (collection, offsetKey, dateKey) => {
    let items = (readAll(collection) || []).filter(x => controlVisible(req, 'store.view', x));
    items.sort((a, b) => String(b[dateKey] || b.createdAt || '').localeCompare(String(a[dateKey] || a.createdAt || '')));
    const total = items.length, rawOffset = Math.max(0, parseInt(req.query[offsetKey], 10) || 0);
    const offset = total ? Math.min(rawOffset, Math.floor((total - 1) / limit) * limit) : 0;
    return { items: items.slice(offset, offset + limit), total, offset, limit };
  };
  const reports = page('storeReports', 'reportsOffset', 'reportDate');
  const inspections = page('storeInspections', 'inspectionsOffset', 'inspectionDate');
  const issues = page('storeIssues', 'issuesOffset', 'createdAt');
  const pageMeta = result => ({ total: result.total, offset: result.offset, limit: result.limit });
  res.json({ reports: reports.items, inspections: inspections.items, issues: issues.items, pages: { reports: pageMeta(reports), inspections: pageMeta(inspections), issues: pageMeta(issues) } });
});
const storeOperationCollections = {
  report: { collection: 'storeReports', resourceType: 'storeReport' },
  inspection: { collection: 'storeInspections', resourceType: 'storeInspection' },
};
const storeOperationAttachmentDir = path.join(store.DATA_DIR, 'uploads', 'store-operations');
app.post('/api/v2/store-operations/:kind/:id/attachments', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const spec = storeOperationCollections[req.params.kind]; if (!spec) return res.status(404).json({ error: '门店记录不存在' });
  if (!guard.checkPerm(req, res, 'task.create')) return;
  const items = readAll(spec.collection) || [], item = items.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '门店记录不存在' });
  if (!guard.check(req, res, 'task.create', item)) return;
  const { fileName, mimeType, data } = req.body || {};
  const type = workflowAttachmentTypes[String(mimeType || '').toLowerCase()];
  if (!type || !['application/pdf','image/png','image/jpeg'].includes(String(mimeType).toLowerCase()) || typeof data !== 'string' || data.length > 5_600_000) return res.status(400).json({ error: '凭证仅支持 4MB 以内的 PDF、PNG 或 JPG 文件' });
  const match = data.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1].toLowerCase() !== String(mimeType).toLowerCase()) return res.status(400).json({ error: '附件格式无效' });
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 4 * 1024 * 1024 || !type.signature(buffer)) return res.status(400).json({ error: '文件内容与格式不匹配或超过 4MB' });
  item.attachments = Array.isArray(item.attachments) ? item.attachments : [];
  if (item.attachments.length >= 10 || item.attachments.reduce((sum, x) => sum + Number(x.size || 0), 0) + buffer.length > 20 * 1024 * 1024) return res.status(409).json({ error: '每条记录最多 10 个凭证，合计不超过 20MB' });
  fs.mkdirSync(storeOperationAttachmentDir, { recursive: true, mode: 0o700 }); fs.chmodSync(storeOperationAttachmentDir, 0o700);
  const id = nanoid(), storedName = `${id}${type.ext}`;
  fs.writeFileSync(path.join(storeOperationAttachmentDir, storedName), buffer, { mode: 0o600, flag: 'wx' });
  const safeName = path.basename(String(fileName || 'attachment')).replace(/[\\/\r\n\0]/g, '_').slice(0, 180) || `attachment${type.ext}`;
  const attachment = { id, name: safeName, mimeType: String(mimeType).toLowerCase(), size: buffer.length, storedName, uploadedBy: u.id, uploadedByName: u.name || u.username, createdAt: nowIso() };
  item.attachments.push(attachment); item.updatedAt = attachment.createdAt; writeAll(spec.collection, items);
  recordControlAudit(req, u, `${spec.resourceType}.attachment.upload`, spec.resourceType, item.id, { attachmentId: id, size: buffer.length });
  res.status(201).json({ attachment: { ...attachment, storedName: undefined } });
});
app.get('/api/v2/store-operations/:kind/:id/attachments/:attachmentId/download', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const spec = storeOperationCollections[req.params.kind]; if (!spec) return res.status(404).json({ error: '门店记录不存在' });
  if (!guard.checkPerm(req, res, 'store.view')) return;
  const item = (readAll(spec.collection) || []).find(x => x.id === req.params.id);
  if (!item || !controlVisible(req, 'store.view', item)) return res.status(404).json({ error: '门店记录不存在' });
  const attachment = (item.attachments || []).find(x => x.id === req.params.attachmentId);
  if (!attachment || !/^[A-Za-z0-9_-]+\.(pdf|png|jpg)$/.test(attachment.storedName || '')) return res.status(404).json({ error: '附件不存在' });
  const filePath = path.join(storeOperationAttachmentDir, attachment.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '附件文件不存在' });
  const asciiName = attachment.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.set({ 'Content-Type': workflowAttachmentTypes[attachment.mimeType]?.ext ? attachment.mimeType : 'application/octet-stream', 'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  res.sendFile(filePath);
});
app.post('/api/v2/store-reports', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'task.create')) return;
  const b = req.body || {}, scope = guard.scopeOf(req, 'task.create'), storeId = scope.level === 'store' ? u.storeId : b.storeId;
  const store = (readAll('stores') || []).find(x => x.id === storeId); if (!store) return res.status(400).json({ error: '请选择有效门店' });
  if (!guard.check(req, res, 'task.create', { storeId, regionId: store.regionId, country: 'PH' })) return;
  const reportDate = controlCenter.cleanText(b.reportDate, 10);
  if (!isIsoCalendarDate(reportDate)) return res.status(400).json({ error: '工作汇报日期无效' });
  const item = { id: nanoid(), storeId, regionId: store.regionId || null, reportDate, additionalNote: controlCenter.cleanText(b.additionalNote ?? b.salesNote, 2000), incidents: controlCenter.cleanText(b.incidents, 2000), summary: controlCenter.cleanText(b.summary, 4000), createdBy: u.id, createdByName: u.name || u.username, createdAt: nowIso(), updatedAt: nowIso(), attachments: [] };
  if (!item.summary && !item.additionalNote && !item.incidents) return res.status(400).json({ error: '请填写工作内容或异常说明' });
  const items = readAll('storeReports') || []; items.unshift(item); writeAll('storeReports', items); recordControlAudit(req, u, 'storeReport.create', 'storeReport', item.id); res.status(201).json({ item });
});
app.post('/api/v2/store-inspections', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'task.create')) return;
  const b = req.body || {}, scope = guard.scopeOf(req, 'task.create'), storeId = scope.level === 'store' ? u.storeId : b.storeId;
  const store = (readAll('stores') || []).find(x => x.id === storeId); if (!store) return res.status(400).json({ error: '请选择有效门店' });
  if (!guard.check(req, res, 'task.create', { storeId, regionId: store.regionId, country: 'PH' })) return;
  const inspectionDate = controlCenter.cleanText(b.inspectionDate, 10), result = ['pass','attention','fail'].includes(b.result) ? b.result : '';
  if (!isIsoCalendarDate(inspectionDate) || !result) return res.status(400).json({ error: '请填写有效日期和巡检结果' });
  const score = b.score === '' || b.score == null ? null : Number(b.score);
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) return res.status(400).json({ error: '巡检评分须为 0 至 100' });
  const item = { id: nanoid(), storeId, regionId: store.regionId || null, inspectionDate, result, score, checklist: controlCenter.cleanText(b.checklist, 4000), findings: controlCenter.cleanText(b.findings, 4000), createdBy: u.id, createdByName: u.name || u.username, createdAt: nowIso(), attachments: [] };
  const items = readAll('storeInspections') || []; items.unshift(item); writeAll('storeInspections', items); recordControlAudit(req, u, 'storeInspection.create', 'storeInspection', item.id); res.status(201).json({ item });
});
app.post('/api/v2/store-issues', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'alert.create')) return;
  return res.status(410).json({ error: '独立问题登记已停用。请在集团中控的审批中心提交“门店整改”流程，以便统一审批、分派、留证和复查。' });
});
app.post('/api/v2/store-issues/:id/close', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const items = readAll('storeIssues') || [], item = items.find(x => x.id === req.params.id); if (!item) return res.status(404).json({ error: '门店问题不存在' });
  if (!guard.check(req, res, 'alert.close', item)) return;
  return res.status(410).json({ error: '独立问题关闭已停用。请在门店整改流程中上传本轮凭证并完成复查。历史问题记录仅供查看。' });
});
app.get('/api/v2/task-assignees', (req, res) => {
  if (!guard.checkPerm(req, res, 'task.assign')) return;
  const actor = getSessionUser(req);
  const users = (readAll('users') || []).filter(x => !x.disabled && rbac.canAssign(actor, x, 'task').ok).filter(x => controlVisible(req, 'task.assign', { storeId: x.storeId, country: 'PH', createdBy: x.id }));
  res.json({ items: users.map(x => ({ id: x.id, name: x.name || x.username, username: x.username, storeId: x.storeId || null })) });
});
app.get('/api/v2/alert-assignees', (req, res) => {
  if (!guard.checkPerm(req, res, 'alert.assign')) return;
  const users = (readAll('users') || []).filter(x => !x.disabled).filter(x => controlVisible(req, 'alert.assign', { storeId: x.storeId, regionId: x.regionId, country: 'PH', createdBy: x.id }));
  res.json({ items: users.map(x => ({ id: x.id, name: x.name || x.username, username: x.username, storeId: x.storeId || null, regionId: x.regionId || null })) });
});
app.post('/api/v2/tasks', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'task.create')) return;
  const b = req.body || {}, title = controlCenter.cleanText(b.title, 180);
  if (!title) return res.status(400).json({ error: '任务名称不能为空' });
  if (b.warehouseId) return res.status(400).json({ error: '当前版本不再将任务关联到仓库档案' });
  const scope = guard.scopeOf(req, 'task.create'), storeId = scope.level === 'store' ? u.storeId : (b.storeId || null);
  const knownStores = readAll('stores') || [];
  const linkedStore = knownStores.find(x => x.id === storeId);
  if (storeId && !linkedStore) return res.status(400).json({ error: '门店不存在' });
  const taskResource = { storeId, warehouseId: null, regionId: linkedStore?.regionId || null, country: 'PH', createdBy: u.id };
  if (!guard.check(req, res, 'task.create', taskResource)) return;
  let assignee = null;
  if (b.assigneeId) {
    if (!guard.check(req, res, 'task.assign', { storeId, country: 'PH', createdBy: u.id })) return;
    assignee = (readAll('users') || []).find(x => x.id === b.assigneeId && !x.disabled);
    if (!assignee) return res.status(400).json({ error: '负责人账号不存在或已停用' });
    const assignment = rbac.canAssign(u, assignee, 'task');
    if (!assignment.ok) return res.status(403).json({ error: assignment.reason || '无权指派给该账号' });
  }
  const dueAt = parseControlDueDate(b.dueAt);
  if (dueAt && !Number.isFinite(dueAt.getTime())) return res.status(400).json({ error: '截止日期无效' });
  const checklist = normalizeTaskChecklist(b.checklist);
  if (!checklist.ok) return res.status(400).json({ error: checklist.error });
  const item = { id: nanoid(), title, description: controlCenter.cleanText(b.description, 2000), status: 'open', priority: ['low','normal','high','urgent'].includes(b.priority) ? b.priority : 'normal', assigneeId: assignee?.id || null, assigneeName: assignee?.name || assignee?.username || null, storeId, warehouseId: null, regionId: linkedStore?.regionId || null, dueAt: dueAt ? dueAt.toISOString() : null, createdBy: u.id, createdByName: u.name || u.username, createdAt: nowIso(), updatedAt: nowIso(), completedAt: null, overdueReminderAt: null, checklist: checklist.value, comments: [], attachments: [] };
  const items = readAll('tasks') || []; items.unshift(item); writeAll('tasks', items);
  if (item.assigneeId) notifyUser(item.assigneeId, 'task.assigned', '收到新任务', item.title, 'task', item.id);
  recordControlAudit(req, u, 'task.create', 'task', item.id, { title }); res.status(201).json({ item });
});
app.post('/api/v2/tasks/:id/complete', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const items = readAll('tasks') || [], item = items.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '任务不存在' });
  if (!canActOnTask(req, res, 'task.close', item)) return;
  if (!['open','in_progress'].includes(item.status)) return res.status(409).json({ error: '该任务已处理' });
  const checklist = Array.isArray(item.checklist) ? item.checklist : [];
  const remaining = checklist.filter(entry => !entry.completed).length;
  if (remaining) return res.status(409).json({ error: `还有 ${remaining} 项检查内容未完成` });
  item.status = 'completed'; item.completedAt = nowIso(); item.updatedAt = item.completedAt;
  writeAll('tasks', items); recordControlAudit(req, u, 'task.complete', 'task', item.id); res.json({ item });
});
app.post('/api/v2/tasks/:id/checklist/:itemId', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const items = readAll('tasks') || [], item = items.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '任务不存在' });
  if (!canActOnTask(req, res, 'task.close', item)) return;
  if (!['open','in_progress'].includes(item.status)) return res.status(409).json({ error: '已处理的任务不能修改清单' });
  if (typeof req.body?.completed !== 'boolean') return res.status(400).json({ error: '清单状态无效' });
  const checklist = Array.isArray(item.checklist) ? item.checklist : [];
  const entry = checklist.find(x => x.id === req.params.itemId);
  if (!entry) return res.status(404).json({ error: '清单项目不存在' });
  entry.completed = req.body.completed;
  entry.completedAt = entry.completed ? nowIso() : null;
  entry.completedBy = entry.completed ? u.id : null;
  entry.completedByName = entry.completed ? (u.name || u.username) : null;
  if (entry.completed && item.status === 'open') item.status = 'in_progress';
  item.updatedAt = nowIso();
  writeAll('tasks', items);
  recordControlAudit(req, u, entry.completed ? 'task.checklist.complete' : 'task.checklist.reopen', 'task', item.id, { itemId: entry.id, title: entry.title });
  res.json({ item });
});
app.put('/api/v2/tasks/:id', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const items = readAll('tasks') || [], item = items.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '任务不存在' });
  if (!guard.check(req, res, 'task.edit', item)) return;
  const b = req.body || {};
  if (b.warehouseId !== undefined) return res.status(400).json({ error: '当前版本不再将任务关联到仓库档案' });
  if (b.title !== undefined) {
    const title = controlCenter.cleanText(b.title, 180);
    if (!title) return res.status(400).json({ error: '任务名称不能为空' });
    item.title = title;
  }
  if (b.description !== undefined) item.description = controlCenter.cleanText(b.description, 2000);
  if (b.priority !== undefined) {
    if (!['low','normal','high','urgent'].includes(b.priority)) return res.status(400).json({ error: '优先级无效' });
    item.priority = b.priority;
  }
  if (b.dueAt !== undefined) {
    const date = parseControlDueDate(b.dueAt);
    if (date && !Number.isFinite(date.getTime())) return res.status(400).json({ error: '截止时间无效' });
    const nextDueAt = date ? date.toISOString() : null;
    if (nextDueAt !== item.dueAt) item.overdueReminderAt = null;
    item.dueAt = nextDueAt;
  }
  if (b.status !== undefined) {
    if (!['open','in_progress','completed','cancelled'].includes(b.status)) return res.status(400).json({ error: '任务状态无效' });
    if (b.status === 'completed') return res.status(400).json({ error: '请使用完成操作记录任务完成' });
    if (item.status !== b.status) item.overdueReminderAt = null;
    item.status = b.status;
  }
  if (b.assigneeId !== undefined) {
    if (!guard.check(req, res, 'task.assign', item)) return;
    const assignee = b.assigneeId ? (readAll('users') || []).find(x => x.id === b.assigneeId && !x.disabled) : null;
    if (b.assigneeId && !assignee) return res.status(400).json({ error: '负责人账号不存在或已停用' });
    if (assignee) {
      const assignment = rbac.canAssign(u, assignee, 'task');
      if (!assignment.ok) return res.status(403).json({ error: assignment.reason || '无权指派给该账号' });
    }
    if (item.assigneeId !== (assignee?.id || null)) item.overdueReminderAt = null;
    item.assigneeId = assignee?.id || null; item.assigneeName = assignee ? (assignee.name || assignee.username) : null;
    if (assignee) notifyUser(assignee.id, 'task.assigned', '任务已指派给你', item.title, 'task', item.id);
  }
  item.updatedAt = nowIso(); writeAll('tasks', items); recordControlAudit(req, u, 'task.update', 'task', item.id);
  res.json({ item });
});
app.get('/api/v2/announcements', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const canManage = rbac.hasPermission(u, 'announcement.manage');
  const items = (readAll('announcements') || [])
    .filter(x => x.status === 'published' || (canManage && req.query.includeDrafts === '1' && x.status === 'draft'))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.json({ items, canManage });
});
app.post('/api/v2/announcements', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'announcement.manage')) return;
  const title = controlCenter.cleanText(req.body?.title, 180);
  const body = controlCenter.cleanText(req.body?.body, 5000);
  const status = req.body?.status === 'draft' ? 'draft' : 'published';
  if (!title || !body) return res.status(400).json({ error: '请填写公告标题和内容' });
  const item = { id: nanoid(), title, body, status, pinned: !!req.body?.pinned,
    createdBy: u.id, createdByName: u.name || u.username, createdAt: nowIso(), updatedAt: nowIso() };
  const items = readAll('announcements') || []; items.unshift(item); writeAll('announcements', items);
  recordControlAudit(req, u, 'announcement.create', 'announcement', item.id, { status, pinned: item.pinned });
  res.status(201).json({ item });
});
app.put('/api/v2/announcements/:id', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'announcement.manage')) return;
  const items = readAll('announcements') || [], item = items.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '公告不存在' });
  const title = controlCenter.cleanText(req.body?.title, 180);
  const body = controlCenter.cleanText(req.body?.body, 5000);
  if (!title || !body || !['draft', 'published', 'archived'].includes(req.body?.status)) return res.status(400).json({ error: '公告内容或状态无效' });
  Object.assign(item, { title, body, status: req.body.status, pinned: !!req.body.pinned, updatedAt: nowIso() });
  writeAll('announcements', items);
  recordControlAudit(req, u, 'announcement.update', 'announcement', item.id, { status: item.status, pinned: item.pinned });
  res.json({ item });
});
app.get('/api/v2/notifications', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const all = (readAll('notifications') || []).filter(x => x.userId === u.id);
  const unread = all.filter(x => !x.readAt).length, total = all.length;
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 25));
  const rawOffset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const offset = total ? Math.min(rawOffset, Math.floor((total - 1) / limit) * limit) : 0;
  res.json({ items: all.slice(offset, offset + limit), total, offset, limit, unread });
});
app.post('/api/v2/notifications/:id/read', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const items = readAll('notifications') || [], item = items.find(x => x.id === req.params.id && x.userId === u.id);
  if (!item) return res.status(404).json({ error: '通知不存在' });
  if (!item.readAt) item.readAt = nowIso(); writeAll('notifications', items); res.json({ item });
});
app.get('/api/v2/audit-events', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'system.audit.view')) return;
  const query = controlCenter.cleanText(req.query.q, 160).toLocaleLowerCase();
  const from = controlCenter.cleanText(req.query.from, 10), to = controlCenter.cleanText(req.query.to, 10);
  if ((from && !isIsoCalendarDate(from)) || (to && !isIsoCalendarDate(to)) || (from && to && from > to)) return res.status(400).json({ error: '审计日期范围无效' });
  const fromTime = from ? Date.parse(`${from}T00:00:00.000Z`) : null;
  const toTime = to ? Date.parse(`${to}T23:59:59.999Z`) : null;
  let items = (readAll('auditEvents') || []).slice();
  if (query) items = items.filter(x => [x.actorName, x.actorId, x.action, x.resourceType, x.resourceId].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
  if (fromTime !== null) items = items.filter(x => Date.parse(x.createdAt) >= fromTime);
  if (toTime !== null) items = items.filter(x => Date.parse(x.createdAt) <= toTime);
  items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const total = items.length, limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 25));
  const rawOffset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const offset = total ? Math.min(rawOffset, Math.floor((total - 1) / limit) * limit) : 0;
  res.json({ items: items.slice(offset, offset + limit), total, offset, limit });
});

// ============ 会员积分自助查询（公开页面，无需登录） ============
// 门店台卡二维码指向 /check。安全设计见 lib/lookup.js 顶部注释：
// 手机号 + 姓名两个都要对才返回，且返回体一律脱敏。

const LOOKUP_WINDOW_MS = 10 * 60 * 1000;
const LOOKUP_MAX_PER_WINDOW = 40;
const lookupHits = new Map();

/** 滑动窗口限流。门店顾客走各自的移动网络（多为运营商 CGNAT，会多人共用一个出口 IP），
 *  所以窗口设得比登录宽松，只用来挡住脚本级的批量枚举。 */
function lookupRateLimited(ip) {
  const now = Date.now();
  const arr = (lookupHits.get(ip) || []).filter(t => now - t < LOOKUP_WINDOW_MS);
  if (arr.length >= LOOKUP_MAX_PER_WINDOW) { lookupHits.set(ip, arr); return true; }
  arr.push(now);
  lookupHits.set(ip, arr);
  if (lookupHits.size > 1000) {
    for (const [k, v] of lookupHits) {
      if (!v.some(t => now - t < LOOKUP_WINDOW_MS)) lookupHits.delete(k);
    }
  }
  return false;
}

app.get('/check', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'check.html'));
});

app.post('/api/public/points-lookup', (req, res) => {
  const ip = clientIp(req);
  if (lookupRateLimited(ip)) {
    auditLog(`points lookup rate-limited from ${ip}`);
    return res.status(429).json({ error: '查询过于频繁，请稍后再试' });
  }

  const b = req.body || {};
  const phone = lookup.normalizePhone(b.phone);
  if (phone.length < 7) return res.status(400).json({ error: '请输入正确的手机号' });

  const candidates = lookup.findCandidates(readAll('members') || [], phone);
  const member = lookup.pickMember(candidates, b.name);
  if (!member) {
    // 账号不存在与姓名不匹配返回**同一个**提示，避免被用来判断某个号码是否已登记
    auditLog(`points lookup failed from ${ip} (phone ${phone.slice(0, 4)}***)`);
    return res.status(404).json({ error: '手机号或姓名不匹配' });
  }

  const payload = lookup.buildLookup({
    member,
    stores: readAll('stores') || [],
    rules: readAll('rules') || {},
    transactions: readAll('transactions') || [],
    now: Date.now(),
  });
  res.json(payload);
});

// ============ 兜底 ============
// /api 下的未知路径返回 JSON，而不是 Express 默认的 HTML 错误页
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  next();
});

// 全局错误处理：任何未捕获异常都返回 JSON（前端 api() 只认 JSON，拿到 HTML 会解析失败）
app.use((err, req, res, next) => {
  const status = Number(err && err.status) || 500;
  if (status >= 500) console.error('[error]', req.method, req.path, (err && err.stack) || err);
  try {
    auditLog(`ERROR ${req.method} ${req.path} -> ${status}: ${(err && err.message) || err}`);
  } catch (e) {}
  if (res.headersSent) return;
  const msg = (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large'))
    ? '请求内容格式不正确或过大'
    : status >= 500 ? '服务器内部错误，请稍后重试或联系管理员' : ((err && err.message) || '请求有误');
  res.status(status).json({ error: msg });
});

app.listen(PORT, () => {
  console.log(`NSS Solar control platform running on http://localhost:${PORT}`);
  if (process.env.SP_ADMIN_PASSWORD) console.log('New administrator bootstrap is using SP_ADMIN_PASSWORD; first login will require a password change.');
  else console.log(`For a new data directory, read ${path.join(store.DATA_DIR, 'INITIAL_ADMIN_CREDENTIALS.txt')} and remove it after completing the forced password change.`);
  // 启动任务与门店整改逾期提醒（每 15 分钟）
  controlReminders.start();
});
