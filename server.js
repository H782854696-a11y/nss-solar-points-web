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

const { ensureSeeded, readAll, writeAll, countryOf, countryIndexes } = require('./lib/seed');
const store = require('./lib/store');
const { readCollection, writeCollection } = store;
const rbac = require('./lib/rbac');
const guard = require('./lib/rbac-guard');
const controlReminders = require('./lib/control-reminders');
const controlCenter = require('./lib/control-center');
// 2026-10-08 审计 M-2：积分系统死代码已随退役路由一并移除 ——
// sheets-sync / points / ledger / approvals / mall / points-expiry / reports / lookup
// 八个模块不再被 require（原引用全部位于已删除的退役路由内）。

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
// 会话过期定时清扫（2026-10-08 审计 M-1）：惰性过期只在被访问时清理，
// 长期运行会有缓慢内存增长。这里每 10 分钟全量清除已过期 sid。
// unref 保证不阻止进程退出（测试/单次脚本场景）。
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (s.expiresAt < now) sessions.delete(sid);
}, 10 * 60 * 1000).unref();
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
  if (requiresForcedPasswordChange(user) && !['/api/auth/me', '/api/auth/change-password'].includes(req.path)) return null;
  const { password, ...safe } = user;
  return { ...safe, mustChangePassword: requiresForcedPasswordChange(user) };
}

function isStoreManagerRole(role) { return rbac.normalizeRole(role) === 'store_manager'; }
function requiresForcedPasswordChange(user) { return !!user?.mustChangePassword && !isStoreManagerRole(user.role); }

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

// ── 安全响应头（2026-10-08 审计 M-3）──
// 点击劫持、MIME 嗅探、XSS 的纵深防御。附件下载处已单独加 nosniff，这里统一兜底。
// CSP 说明：前端是原生 SPA + 内联 <style>/事件绑定，故 style-src 需 'unsafe-inline'；
//          img 允许 data:（头像/凭证预览）；脚本仅自托管（app.js/i18n.js），无 CDN。
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});

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
  res.json({ ok: true, user: { ...safe, mustChangePassword: requiresForcedPasswordChange(user) }, mustChangePassword: requiresForcedPasswordChange(user) });
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
    manager.mustChangePassword = false;
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
      mustChangePassword: false,
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
  target.mustChangePassword = !isStoreManagerRole(target.role);
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

// ============ 数据主库（只读查看 / 导出） ============
// 让管理员在浏览器里直接查看服务器主库的原始记录，只读、不改动生产数据。

const DB_COLLECTIONS = [
  { key: 'stores',       label: '门店',        kind: 'array',  desc: '门店档案与店长绑定' },
  { key: 'users',        label: '账号',        kind: 'array',  desc: '登录账号（密码已打码）', sensitive: ['password'] },
  { key: 'workflowInstances', label: '审批流程', kind: 'array', desc: '管理流程实例' },
  { key: 'tasks',        label: '协作任务',    kind: 'array', desc: '任务与执行记录' },
  { key: 'dailyDeposits', label: '当日存款记录', kind: 'array', desc: '门店每日存款上报记录（不含金额）' },
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
  dailyDeposits: { storeId: '门店ID', depositDate: '存款日期', status: '上报状态', receipt: '存款凭证图片', reportedByName: '上报人', reportedAt: '上报时间' },
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
  // 2026-10-08 审计 C-1：country 不再兜底成 'PH'（那会变成 fail-open）。
  // 写入侧已为业务对象补 country（或 countryCode），这里原样传入；
  // 缺字段的记录交给 rbac.can 的 fail-closed 判定拒绝，而非默认放行。
  return rbac.can(currentUser, permission, { ...item, regionId, country: item.country || item.countryCode || null });
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
  // 2026-10-08 审计 M-4：auditEvents 集合设置保留上限（与 notifications 一致截断），
  // 避免长期运行无界增长，加剧 JSON 驱动的全量读写成本。
  if (events.length > 20000) events.length = 20000;
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
const manilaDayFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' });
function manilaToday() {
  const parts = Object.fromEntries(manilaDayFormatter.formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function depositResource(storeItem) {
  const indexes = countryIndexes();
  return { storeId: storeItem.id, regionId: storeItem.regionId || null, country: countryOf(storeItem, indexes.regionIndex, indexes.storeIndex, indexes.orgIndex) };
}

// A confirmation is a manager's report, not bank reconciliation. No amount or ledger data is copied here.
app.get('/api/v2/daily-deposits', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'deposit.view')) return;
  const date = manilaToday();
  const users = readAll('users') || [], deposits = readAll('dailyDeposits') || [], tasks = readAll('tasks') || [];
  const items = (readAll('stores') || [])
    .filter(item => { const resource = depositResource(item); return resource.country === 'PH' && rbac.can(u, 'deposit.view', resource); })
    .map(item => {
      const manager = users.find(user => user.id === item.managerId && !user.disabled && rbac.normalizeRole(user.role) === 'store_manager' && user.storeId === item.id);
      const deposit = deposits.find(entry => entry.storeId === item.id && entry.depositDate === date && entry.status === 'reported');
      const reminder = tasks.find(task => task.kind === 'daily_deposit' && task.storeId === item.id && task.depositDate === date);
      return {
        storeId: item.id, storeName: item.name, storeCode: item.storeCode || '', regionId: item.regionId || null,
        managerName: manager?.name || manager?.username || item.managerName || '', hasManager: !!manager,
        status: deposit ? 'deposited' : 'not_deposited',
        reportedAt: deposit?.reportedAt || null, reportedByName: deposit?.reportedByName || null,
        receipt: deposit?.receipt ? { id: deposit.receipt.id, name: deposit.receipt.name, mimeType: deposit.receipt.mimeType, size: deposit.receipt.size, uploadedAt: deposit.receipt.uploadedAt } : null,
        reminderCount: Number(reminder?.reminderCount || 0), lastReminderAt: reminder?.lastReminderAt || null,
        reminderTaskId: reminder?.status === 'open' ? reminder.id : null,
      };
    });
  res.json({ date, timezone: 'Asia/Manila', items, canRemind: rbac.hasPermission(u, 'deposit.remind'), canSubmit: rbac.hasPermission(u, 'deposit.submit') });
});

app.post('/api/v2/daily-deposits/:storeId/remind', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const linkedStore = (readAll('stores') || []).find(item => item.id === req.params.storeId);
  if (!linkedStore) return res.status(404).json({ error: '门店不存在' });
  const resource = depositResource(linkedStore);
  if (resource.country !== 'PH') return res.status(409).json({ error: '当日存款仅适用于菲律宾门店' });
  if (!guard.check(req, res, 'deposit.remind', resource)) return;
  const date = manilaToday();
  if ((readAll('dailyDeposits') || []).some(item => item.storeId === linkedStore.id && item.depositDate === date && item.status === 'reported')) return res.status(409).json({ error: '该门店今天已上报存款' });
  const manager = (readAll('users') || []).find(user => user.id === linkedStore.managerId && !user.disabled && rbac.normalizeRole(user.role) === 'store_manager' && user.storeId === linkedStore.id);
  if (!manager) return res.status(409).json({ error: '该门店尚无有效店长账号，请先绑定店长' });
  const tasks = readAll('tasks') || [];
  let task = tasks.find(item => item.kind === 'daily_deposit' && item.storeId === linkedStore.id && item.depositDate === date);
  const now = nowIso();
  if (task?.lastReminderAt && Date.now() - Date.parse(task.lastReminderAt) < 10 * 60 * 1000) return res.status(429).json({ error: '10 分钟内已提醒过该店长，请稍后再试' });
  if (!task) {
    task = { id: nanoid(), kind: 'daily_deposit', depositDate: date, title: `Daily deposit / 当日存款 · ${linkedStore.name}`, description: 'Deposit at the bank before closing, then confirm in Daily Bank Deposits. / 请在下班前办理银行存款并在「当日存款」确认。', status: 'open', priority: 'high', assigneeId: manager.id, assigneeName: manager.name || manager.username, storeId: linkedStore.id, warehouseId: null, regionId: linkedStore.regionId || null, country: resource.country, dueAt: `${date}T15:59:59.000Z`, createdBy: u.id, createdByName: u.name || u.username, createdAt: now, updatedAt: now, completedAt: null, overdueReminderAt: null, checklist: [], comments: [], attachments: [], lastReminderAt: now, reminderCount: 1 };
    tasks.unshift(task);
  } else {
    task.assigneeId = manager.id; task.assigneeName = manager.name || manager.username;
    task.status = 'open'; task.updatedAt = now; task.lastReminderAt = now;
    task.reminderCount = Number(task.reminderCount || 0) + 1;
  }
  writeAll('tasks', tasks);
  notifyUser(manager.id, 'daily_deposit.reminder', 'Daily deposit reminder / 今日存款提醒', `Please deposit for ${linkedStore.name} before closing and confirm in Daily Bank Deposits. / 请在下班前完成银行存款并在「当日存款」确认。`, 'task', task.id);
  recordControlAudit(req, u, 'daily_deposit.remind', 'dailyDeposit', `${date}:${linkedStore.id}`, { storeId: linkedStore.id, managerId: manager.id, reminderCount: task.reminderCount });
  res.json({ ok: true, taskId: task.id, reminderCount: task.reminderCount, lastReminderAt: now });
});

const dailyDepositAttachmentDir = path.join(store.DATA_DIR, 'uploads', 'daily-deposits');
const dailyDepositImageTypes = {
  'image/png': { ext: '.png', signature: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
  'image/jpeg': { ext: '.jpg', signature: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
};
function parseDailyDepositReceipt(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '请上传 JPG、JPEG 或 PNG 格式的存款凭证图片' };
  const mimeType = String(raw.mimeType || '').toLowerCase();
  const type = dailyDepositImageTypes[mimeType];
  const name = path.basename(String(raw.fileName || '')).replace(/[\\/\r\n\0]/g, '_').slice(0, 180);
  if (!type || !name || !/\.(png|jpe?g)$/i.test(name)) return { error: '仅支持 JPG、JPEG 或 PNG 格式的存款凭证图片' };
  if (typeof raw.data !== 'string' || raw.data.length > 7_000_000) return { error: '存款凭证图片不能超过 5MB' };
  const match = raw.data.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1].toLowerCase() !== mimeType) return { error: '存款凭证上传格式无效' };
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024 || !type.signature(buffer)) return { error: '图片内容与格式不匹配，或图片超过 5MB' };
  return { value: { name, mimeType, ext: type.ext, buffer } };
}
app.post('/api/v2/daily-deposits/:storeId/confirm', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const linkedStore = (readAll('stores') || []).find(item => item.id === req.params.storeId);
  if (!linkedStore) return res.status(404).json({ error: '门店不存在' });
  const resource = depositResource(linkedStore);
  if (resource.country !== 'PH') return res.status(409).json({ error: '当日存款仅适用于菲律宾门店' });
  if (!guard.check(req, res, 'deposit.submit', resource)) return;
  const date = manilaToday(), deposits = readAll('dailyDeposits') || [];
  if (deposits.some(item => item.storeId === linkedStore.id && item.depositDate === date)) return res.status(409).json({ error: '该门店今天已确认存款，请勿重复提交' });
  const parsedReceipt = parseDailyDepositReceipt(req.body?.receipt);
  if (parsedReceipt.error) return res.status(400).json({ error: parsedReceipt.error });
  const now = nowIso();
  const receiptId = nanoid(), receipt = { id: receiptId, name: parsedReceipt.value.name, mimeType: parsedReceipt.value.mimeType, size: parsedReceipt.value.buffer.length, storedName: `${receiptId}${parsedReceipt.value.ext}`, uploadedAt: now };
  const item = { id: nanoid(), storeId: linkedStore.id, regionId: linkedStore.regionId || null, country: resource.country, depositDate: date, status: 'reported', receipt, reportedBy: u.id, reportedByName: u.name || u.username, reportedAt: now, createdAt: now, updatedAt: now };
  try {
    fs.mkdirSync(dailyDepositAttachmentDir, { recursive: true, mode: 0o700 }); fs.chmodSync(dailyDepositAttachmentDir, 0o700);
    fs.writeFileSync(path.join(dailyDepositAttachmentDir, receipt.storedName), parsedReceipt.value.buffer, { mode: 0o600, flag: 'wx' });
    deposits.unshift(item); writeAll('dailyDeposits', deposits);
  } catch (err) {
    try { fs.unlinkSync(path.join(dailyDepositAttachmentDir, receipt.storedName)); } catch (cleanupError) {}
    return res.status(500).json({ error: '保存存款凭证失败，请重试' });
  }
  const tasks = readAll('tasks') || [], creators = new Set();
  let tasksChanged = false;
  for (const task of tasks) if (task.kind === 'daily_deposit' && task.storeId === linkedStore.id && task.depositDate === date && !['completed','cancelled'].includes(task.status)) {
    task.status = 'completed'; task.completedAt = now; task.updatedAt = now; tasksChanged = true;
    if (task.createdBy && task.createdBy !== u.id) creators.add(task.createdBy);
  }
  if (tasksChanged) writeAll('tasks', tasks);
  for (const creator of creators) notifyUser(creator, 'daily_deposit.confirmed', '门店已上报当日存款', linkedStore.name, 'dailyDeposit', item.id);
  recordControlAudit(req, u, 'daily_deposit.confirm', 'dailyDeposit', item.id, { storeId: item.storeId, depositDate: date });
  res.status(201).json({ item: { ...item, receipt: { ...receipt, storedName: undefined } } });
});
app.get('/api/v2/daily-deposits/:storeId/receipt', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const linkedStore = (readAll('stores') || []).find(item => item.id === req.params.storeId);
  if (!linkedStore) return res.status(404).json({ error: '门店不存在' });
  const resource = depositResource(linkedStore);
  if (!guard.check(req, res, 'deposit.view', resource)) return;
  const deposit = (readAll('dailyDeposits') || []).find(item => item.storeId === linkedStore.id && item.depositDate === manilaToday() && item.status === 'reported');
  const receipt = deposit?.receipt;
  if (!receipt || !dailyDepositImageTypes[receipt.mimeType] || !/^[A-Za-z0-9_-]+\.(png|jpg)$/.test(receipt.storedName || '')) return res.status(404).json({ error: '存款凭证不存在' });
  const filePath = path.join(dailyDepositAttachmentDir, receipt.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '存款凭证文件不存在' });
  res.set({ 'Content-Type': receipt.mimeType, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  res.sendFile(filePath);
});
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
  const allowedRoles = ['admin','owner','hq_operator','philippines_manager','regional_manager','purchaser','manager','sales','warehouse','service'];
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
  // 账号国家归属（2026-10-08 审计 C-1）：有区域→区域国家；有门店→门店区域国家；
  // 无门店无区域时按角色语义（菲律宾相关角色默认 PH），再退到传入 country，缺省 CN。
  const PH_ROLES = new Set(['philippines_manager', 'regional_manager', 'store_manager', 'manager', 'sales', 'warehouse', 'service']);
  const storeRegion = store?.regionId ? regions.find(x => x.id === store.regionId) : null;
  const userCountry = region?.countryCode || storeRegion?.countryCode || (PH_ROLES.has(role) ? 'PH' : (b.country || 'CN'));
  const user = { id: nanoid(), username, password: bcrypt.hashSync(password, 12), name, role, storeId: store?.id || null, regionId: role === 'regional_manager' ? region.id : (region?.id || store?.regionId || null), employeeId: employee?.id || null, phone: controlCenter.cleanText(b.phone, 80), createdAt: nowIso(), disabled: false, mustChangePassword: !isStoreManagerRole(role), country: userCountry };
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
  const validRoles = ['admin','owner','hq_operator','philippines_manager','regional_manager','purchaser','store_manager','sales','warehouse','service'];
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
  // 2026-10-08 审计 C-1：country 从真实归属推导，不再硬编码 'PH'。
  // 门店归属的 country 已由 migrate 回填；集团级（无门店）用创建者账号的 country。
  const wfCountry = countryOf({ regionId, storeId }, ...(() => { const ix = countryIndexes(); return [ix.regionIndex, ix.storeIndex, ix.orgIndex]; })()) || u.country || 'PH';
  const scopeResource = { storeId, regionId, country: wfCountry, createdBy: u.id };
  if (!guard.check(req, res, 'workflow.create', scopeResource)) return;
  let assignee = null;
  if (type === 'store_remediation' && form.assigneeId) {
    if (!guard.checkPerm(req, res, 'task.assign') || !guard.check(req, res, 'task.assign', { storeId, regionId, country: wfCountry, createdBy: u.id })) return;
    assignee = (readAll('users') || []).find(x => x.id === form.assigneeId && !x.disabled);
    if (!assignee) return res.status(400).json({ error: '整改负责人账号不存在或已停用' });
    const assignment = rbac.canAssign(u, assignee, 'task');
    if (!assignment.ok) return res.status(403).json({ error: assignment.reason || '无权指派该整改负责人' });
    if (!rbac.hasPermission(assignee, 'workflow.view') || !rbac.hasPermission(assignee, 'workflow.execute')) return res.status(400).json({ error: '该账号没有整改流程查看或执行权限' });
  }
  delete form.assigneeId;
  const items = readAll('workflowInstances') || [];
  const spec = controlCenter.WORKFLOW_TYPES[type];
  const item = { id: nanoid(), type, title: controlCenter.cleanText(b.title || spec.label, 180), status: 'pending_approval', assigneeId: assignee?.id || null, assigneeName: assignee ? (assignee.name || assignee.username) : null, form, definitionId: null, definitionVersion: 1, storeId, warehouseId, regionId, organizationId: b.organizationId || null, sourceInspectionId: sourceInspection?.id || null, createdBy: u.id, createdByName: u.name || u.username, createdAt: nowIso(), updatedAt: nowIso(), country: wfCountry, currentStep: 0, approvalSlaHours: null, approvalDueAt: null, approvalReminderAt: null, approvalDelegations: [], executionRound: 0, externalDocumentNumber: null, executionStatus: null, executedBy: null, executedAt: null, comments: [], attachments: [] };
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
    // 2026-10-08 审计 H-3：会签（all 模式）去重键必须是「实际签署人」而非「席位」。
    // 同一人若身兼多席（如 admin + owner + philippines_manager），
    // 按 approverKey 去重会让他一人签满多个名额，失去多人共审意义。
    const step = item.approvalSteps[item.currentStep];
    const alreadySignedByThisUser = (item.stepApprovals || []).some(x => x.step === item.currentStep && x.actorId === u.id);
    if (alreadySignedByThisUser) return res.status(409).json({ error: '您已在本步骤签署过，会签需由不同审批人完成' });
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
  if (!guard.check(req, res, 'task.create', { storeId, regionId: store.regionId, country: store.country || 'PH' })) return;
  const reportDate = controlCenter.cleanText(b.reportDate, 10);
  if (!isIsoCalendarDate(reportDate)) return res.status(400).json({ error: '工作汇报日期无效' });
  const item = { id: nanoid(), storeId, regionId: store.regionId || null, country: store.country || 'PH', reportDate, additionalNote: controlCenter.cleanText(b.additionalNote ?? b.salesNote, 2000), incidents: controlCenter.cleanText(b.incidents, 2000), summary: controlCenter.cleanText(b.summary, 4000), createdBy: u.id, createdByName: u.name || u.username, createdAt: nowIso(), updatedAt: nowIso(), attachments: [] };
  if (!item.summary && !item.additionalNote && !item.incidents) return res.status(400).json({ error: '请填写工作内容或异常说明' });
  const items = readAll('storeReports') || []; items.unshift(item); writeAll('storeReports', items); recordControlAudit(req, u, 'storeReport.create', 'storeReport', item.id); res.status(201).json({ item });
});
app.post('/api/v2/store-inspections', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'task.create')) return;
  const b = req.body || {}, scope = guard.scopeOf(req, 'task.create'), storeId = scope.level === 'store' ? u.storeId : b.storeId;
  const store = (readAll('stores') || []).find(x => x.id === storeId); if (!store) return res.status(400).json({ error: '请选择有效门店' });
  if (!guard.check(req, res, 'task.create', { storeId, regionId: store.regionId, country: store.country || 'PH' })) return;
  const inspectionDate = controlCenter.cleanText(b.inspectionDate, 10), result = ['pass','attention','fail'].includes(b.result) ? b.result : '';
  if (!isIsoCalendarDate(inspectionDate) || !result) return res.status(400).json({ error: '请填写有效日期和巡检结果' });
  const score = b.score === '' || b.score == null ? null : Number(b.score);
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) return res.status(400).json({ error: '巡检评分须为 0 至 100' });
  const item = { id: nanoid(), storeId, regionId: store.regionId || null, country: store.country || 'PH', inspectionDate, result, score, checklist: controlCenter.cleanText(b.checklist, 4000), findings: controlCenter.cleanText(b.findings, 4000), createdBy: u.id, createdByName: u.name || u.username, createdAt: nowIso(), attachments: [] };
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
// ============ 采购跟单（2026-10-07 新增）============
// 一个「批次/船期」一条记录：采购员跟进国内下单 → 备货 → 开船 → 在��� →
// 到港 → 清关 → 入库，需要高频实时更新。
// 阶段顺序即数组下标，前端据此画进度条；服务端只接受已定义阶段，
// 且**不允许阶段倒退**（避免把已入库的批次误改回在途）。
const PURCHASE_STAGES = ['ordered', 'preparing', 'loaded', 'in_transit', 'arrived', 'customs', 'warehoused'];
const purchaseAttachmentDir = path.join(store.DATA_DIR, 'uploads', 'purchase-shipments');
function normalizePurchaseStage(value) {
  const v = String(value || '').trim();
  return PURCHASE_STAGES.includes(v) ? v : '';
}
app.get('/api/v2/purchase-shipments', (req, res) => {
  if (!guard.checkPerm(req, res, 'purchase.view')) return;
  const all = readAll('purchaseShipments') || [];
  const q = controlCenter.cleanText(req.query.q, 120).toLowerCase();
  const stage = normalizePurchaseStage(req.query.stage);
  const filtered = all.filter(x => {
    if (stage && x.stage !== stage) return false;
    if (!q) return true;
    return [x.orderNo, x.supplier, x.vessel, x.blNo, x.portOfLoading, x.portOfDischarge, x.ownerName]
      .some(v => String(v || '').toLowerCase().includes(q));
  })
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  const total = filtered.length;
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20));
  const rawOffset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const offset = total ? Math.min(rawOffset, Math.floor((total - 1) / limit) * limit) : 0;
  const countsByStage = {};
  for (const s of PURCHASE_STAGES) countsByStage[s] = all.filter(x => x.stage === s).length;
  res.json({
    items: filtered.slice(offset, offset + limit),
    total, offset, limit, countsByStage,
    stages: PURCHASE_STAGES,
    inTransitTotal: all.filter(x => ['ordered','preparing','loaded','in_transit'].includes(x.stage)).length,
    // 跟单仪表盘（2026-10-08）：7 天内预计到达 —— 按**全量**统计（列表只是一页），
    // 口径：填了 ETA、尚未入库、且 ETA 落在今天至 +7 天之间（含今天）。
    etaSoonTotal: (() => {
      const today = nowIso().slice(0, 10);
      const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      return all.filter(x => x.eta && x.stage !== 'warehoused' && !x.arrivalDate && x.eta >= today && x.eta <= soon).length;
    })(),
  });
});
app.post('/api/v2/purchase-shipments', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'purchase.create')) return;
  const b = req.body || {};
  const orderNo = controlCenter.cleanText(b.orderNo, 80);
  const supplier = controlCenter.cleanText(b.supplier, 160);
  if (!orderNo) return res.status(400).json({ error: '请填写订单号' });
  if (!supplier) return res.status(400).json({ error: '请填写供应商' });
  const stage = normalizePurchaseStage(b.stage || 'ordered');
  if (!stage) return res.status(400).json({ error: '请选择有效的物流阶段' });
  const items = readAll('purchaseShipments') || [];
  if (items.some(x => x.orderNo && x.orderNo.toLowerCase() === orderNo.toLowerCase() && x.stage !== 'warehoused')) {
    return res.status(409).json({ error: '该订单号已有在途批次，如需分批请在原批次上更新或使用区分后缀' });
  }
  const etd = controlCenter.cleanText(b.etd, 10), eta = controlCenter.cleanText(b.eta, 10), arrivalDate = controlCenter.cleanText(b.arrivalDate, 10);
  for (const [label, value] of [['ETD 开船日', etd], ['ETA 到港日', eta], ['到港日期', arrivalDate]]) {
    if (value && !isIsoCalendarDate(value)) return res.status(400).json({ error: `${label}无效` });
  }
  const item = {
    id: nanoid(),
    orderNo, supplier,
    vessel: controlCenter.cleanText(b.vessel, 120),
    blNo: controlCenter.cleanText(b.blNo, 80),
    containerNo: controlCenter.cleanText(b.containerNo, 80),
    portOfLoading: controlCenter.cleanText(b.portOfLoading, 120),
    portOfDischarge: controlCenter.cleanText(b.portOfDischarge, 120),
    productName: controlCenter.cleanText(b.productName, 200),
    quantity: controlCenter.cleanText(b.quantity, 60),
    amount: b.amount === '' || b.amount == null ? null : Number(b.amount),
    etd, eta, arrivalDate,
    stage,
    note: controlCenter.cleanText(b.note, 2000),
    ownerId: controlCenter.cleanText(b.ownerId, 60) || u.id,
    ownerName: controlCenter.cleanText(b.ownerName, 80) || (u.name || u.username),
    createdBy: u.id, createdByName: u.name || u.username,
    createdAt: nowIso(), updatedAt: nowIso(),
    country: u.country || 'PH',
    stageHistory: [{ stage, at: nowIso(), byName: u.name || u.username, note: '' }],
    attachments: [],
  };
  if (item.amount !== null && (!Number.isFinite(item.amount) || item.amount < 0)) return res.status(400).json({ error: '金额须为不小于 0 的数字' });
  items.unshift(item);
  writeAll('purchaseShipments', items);
  recordControlAudit(req, u, 'purchaseShipment.create', 'purchaseShipment', item.id, { stage });
  res.status(201).json({ item });
});
app.post('/api/v2/purchase-shipments/:id', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'purchase.edit')) return;
  const items = readAll('purchaseShipments') || [], item = items.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '采购批次不存在' });
  if (!guard.check(req, res, 'purchase.edit', item)) return;
  const b = req.body || {};
  const previousStage = item.stage;
  if (b.stage !== undefined) {
    const stage = normalizePurchaseStage(b.stage);
    if (!stage) return res.status(400).json({ error: '请选择有效的物流阶段' });
    const fromIndex = PURCHASE_STAGES.indexOf(previousStage), toIndex = PURCHASE_STAGES.indexOf(stage);
    if (toIndex < fromIndex) return res.status(400).json({ error: '物流阶段不能倒退。如需修正请新建一条更正记录。' });
    item.stage = stage;
  }
  for (const key of ['vessel','blNo','containerNo','portOfLoading','portOfDischarge','productName','quantity','orderNo','supplier']) {
    if (b[key] !== undefined) item[key] = controlCenter.cleanText(b[key], key === 'productName' ? 200 : 160);
  }
  if (b.amount !== undefined) {
    const amount = b.amount === '' || b.amount == null ? null : Number(b.amount);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) return res.status(400).json({ error: '金额须为不小于 0 的数字' });
    item.amount = amount;
  }
  for (const [key, label] of [['etd','ETD 开船日'],['eta','ETA 到港日'],['arrivalDate','到港日期']]) {
    if (b[key] !== undefined) {
      const value = controlCenter.cleanText(b[key], 10);
      if (value && !isIsoCalendarDate(value)) return res.status(400).json({ error: `${label}无效` });
      item[key] = value;
    }
  }
  if (b.note !== undefined) item.note = controlCenter.cleanText(b.note, 2000);
  if (item.stage !== previousStage) {
    item.stageHistory = Array.isArray(item.stageHistory) ? item.stageHistory : [];
    item.stageHistory.push({ stage: item.stage, at: nowIso(), byName: u.name || u.username, note: controlCenter.cleanText(b.stageNote, 500) });
  }
  item.updatedAt = nowIso();
  writeAll('purchaseShipments', items);
  recordControlAudit(req, u, 'purchaseShipment.update', 'purchaseShipment', item.id, { from: previousStage, to: item.stage });
  res.json({ item });
});
app.post('/api/v2/purchase-shipments/:id/attachments', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'purchase.edit')) return;
  const items = readAll('purchaseShipments') || [], item = items.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '采购批次不存在' });
  if (!guard.check(req, res, 'purchase.edit', item)) return;
  const { fileName, mimeType, data } = req.body || {};
  const type = workflowAttachmentTypes[String(mimeType || '').toLowerCase()];
  if (!type || !['application/pdf','image/png','image/jpeg'].includes(String(mimeType).toLowerCase()) || typeof data !== 'string' || data.length > 5_600_000) return res.status(400).json({ error: '凭证仅支持 4MB 以内的 PDF、PNG 或 JPG 文件' });
  const match = data.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1].toLowerCase() !== String(mimeType).toLowerCase()) return res.status(400).json({ error: '附件格式无效' });
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 4 * 1024 * 1024 || !type.signature(buffer)) return res.status(400).json({ error: '文件内容与格式不匹配或超过 4MB' });
  item.attachments = Array.isArray(item.attachments) ? item.attachments : [];
  if (item.attachments.length >= 10 || item.attachments.reduce((sum, x) => sum + Number(x.size || 0), 0) + buffer.length > 20 * 1024 * 1024) return res.status(409).json({ error: '每个批次最多 10 个凭证，合计不超过 20MB' });
  fs.mkdirSync(purchaseAttachmentDir, { recursive: true, mode: 0o700 }); fs.chmodSync(purchaseAttachmentDir, 0o700);
  const id = nanoid(), storedName = `${id}${type.ext}`;
  fs.writeFileSync(path.join(purchaseAttachmentDir, storedName), buffer, { mode: 0o600, flag: 'wx' });
  const safeName = path.basename(String(fileName || 'attachment')).replace(/[\\/\r\n\0]/g, '_').slice(0, 180) || `attachment${type.ext}`;
  const attachment = { id, name: safeName, mimeType: String(mimeType).toLowerCase(), size: buffer.length, storedName, uploadedBy: u.id, uploadedByName: u.name || u.username, createdAt: nowIso() };
  item.attachments.push(attachment); item.updatedAt = attachment.createdAt; writeAll('purchaseShipments', items);
  recordControlAudit(req, u, 'purchaseShipment.attachment.upload', 'purchaseShipment', item.id, { attachmentId: id, size: buffer.length });
  res.status(201).json({ attachment });
});
app.get('/api/v2/purchase-shipments/:id/attachments/:attachmentId/download', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  if (!guard.checkPerm(req, res, 'purchase.view')) return;
  const items = readAll('purchaseShipments') || [], item = items.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '采购批次不存在' });
  if (!guard.check(req, res, 'purchase.view', item)) return;
  const attachment = (item.attachments || []).find(x => x.id === req.params.attachmentId);
  if (!attachment) return res.status(404).json({ error: '凭证不存在' });
  const filePath = path.join(purchaseAttachmentDir, path.basename(attachment.storedName));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '凭证文件已不存在' });
  const asciiName = attachment.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.set({ 'Content-Type': workflowAttachmentTypes[attachment.mimeType]?.ext ? attachment.mimeType : 'application/octet-stream', 'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  res.sendFile(filePath);
});
app.get('/api/v2/task-assignees', (req, res) => {
  if (!guard.checkPerm(req, res, 'task.assign')) return;
  const actor = getSessionUser(req);  const users = (readAll('users') || []).filter(x => !x.disabled && rbac.canAssign(actor, x, 'task').ok).filter(x => controlVisible(req, 'task.assign', { storeId: x.storeId, country: 'PH', createdBy: x.id }));
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
  // 2026-10-08 审计 C-1：country 从真实归属推导，不再硬编码 'PH'
  const taskCountry = countryOf({ regionId: linkedStore?.regionId || null, storeId }, ...(() => { const ix = countryIndexes(); return [ix.regionIndex, ix.storeIndex, ix.orgIndex]; })()) || u.country || 'PH';
  const taskResource = { storeId, warehouseId: null, regionId: linkedStore?.regionId || null, country: taskCountry, createdBy: u.id };
  if (!guard.check(req, res, 'task.create', taskResource)) return;
  let assignee = null;
  if (b.assigneeId) {
    if (!guard.check(req, res, 'task.assign', { storeId, country: taskCountry, createdBy: u.id })) return;
    assignee = (readAll('users') || []).find(x => x.id === b.assigneeId && !x.disabled);
    if (!assignee) return res.status(400).json({ error: '负责人账号不存在或已停用' });
    const assignment = rbac.canAssign(u, assignee, 'task');
    if (!assignment.ok) return res.status(403).json({ error: assignment.reason || '无权指派给该账号' });
  }
  const dueAt = parseControlDueDate(b.dueAt);
  if (dueAt && !Number.isFinite(dueAt.getTime())) return res.status(400).json({ error: '截止日期无效' });
  const checklist = normalizeTaskChecklist(b.checklist);
  if (!checklist.ok) return res.status(400).json({ error: checklist.error });
  const item = { id: nanoid(), title, description: controlCenter.cleanText(b.description, 2000), status: 'open', priority: ['low','normal','high','urgent'].includes(b.priority) ? b.priority : 'normal', assigneeId: assignee?.id || null, assigneeName: assignee?.name || assignee?.username || null, storeId, warehouseId: null, regionId: linkedStore?.regionId || null, country: taskCountry, dueAt: dueAt ? dueAt.toISOString() : null, createdBy: u.id, createdByName: u.name || u.username, createdAt: nowIso(), updatedAt: nowIso(), completedAt: null, overdueReminderAt: null, checklist: checklist.value, comments: [], attachments: [] };
  const items = readAll('tasks') || []; items.unshift(item); writeAll('tasks', items);
  if (item.assigneeId) notifyUser(item.assigneeId, 'task.assigned', '收到新任务', item.title, 'task', item.id);
  recordControlAudit(req, u, 'task.create', 'task', item.id, { title }); res.status(201).json({ item });
});
app.post('/api/v2/tasks/:id/complete', (req, res) => {
  const u = getSessionUser(req); if (!u) return res.status(401).json({ error: '未登录' });
  const items = readAll('tasks') || [], item = items.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '任务不存在' });
  if (item.kind === 'daily_deposit') return res.status(409).json({ error: '请在「当日存款」页面确认，存款待办会自动完成' });
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
  if (item.kind === 'daily_deposit') return res.status(409).json({ error: '存款待办不能修改清单' });
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
  if (item.kind === 'daily_deposit') return res.status(409).json({ error: '请在「当日存款」页面处理该待办' });
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
    createdBy: u.id, createdByName: u.name || u.username, createdAt: nowIso(), updatedAt: nowIso(), country: u.country || 'PH' };
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
