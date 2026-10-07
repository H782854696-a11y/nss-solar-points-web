// SolarPoints 前端 SPA / SolarPoints front-end SPA
// vanilla JS：登录、CRUD、弹窗、Toast、同步状态
// 文案全部走 I18N（默认英文，可切中文）
/* global I18N */

const { t, tMsg, tStore, tName, locale, getLang, setLang, applyStatic, onChange } = I18N;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// 移动端断点：必须与 styles.css 里的 @media (max-width: 900px) 一致
const mobileMq = window.matchMedia('(max-width: 900px)');
const isMobile = () => mobileMq.matches;

// 会员记录里的 storeName 是冗余副本，门店改名后可能过期。
// 显示时优先按 storeId 到当前门店列表里解析，取不到再退回副本。
function memberStoreName(m) {
  if (!m) return '';
  if (m.storeId && state.stores) {
    const s = state.stores.find(x => x.id === m.storeId);
    if (s && s.name) return tStore(s.name);
  }
  return tStore(m.storeName) || '';
}

const state = {
  me: null,
  screen: 'controlCenter',
  stores: [],
  members: { list: [], total: 0, page: 1, pageSize: 20 },
  rules: null,
  sheets: null,
  dashboard: null,
  regions: [],
  workflowFilters: { status: '', type: '', q: '' },
  workflowOffset: 0,
  taskFilters: { status: '', priority: '', storeId: '', q: '' },
  taskOffset: 0,
  notificationOffset: 0,
  storeOperationOffsets: { reports: 0, inspections: 0, issues: 0 },
  ccAuditFilters: { q: '', from: '', to: '' },
  ccAuditOffset: 0,
};

// =================== API 客户端 ===================
async function api(method, path, body, isForm) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body && !isForm) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body && isForm) {
    opts.body = body; // FormData
  }
  let res;
  try { res = await fetch(path, opts); }
  catch (error) {
    if (navigator.onLine === false) throw new Error(ccText('You are offline. Reconnect to submit or refresh business data.', '当前已离线，请联网后提交或刷新业务数据。'));
    throw new Error(ccText('Cannot connect to the server. Check your connection and try again.', '无法连接服务器，请检查网络后重试。'));
  }
  // 登录接口的 401 表示账号/密码校验失败，应显示服务端的准确提示；
  // 其它接口的 401 才表示当前会话已失效。
  if (res.status === 401 && path !== '/api/auth/login') {
    state.me = null;
    showLogin();
    throw new Error(t('common.notSignedIn'));
  }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(tMsg((data && data.error) || `HTTP ${res.status}`));
  return data;
}

const GET    = (p)        => api('GET', p);
const POST   = (p, b)     => api('POST', p, b);
const PUT    = (p, b)     => api('PUT', p, b);
const DELETE = (p)        => api('DELETE', p);

// =================== Toast ===================
let toastHost;
function ensureToastHost() {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    document.body.appendChild(toastHost);
  }
}
function toast(message, type = 'info') {
  ensureToastHost();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0'; el.style.transform = 'translateY(-8px)';
    setTimeout(() => el.remove(), 200);
  }, 2400);
}

// =================== 语言切换 ===================
function syncLangButtons() {
  $$('#langBtn, #langBtnLogin').forEach(b => {
    b.textContent = t('common.langSwitch');
    b.title = t('common.langSwitchTitle');
  });
}

function bindLangButtons() {
  applyStatic();
  syncLangButtons();
  $$('#langBtn, #langBtnLogin').forEach(b => {
    b.addEventListener('click', () => setLang(getLang() === 'zh' ? 'en' : 'zh'));
  });
  onChange(() => {
    syncLangButtons();
    if (!state.me) return;
    renderUserBlock();
    updateHeaderCrumb();
    updateSyncChip();
    closeModal();
    renderScreen();
  });
}

// =================== 登录 ===================
function showLogin() {
  $('#appShell').classList.add('hidden');
  $('#appShell').classList.remove('nav-open');
  $('#loginPage').classList.remove('hidden');
}
function showApp() {
  $('#loginPage').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
}

/**
 * 拉取当前会话信息 + 权限清单。
 * 唯一来源是 /api/auth/me —— 登录接口本身不返回 grants（后端改动严格限定在 /me 这一处），
 * 所以登录成功后也要再调一次它。
 */
async function loadMe() {
  const r = await GET('/api/auth/me');
  // role / grants 挂在响应顶层（与 user 平级），这里合并进 state.me 供 UI 使用
  state.me = Object.assign({}, r.user, { role: r.role, grants: r.grants || [], mustChangePassword: !!r.mustChangePassword });
  return state.me;
}

/** 登录页密码「显示/隐藏」切换（纯 UI，不改认证逻辑；loading 态只作用于 #loginSubmit） */
function bindPwdToggle() {
  const btn = $('#pwdToggle');
  const input = document.querySelector('#loginForm input[name=password]');
  if (!btn || !input) return;
  btn.title = t('login.showPwd');
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.classList.toggle('showing', show);
    btn.title = t(show ? 'login.hidePwd' : 'login.showPwd');
    input.focus();
  });
}

async function bootstrap() {
  bindLangButtons();
  bindPwdToggle();
  try {
    await loadMe();
    if (state.me.mustChangePassword) renderMandatoryPasswordChange();
    else { showApp(); initApp(); }
  } catch (e) {
    showLogin();
    if (navigator.onLine === false) $('#loginError').textContent = e.message;
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const username = fd.get('username').trim();
    const password = fd.get('password');
    $('#loginError').textContent = '';
    const btn = $('#loginSubmit'); btn.disabled = true; btn.textContent = t('login.submitting');
    try {
      const r = await POST('/api/auth/login', { username, password });
      toast(t('login.welcome', { name: tName(r.user.name) }), 'success');
      // 登录接口不返回 grants（后端改动只允许落在 /me），因此再拉一次会话信息
      await loadMe();
      if (state.me.mustChangePassword) renderMandatoryPasswordChange();
      else { showApp(); initApp(); }
    } catch (err) {
      $('#loginError').textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = t('login.submit');
    }
  });
  $('#logoutBtn').addEventListener('click', async () => {
    await POST('/api/auth/logout');
    state.me = null;
    showLogin();
  });
}

function renderMandatoryPasswordChange() {
  showLogin();
  const center = $('.login-center');
  const zh = String(locale()).toLowerCase().startsWith('zh');
  center.innerHTML = `
    <img src="/logo-brand.png" alt="NSS Solar" class="login-logo" />
    <h1 class="login-title">${zh ? '先设置新密码' : 'Set a new password'}</h1>
    <div class="login-subtitle">${zh ? '首次登录前必须更换临时密码' : 'Change the temporary password before continuing'}</div>
    <form id="mandatoryPasswordForm" class="login-panel">
      <label class="field"><span class="field-label">${zh ? '当前临时密码' : 'Current temporary password'}</span><span class="input-wrap"><input name="currentPassword" type="password" autocomplete="current-password" required/></span></label>
      <label class="field"><span class="field-label">${zh ? '新密码（至少 12 位）' : 'New password (12 characters minimum)'}</span><span class="input-wrap"><input name="newPassword" type="password" autocomplete="new-password" required minlength="12"/></span></label>
      <label class="field"><span class="field-label">${zh ? '确认新密码' : 'Confirm new password'}</span><span class="input-wrap"><input name="confirmPassword" type="password" autocomplete="new-password" required minlength="12"/></span></label>
      <div id="mandatoryPasswordError" class="login-error" aria-live="polite"></div>
      <button class="login-submit" type="submit">${zh ? '保存并继续' : 'Save and continue'}</button>
      <button id="mandatoryPasswordLogout" class="btn" type="button" style="width:100%;margin-top:10px;">${zh ? '退出登录' : 'Sign out'}</button>
    </form>`;
  $('#mandatoryPasswordForm').addEventListener('submit', async e => {
    e.preventDefault(); const values = Object.fromEntries(new FormData(e.currentTarget));
    const error = $('#mandatoryPasswordError');
    if (values.newPassword !== values.confirmPassword) { error.textContent = zh ? '两次输入的新密码不一致' : 'The new passwords do not match'; return; }
    if (values.newPassword === values.currentPassword) { error.textContent = zh ? '新密码不能与当前密码相同' : 'Choose a password different from the temporary one'; return; }
    const button = e.currentTarget.querySelector('button[type="submit"]'); button.disabled = true;
    try { await POST('/api/auth/change-password', values); await loadMe(); showApp(); await initApp(); }
    catch (err) { error.textContent = tMsg(err.message || err); }
    finally { button.disabled = false; }
  });
  $('#mandatoryPasswordLogout').addEventListener('click', async () => { try { await POST('/api/auth/logout', {}); } finally { window.location.reload(); } });
}

// =================== RBAC 前端适配层 ===================
// 前端**只消费后端下发的权限清单**（/api/auth/me 的 grants），
// 不判断角色名、不内置权限矩阵 —— 授权逻辑只有后端一份。
//
// ⚠️ 前端显隐纯粹是体验优化，**不是安全边界**：
//    即使有人改前端或直接调 API，后端仍会按权限返回 403。

/** 当前账号是否拥有某权限，如 can('member.delete') */
function can(perm) {
  const g = state.me && state.me.grants;
  return Array.isArray(g) && g.some(x => x.p === perm);
}

/** 某权限在当前账号下的数据范围（global/hq/philippines/region/store/self），无该权限返回 null */
function permScope(perm) {
  const g = state.me && state.me.grants;
  if (!Array.isArray(g)) return null;
  const hit = g.find(x => x.p === perm);
  return hit ? hit.s : null;
}

/** 是否「不限门店」范围（global / hq / philippines）—— 用于总览等页面的范围文案 */
function isWideScope(perm) {
  const s = permScope(perm);
  return s === 'global' || s === 'hq' || s === 'philippines';
}

/**
 * 角色名 → i18n 文案 key。
 * ⚠️ 纯展示用途，**不参与任何授权判断**（授权一律走 can()）。
 */
const ROLE_LABEL_KEY = {
  admin: 'role.admin', owner: 'role.owner', hq_operator: 'role.hq',
  philippines_manager: 'role.ph', regional_manager: 'role.region',
  store_manager: 'role.manager', sales: 'role.sales',
  warehouse: 'role.warehouse', service: 'role.service',
};
function roleLabel(role) {
  const k = ROLE_LABEL_KEY[role];
  return k ? t(k) : t('role.manager');
}

// =================== App Init ===================
function renderUserBlock() {
  if (!state.me) return;
  // 显示名过一遍 tName()：英文界面下「总部管理员」要显示成 HQ Administrator，头像首字母也跟着走
  const displayName = tName(state.me.name) || '';
  const role = roleLabel(state.me.role);
  $('#userName').textContent = displayName && displayName !== role && !(/管理员/.test(displayName) && /管理员/.test(role)) ? displayName : (state.me.username || displayName);
  // 角色标签：用后端规范化后的角色名查文案（纯显示，不参与授权判断）
  $('#userRole').textContent = role;
  $('#userAvatar').textContent = ($('#userName').textContent || 'U')[0];
}

/**
 * 页面 → 所需权限。新增页面只需在这里加一行，下面三处守卫（侧栏入口、
 * setScreen、renderScreen）会自动生效。没有权限 = 只能看，不需要单独登记。
 */
const SCREEN_PERMS = {
  controlCenter: 'workflow.view',
  approvals: 'approval.view',   // 待审核列表（可见范围由后端按门店/区域收窄）
  stores:    'store.view',      // 门店管理（无此权限的角色，菜单与页面一并不可见）
  mall:      'mall.view',       // 积分商城（renderMall 会无条件请求 /api/products 与 /api/redemptions，
                                //   两者都需要 mall.view；不登记的话无权限角色能看到入口、点进去只有「加载失败」）
  sheets:    'sync.view',       // 云同步状态
  db:        'db.view',         // 数据主库
  audit:     'system.audit.view', // 审计日志（沿用既有权限，仅 admin）
  accounts:  'system.user.view',  // 账号管理（列表沿用既有权限；启用/停用另需 system.user.edit，
                                  //   两者当前都只授 admin。本页不新造权限。）
  storeBiz:  'report.view',       // 门店经营（复用报表读取权限，零新增 RBAC）
  memberBiz: 'report.view',       // 会员经营（同上）
};

// 经营总览与经营报表不再作为独立板块开放；底层实现和数据保留以便回滚。
const RETIRED_OPERATION_SCREENS = new Set(['dashboard', 'reports', 'storeBiz', 'memberBiz']);
const HOME_SCREEN_ORDER = ['controlCenter', 'stores', 'db', 'audit', 'accounts', 'account'];

/** 当前账号能否访问某个页面 */
function canAccessScreen(name) {
  if (RETIRED_OPERATION_SCREENS.has(name) || ['members','rules','mall','approvals','sheets'].includes(name)) return false;
  if (name === 'controlCenter') return ['workflow.view', 'workflow.create', 'workflow.approve', 'workflow.execute', 'task.view', 'task.create', 'org.view'].some(can);
  const perm = SCREEN_PERMS[name];
  if (!perm) return true;
  return can(perm);
}

function homeScreen() { return HOME_SCREEN_ORDER.find(canAccessScreen) || 'account'; }

let appBound = false;

async function initApp() {
  renderUserBlock();
  // 侧栏入口按角色显隐。用 display 而不是 remove()：
  // remove() 是永久移除，店长登录过一次之后管理员再登录，入口就再也回不来了。
  $$('.nav-item').forEach(el => {
    const workspacePerms = { approvals: ['workflow.view', 'workflow.create'], collaboration: ['task.view', 'task.create'], storeops: ['task.create', 'store.view', 'alert.view'], governance: ['org.view', 'staff.view', 'workflow.configure', 'system.audit.view'] };
    const needed = workspacePerms[el.dataset.workspace];
    el.style.display = canAccessScreen(el.dataset.screen) && (!needed || needed.some(can)) ? '' : 'none';
  });
  // 门店列表接口需要 store.view。没有该权限就跳过请求 ——
  // 否则 403 会抛出异常、打断整个 initApp，页面停在半渲染状态。
  // （例如 sales 角色：门店信息对它是不可见的，跳过即可，不影响其它功能。）
  if (can('store.view')) {
    await refreshStores();
  } else {
    state.stores = [];
  }
  // 云同步状态接口需要 sync.view。没有该权限就不要请求它（否则 403 会打断整个初始化）
  hideSyncChip();
  // 侧栏与抽屉的事件只绑一次。重复绑定会让汉堡按钮「开了又立刻关」，
  // 点一次导航也会发出两次请求。
  if (!appBound) {
    bindSidebar();
    bindNavDrawer();
    bindThemeToggle();
    bindFormValidation();
    appBound = true;
  }
  setScreen(homeScreen());
}

function bindSidebar() {
  const icons = {
    approvals: '<path d="M5 4.5h14v15H5zM8 12l2.5 2.5L16 9"/>',
    collaboration: '<path d="M5 5h14v14H5zM8 9h8M8 13h5M8 16h6"/>',
    storeops: '<path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="9" r="2"/>',
    announcements: '<path d="M4 10v4h4l9 4V6l-9 4H4zM8 14l1 5h3"/>',
    governance: '<path d="M5 6h14M5 12h14M5 18h14M9 4v4M15 10v4M11 16v4"/>',
  };
  $$('.nav-item').forEach(el => {
    if (!el.classList.contains('nav-item-primary')) {
      const key = el.dataset.workspace;
      if (!el.querySelector('svg') && icons[key]) el.insertAdjacentHTML('afterbegin', `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[key]}</svg>`);
    }
    const icon = el.querySelector('svg');
    if (icon && !icon.parentElement.classList.contains('nav-icon')) { const frame = document.createElement('span'); frame.className = 'nav-icon'; frame.setAttribute('aria-hidden', 'true'); icon.before(frame); frame.appendChild(icon); }
    el.addEventListener('click', () => { if (el.dataset.workspace) state.ccWorkspace = el.dataset.workspace; else if (el.dataset.screen === 'controlCenter') state.ccWorkspace = 'overview'; setScreen(el.dataset.screen); closeNav(); });
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); } });
  });
  const userBlock = $('#userBlock');
  if (userBlock) {
    userBlock.setAttribute('role', 'button'); userBlock.tabIndex = 0;
    userBlock.setAttribute('aria-label', ccText('Account settings', '账号设置'));
    userBlock.addEventListener('click', () => { setScreen('account'); closeNav(); });
    userBlock.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); userBlock.click(); } });
  }
}

function bindThemeToggle() {
  const shell = $('#appShell'), button = $('#themeToggle');
  if (!shell || !button) return;
  const apply = theme => {
    shell.dataset.theme = theme;
    button.setAttribute('aria-label', theme === 'dark' ? '切换浅色模式' : '切换深色模式');
    button.title = button.getAttribute('aria-label');
    button.setAttribute('aria-pressed', String(theme === 'dark'));
  };
  apply(localStorage.getItem('nss-theme') === 'dark' ? 'dark' : 'light');
  button.addEventListener('click', () => {
    const theme = shell.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('nss-theme', theme);
    apply(theme);
  });
}

function bindFormValidation() {
  const shell = document;
  const update = input => {
    if (!input?.matches('input, textarea, select')) return;
    const field = input.closest('.cc-field');
    if (!field || !input.classList.contains('was-touched')) return;
    let error = field.querySelector('.field-error');
    if (input.validity.valid) { error?.remove(); return; }
    if (!error) { error = document.createElement('small'); error.className = 'field-error'; field.appendChild(error); }
    error.textContent = input.validity.valueMissing ? ccText('This field is required.', '此项为必填。') : input.validity.tooShort ? ccText(`Enter at least ${input.minLength} characters.`, `至少输入 ${input.minLength} 个字符。`) : input.validationMessage;
  };
  shell.addEventListener('focusout', event => { if (event.target?.matches('input, textarea, select')) { event.target.classList.add('was-touched'); update(event.target); } });
  shell.addEventListener('input', event => update(event.target));
  shell.addEventListener('change', event => update(event.target));
}

// =================== 侧栏抽屉（移动端） ===================
function openNav() { $('#appShell')?.classList.add('nav-open'); }
function closeNav() { $('#appShell')?.classList.remove('nav-open'); }

function bindNavDrawer() {
  $('#navToggle')?.addEventListener('click', () => {
    if ($('#appShell').classList.contains('nav-open')) closeNav(); else openNav();
  });
  $('#navBackdrop')?.addEventListener('click', closeNav);
  // 横竖屏 / 窗口尺寸跨过断点时重绘：表格 ↔ 卡片列表
  const onMqChange = () => { closeNav(); if (state.me) renderScreen(); };
  if (mobileMq.addEventListener) mobileMq.addEventListener('change', onMqChange);
  else if (mobileMq.addListener) mobileMq.addListener(onMqChange);
}

/** 各屏 → 顶部栏标题的 i18n key（2026-09-24 浅色改版：顶部栏左侧显示当前页面名） */
const SCREEN_NAV_KEY = {
  dashboard: 'nav.dashboard', reports: 'nav.reports', storeBiz: 'nav.storeBiz', memberBiz: 'nav.memberBiz',
  stores: 'nav.stores', members: 'nav.members', rules: 'nav.rules', mall: 'nav.mall',
  approvals: 'nav.approvals', controlCenter: 'nav.controlCenter', sheets: 'nav.sheets', db: 'nav.db', audit: 'nav.audit',
  accounts: 'nav.accounts', account: 'nav.account',
};

/** 顶部栏标题跟随当前屏 + 当前语言（语言切换后需再调一次） */
function updateHeaderCrumb() {
  const el = $('#headerTitle');
  if (!el) return;
  const key = SCREEN_NAV_KEY[state.screen];
  const workspace = { approvals: ccText('Approval Center', '审批中心'), collaboration: ccText('Tasks & notifications', '任务协作'), storeops: ccText('Store follow-up', '门店跟进'), announcements: ccText('Announcements', '内容公告'), governance: ccText('Settings', '设置') };
  const label = state.screen === 'controlCenter' ? workspace[state.ccWorkspace] : (key ? t(key) : '');
  if (!label) { el.textContent = ''; return; }
  el.innerHTML = `<button type="button" class="crumb-home" data-crumb-home>${ccText('Control Platform', '中控平台')}</button><span aria-hidden="true">/</span><span>${escapeHtml(label)}</span>`;
  el.querySelector('[data-crumb-home]')?.addEventListener('click', () => { state.ccWorkspace = 'overview'; setScreen('controlCenter'); });
}

function setScreen(name) {
  // 兜底拦截：侧栏入口虽然隐藏了，但如果页面结构被改动、或账号切换后没重绘，
  // 仍可能走到这里 —— 无权限时一律回落到仪表盘。
  if (!canAccessScreen(name)) name = homeScreen();
  state.screen = name;
  $$('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.screen === name);
  });
  updateHeaderCrumb();
  updateSyncChip();
  renderScreen();
}

async function renderScreen() {
  if (state.me?.mustChangePassword) { renderMandatoryPasswordChange(); return; }
  stopSheetsLive();
  if (!canAccessScreen(state.screen)) state.screen = homeScreen();
  const root = $('#content');
  root.innerHTML = state.screen === 'controlCenter' ? `<div class="cc-loading" role="status" aria-label="${ccText('Loading control center', '正在加载中控平台')}"><div class="cc-loading-title"></div><div class="cc-loading-kpis">${'<div class="cc-loading-card"></div>'.repeat(4)}</div><div class="cc-loading-panel"></div></div>` : `<div class="card" style="text-align:center;color:#9AA8A2;padding:40px;">${t('common.loading')}</div>`;
  try {
    if (state.screen === 'dashboard') await renderDashboard(root);
    else if (state.screen === 'members') await renderMembers(root);
    else if (state.screen === 'rules') await renderRules(root);
    else if (state.screen === 'stores') await renderStores(root);
    else if (state.screen === 'mall') await renderMall(root);
    else if (state.screen === 'approvals') await renderApprovals(root);
    else if (state.screen === 'controlCenter') await renderControlCenter(root);
    else if (state.screen === 'sheets') await renderSheets(root);
    else if (state.screen === 'reports') await renderReports(root);
    else if (state.screen === 'storeBiz') await renderStoreBiz(root);
    else if (state.screen === 'memberBiz') await renderMemberBiz(root);
    else if (state.screen === 'db') await renderDb(root);
    else if (state.screen === 'audit') await renderAudit(root);
    else if (state.screen === 'accounts') await renderAccounts(root);
    else if (state.screen === 'account') renderAccount(root);
  } catch (e) {
    root.innerHTML = `<div class="card"><p>${t('common.loadFailed', { msg: escapeHtml(e.message) })}</p><button class="btn btn-primary" type="button" id="screenRetry">${ccText('Retry', '重试')}</button></div>`;
    root.querySelector('#screenRetry').addEventListener('click', () => { renderScreen(); });
  }
}

// =================== 积分审核（2026-09-19 上线） ===================
// 店长提交的新增积分在这里等管理员批准。通过之前不写流水、不计余额。

const CONTROL_TYPES = {
  purchase: ['Purchase request', '采购申请'], expense: ['Expense reimbursement', '费用报销'],
  payment: ['Payment request', '付款申请'], transfer: ['Stock transfer', '库存调拨'],
  stocktake: ['Stocktake', '库存盘点'], stock_adjustment: ['Stock adjustment', '库存调整'],
  price_adjustment: ['Price adjustment', '价格调整'], store_remediation: ['Store remediation', '门店整改'],
};
const ACTIVE_CONTROL_TYPES = {
  stocktake: CONTROL_TYPES.stocktake, store_remediation: CONTROL_TYPES.store_remediation,
};
const CONTROL_FIELDS = [
  ['warehouseName', 'Warehouse name', '仓库名称（手动填写）', 'text'],
  ['batchNumber', 'Stocktake batch', '盘点批次/编号', 'text'],
  ['countArea', 'Count area', '盘点区域', 'text'],
  ['counterName', 'Counted by', '盘点人', 'text'],
  ['storeName', 'Store name', '门店名称（手动填写）', 'text'],
  ['countDate', 'Count date', '盘点日期', 'date'],
  ['issue', 'Issue to correct', '整改问题', 'text'],
  ['dueDate', 'Due date', '整改期限', 'date'],
  ['assigneeId', 'Responsible person', '整改负责人（账号）', 'select'],
  ['reason', 'Reason / details', '原因 / 说明', 'textarea'],
];
const CONTROL_FIELDS_BY_TYPE = {
  stocktake: ['warehouseName','batchNumber','countArea','counterName','countDate','reason'],
  store_remediation: ['storeName','issue','dueDate','assigneeId','reason'],
};
const ccText = (en, zh) => String(locale()).toLowerCase().startsWith('zh') ? zh : en;
const ccStatus = s => ({ pending_approval: ccText('Pending approval', '待审批'), approved: ccText('Approved', '已批准'), rejected: ccText('Rejected', '已驳回'), returned: ccText('Returned for changes', '退回修改'), execution_pending: ccText('Execution in progress', '整改中'), awaiting_review: ccText('Awaiting review', '待复查'), completed: ccText('Completed', '已完成'), cancelled: ccText('Cancelled', '已撤回'), open: ccText('Open', '待处理'), in_progress: ccText('In progress', '进行中') }[s] || s);
const ccStatusTone = s => ({ pending_approval: 'warning', open: 'warning', returned: 'warning', approved: 'brand', execution_pending: 'brand', awaiting_review: 'warning', in_progress: 'brand', completed: 'success', published: 'success', rejected: 'danger', cancelled: 'neutral', draft: 'neutral', closed: 'success' }[s] || 'neutral');
const ccStatusBadge = (status, label = ccStatus(status)) => `<span class="cc-status cc-status-${ccStatusTone(status)}"><i aria-hidden="true"></i>${escapeHtml(label)}</span>`;
function ccDueBadge(value) {
  if (!value) return '';
  const due = new Date(value), hours = (due.getTime() - Date.now()) / 3600000;
  if (!Number.isFinite(hours)) return '';
  const tone = hours < 0 ? 'danger' : hours <= 24 ? 'warning' : 'neutral';
  const label = hours < 0 ? ccText(`Overdue ${Math.max(1, Math.ceil(-hours / 24))} d`, `已逾期 ${Math.max(1, Math.ceil(-hours / 24))} 天`) : hours <= 24 ? ccText(`${Math.max(1, Math.ceil(hours))} h left`, `剩余 ${Math.max(1, Math.ceil(hours))} 小时`) : ccText(`${Math.ceil(hours / 24)} d left`, `剩余 ${Math.ceil(hours / 24)} 天`);
  return `<span class="cc-due cc-status-${tone}"><i aria-hidden="true"></i>${label}</span>`;
}
function ccPageSummary(data) {
  if (!Number(data?.total)) return '';
  const first = Number(data.offset || 0) + 1, last = Math.min(first + Number(data.limit || 25) - 1, Number(data.total));
  return ccText(`Showing ${first}–${last} of ${data.total}`, `显示 ${first}–${last} 条，共 ${data.total} 条`);
}
function ccPagerButtons(kind, data) {
  const total = Number(data?.total || 0), limit = Number(data?.limit || 25), page = Math.floor(Number(data?.offset || 0) / limit) + 1, pages = Math.ceil(total / limit);
  if (!total || pages <= 1) return '';
  const from = Math.max(1, Math.min(page - 2, pages - 4)), to = Math.min(pages, from + 4);
  return `<button type="button" class="btn btn-sm" data-${kind}-page="prev" ${page === 1 ? 'disabled' : ''}>‹</button>${Array.from({ length: to - from + 1 }, (_, i) => from + i).map(n => `<button type="button" class="btn btn-sm ${n === page ? 'active' : ''}" data-${kind}-page="${n}" ${n === page ? 'aria-current="page"' : ''}>${n}</button>`).join('')}<button type="button" class="btn btn-sm" data-${kind}-page="next" ${page === pages ? 'disabled' : ''}>›</button>`;
}
function ccEmptyState(title, detail, action = '', kind = '') {
  return `<div class="card cc-empty-state"><span class="cc-empty-icon" aria-hidden="true">◇</span><strong>${title}</strong><span>${detail}</span>${action && kind ? `<button type="button" class="btn btn-primary btn-sm" data-cc-quick="${kind}">${action}</button>` : ''}</div>`;
}
function uiStat(label, value, tone, note = '') {
  const n = value == null ? NaN : Number(value);
  return `<div class="cc-detail-stat cc-tone-${Number.isFinite(n) ? tone : 'error'}"><span>${label}</span><strong>${Number.isFinite(n) ? n.toLocaleString() : ccText('Unavailable', '读取失败')}</strong>${note ? `<small>${note}</small>` : ''}</div>`;
}

function stocktakeCsv(items = []) {
  const columns = [
    ['itemCode', '商品编码'], ['itemName', '商品名称'], ['location', '库位'],
    ['systemQuantity', '账面数量'], ['countedQuantity', '实盘数量'], ['recountedQuantity', '复盘数量'],
    ['differenceQuantity', '差异数量'], ['varianceReason', '差异原因'], ['remark', '备注'],
  ];
  const quote = value => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
  return `\uFEFF${columns.map(x => quote(x[1])).join(',')}\r\n${items.map(item => columns.map(([key]) => {
    if (key !== 'differenceQuantity') return quote(item[key]);
    const system = item.systemQuantity == null || item.systemQuantity === '' ? null : Number(item.systemQuantity);
    const actualRaw = item.recountedQuantity == null || item.recountedQuantity === '' ? item.countedQuantity : item.recountedQuantity;
    const actual = actualRaw == null || actualRaw === '' ? null : Number(actualRaw);
    return quote(system == null || actual == null || !Number.isFinite(system) || !Number.isFinite(actual) ? '' : Math.round((actual - system) * 1000000) / 1000000);
  }).join(',')).join('\r\n')}`;
}

function stocktakeSourceMime(file) {
  return ({ xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', xlsm: 'application/vnd.ms-excel.sheet.macroenabled.12', xlsb: 'application/vnd.ms-excel.sheet.binary.macroenabled.12', csv: 'text/csv' })[String(file.name || '').split('.').pop().toLowerCase()];
}

function downloadStocktakeCsv(items, filename) {
  const blob = new Blob([stocktakeCsv(items)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename || 'NSS-Solar-stocktake.csv';
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

function uploadMimeType(file) {
  const extension = String(file.name || '').split('.').pop().toLowerCase();
  return ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', xlsm: 'application/vnd.ms-excel.sheet.macroenabled.12', xlsb: 'application/vnd.ms-excel.sheet.binary.macroenabled.12' }[extension] || file.type || 'application/octet-stream');
}

function readFileAsDataUrl(file, mimeType) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const match = String(reader.result || '').match(/^data:[^,]*;base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) { reject(new Error(ccText('Could not read file', '无法读取文件'))); return; }
      resolve(`data:${mimeType};base64,${match[1]}`);
    };
    reader.onerror = () => reject(new Error(ccText('Could not read file', '无法读取文件')));
    reader.readAsDataURL(file);
  });
}

function createStocktakeEditor(container, initialRows = [], initialSourceName = '') {
  if (!container) return null;
  const pageSize = 100; let rows = Array.isArray(initialRows) ? initialRows.map(x => ({ ...x })) : [];
  let page = 0, sourceFile = null, error = '';
  const setError = message => { error = message || ''; const el = $('[data-stocktake-error]', container); if (el) el.textContent = error; };
  const differenceFor = row => {
    if (row.systemQuantity == null || String(row.systemQuantity).trim() === '') return '—';
    const raw = row.recountedQuantity == null || String(row.recountedQuantity).trim() === '' ? row.countedQuantity : row.recountedQuantity;
    if (raw == null || String(raw).trim() === '') return '—';
    const difference = Number(raw) - Number(row.systemQuantity);
    return Number.isFinite(difference) ? String(Number(difference.toFixed(6))) : '—';
  };
  const render = () => {
    const pages = Math.max(1, Math.ceil(rows.length / pageSize)); page = Math.min(page, pages - 1);
    const shown = rows.slice(page * pageSize, (page + 1) * pageSize);
    container.innerHTML = `
      <div class="cc-stocktake-toolbar">
        <strong>${ccText('Stocktake spreadsheet', '盘点表格')}</strong>
        <button type="button" class="btn btn-sm" data-stocktake-template>${ccText('Optional manual-line template', '下载可选明细模板')}</button>
      </div>
      <label class="cc-upload-zone" data-stocktake-drop><span aria-hidden="true">⇧</span><strong>${ccText('Drop an Excel / CSV file here, or click to choose', '拖入 Excel / CSV，或点击选择文件')}</strong><small>${ccText('Any layout · original file kept · up to 10 MB', '任意排版 · 保存原文件 · 不超过 10MB')}</small><input type="file" accept=".xlsx,.xls,.xlsm,.xlsb,.csv" data-stocktake-file/></label>
      <div class="cc-stocktake-help"><span>✓ ${ccText('No header or column check', '不检查表头和列格式')}</span><span>✓ ${ccText('Approvers can download the original', '审批人可下载原文件')}</span><button type="button" class="btn btn-sm" data-stocktake-add>${ccText('Add optional manual line', '可选：手动添加明细')}</button></div>
      ${(sourceFile || initialSourceName) ? `<div class="cc-meta">${ccText('Selected file', '已选表格')}: ${escapeHtml(sourceFile?.name || initialSourceName)}${!sourceFile && initialSourceName ? ` · ${ccText('Already attached', '已作为附件保存')}` : ''}</div>` : ''}
      ${rows.length ? `<div class="cc-meta">${ccText('Optional manual lines', '可选手动明细')} (${rows.length})</div>` : ''}
      <div class="cc-meta" data-stocktake-error role="alert">${escapeHtml(error)}</div>
      <div class="cc-stocktake-scroll" ${rows.length ? '' : 'hidden'}><table class="cc-stocktake-table"><thead><tr><th>${ccText('Item code*', '商品编码*')}</th><th>${ccText('Item name', '商品名称')}</th><th>${ccText('Bin', '库位')}</th><th>${ccText('Book qty', '账面数量')}</th><th>${ccText('Counted qty*', '实盘数量*')}</th><th>${ccText('Recount qty', '复盘数量')}</th><th>${ccText('Difference', '差异数量')}</th><th>${ccText('Variance reason', '差异原因')}</th><th>${ccText('Remark', '备注')}</th><th></th></tr></thead><tbody>${shown.length ? shown.map((row, i) => { const idx = page * pageSize + i; return `<tr><td><input data-stocktake-row="${idx}" data-stocktake-field="itemCode" value="${escapeHtml(row.itemCode || '')}" maxlength="80"/></td><td><input data-stocktake-row="${idx}" data-stocktake-field="itemName" value="${escapeHtml(row.itemName || '')}" maxlength="180"/></td><td><input data-stocktake-row="${idx}" data-stocktake-field="location" value="${escapeHtml(row.location || '')}" maxlength="80"/></td><td><input data-stocktake-row="${idx}" data-stocktake-field="systemQuantity" value="${escapeHtml(row.systemQuantity ?? '')}" inputmode="decimal"/></td><td><input data-stocktake-row="${idx}" data-stocktake-field="countedQuantity" value="${escapeHtml(row.countedQuantity ?? '')}" inputmode="decimal"/></td><td><input data-stocktake-row="${idx}" data-stocktake-field="recountedQuantity" value="${escapeHtml(row.recountedQuantity ?? '')}" inputmode="decimal"/></td><td><span class="cc-stocktake-difference">${escapeHtml(differenceFor(row))}</span></td><td><input data-stocktake-row="${idx}" data-stocktake-field="varianceReason" value="${escapeHtml(row.varianceReason || '')}" maxlength="500"/></td><td><input data-stocktake-row="${idx}" data-stocktake-field="remark" value="${escapeHtml(row.remark || '')}" maxlength="500"/></td><td><button type="button" class="btn btn-sm btn-danger" data-stocktake-remove="${idx}" aria-label="${ccText('Remove line', '删除行')}">×</button></td></tr>`; }).join('') : `<tr><td colspan="10" class="cc-stocktake-empty">${ccText('Upload a spreadsheet above, or add manual lines if needed.', '可直接上传上方表格；需要时也可手动添加明细。')}</td></tr>`}</tbody></table></div>
      <div class="cc-stocktake-pager" ${rows.length ? '' : 'hidden'}><span>${ccText(`Page ${page + 1} of ${pages}`, `第 ${page + 1} / ${pages} 页`)}</span><div class="cc-actions"><button type="button" class="btn btn-sm" data-stocktake-prev ${page <= 0 ? 'disabled' : ''}>‹</button><button type="button" class="btn btn-sm" data-stocktake-next ${page >= pages - 1 ? 'disabled' : ''}>›</button></div></div>`;
  };
  container.addEventListener('input', event => {
    const input = event.target.closest('[data-stocktake-row][data-stocktake-field]'); if (!input) return;
    const row = rows[Number(input.dataset.stocktakeRow)]; if (row) row[input.dataset.stocktakeField] = input.value;
    const difference = input.closest('tr')?.querySelector('.cc-stocktake-difference');
    if (row && difference) difference.textContent = differenceFor(row);
  });
  container.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.hasAttribute('data-stocktake-template')) { downloadStocktakeCsv([], 'NSS-Solar-optional-stocktake-lines.csv'); return; }
    if (button.hasAttribute('data-stocktake-add')) { if (rows.length >= 2000) { setError(ccText('A stocktake can contain up to 2,000 manual lines.', '每张盘点单最多手动添加 2,000 行。')); return; } const insertAt = Math.min((page + 1) * pageSize, rows.length); rows.splice(insertAt, 0, { itemCode: '', itemName: '', location: '', systemQuantity: '', countedQuantity: '', recountedQuantity: '', varianceReason: '', remark: '' }); page = Math.floor(insertAt / pageSize); render(); }
    else if (button.hasAttribute('data-stocktake-remove')) { rows.splice(Number(button.dataset.stocktakeRemove), 1); render(); }
    else if (button.hasAttribute('data-stocktake-prev')) { page = Math.max(0, page - 1); render(); }
    else if (button.hasAttribute('data-stocktake-next')) { page = Math.min(Math.ceil(rows.length / pageSize) - 1, page + 1); render(); }
  });
  const chooseFile = file => {
    if (!stocktakeSourceMime(file)) { setError(ccText('Choose an Excel or CSV file.', '请选择 Excel 或 CSV 文件。')); return; }
    if (!file.size || file.size > 10 * 1024 * 1024) { setError(ccText('The file must be between 1 byte and 10 MB.', '文件大小须在 1 字节至 10MB 之间。')); return; }
    sourceFile = file; rows = []; page = 0; setError(''); render();
  };
  container.addEventListener('change', event => {
    const input = event.target.closest('[data-stocktake-file]'); if (!input || !input.files?.[0]) return;
    chooseFile(input.files[0]);
  });
  container.addEventListener('dragover', event => { if (!event.target.closest('[data-stocktake-drop]')) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; event.target.closest('[data-stocktake-drop]').classList.add('dragover'); });
  container.addEventListener('dragleave', event => { event.target.closest('[data-stocktake-drop]')?.classList.remove('dragover'); });
  container.addEventListener('drop', event => { const zone = event.target.closest('[data-stocktake-drop]'); if (!zone) return; event.preventDefault(); zone.classList.remove('dragover'); if (event.dataTransfer.files?.[0]) chooseFile(event.dataTransfer.files[0]); });
  render();
  return {
    getRows: () => rows.filter(row => Object.values(row).some(value => String(value ?? '').trim() !== '')).map(row => ({
      itemCode: String(row.itemCode || '').trim(), itemName: String(row.itemName || '').trim(), location: String(row.location || '').trim(),
      systemQuantity: row.systemQuantity == null || String(row.systemQuantity).trim() === '' ? null : Number(row.systemQuantity),
      countedQuantity: row.countedQuantity == null || String(row.countedQuantity).trim() === '' ? null : Number(row.countedQuantity),
      recountedQuantity: row.recountedQuantity == null || String(row.recountedQuantity).trim() === '' ? null : Number(row.recountedQuantity),
      varianceReason: String(row.varianceReason || '').trim(),
      remark: String(row.remark || '').trim(),
    })),
    getSourceFile: () => sourceFile,
  };
}

async function renderControlCenter(root) {
  const mayViewWorkflows = can('workflow.view'), mayViewTasks = can('task.view');
  const mayViewOrg = can('org.view');
  const workflowQuery = new URLSearchParams({ limit: '25', offset: String(state.workflowOffset || 0) });
  if (state.workflowFilters?.status) workflowQuery.set('status', state.workflowFilters.status);
  if (state.workflowFilters?.type) workflowQuery.set('type', state.workflowFilters.type);
  if (state.workflowFilters?.q) workflowQuery.set('q', state.workflowFilters.q);
  if (state.workflowFilters?.actionable) workflowQuery.set('actionable', '1');
  const taskQuery = new URLSearchParams({ limit: '25', offset: String(state.taskOffset || 0) });
  if (state.taskFilters?.status) taskQuery.set('status', state.taskFilters.status);
  if (state.taskFilters?.priority) taskQuery.set('priority', state.taskFilters.priority);
  if (state.taskFilters?.storeId) taskQuery.set('storeId', state.taskFilters.storeId);
  if (state.taskFilters?.q) taskQuery.set('q', state.taskFilters.q);
  const notificationQuery = new URLSearchParams({ limit: '25', offset: String(state.notificationOffset || 0) });
  const auditQuery = new URLSearchParams({ limit: '25', offset: String(state.ccAuditOffset || 0) });
  if (state.ccAuditFilters?.q) auditQuery.set('q', state.ccAuditFilters.q);
  if (state.ccAuditFilters?.from) auditQuery.set('from', state.ccAuditFilters.from);
  if (state.ccAuditFilters?.to) auditQuery.set('to', state.ccAuditFilters.to);
  const storeOperationQuery = new URLSearchParams({ limit: '10', reportsOffset: String(state.storeOperationOffsets?.reports || 0), inspectionsOffset: String(state.storeOperationOffsets?.inspections || 0), issuesOffset: String(state.storeOperationOffsets?.issues || 0) });
  const [workflowData, definitionData, taskData, orgData, employeeData, noticeData, storeData, assigneeData, auditData, operationData, accountData, announcementData, recentWorkflowData, recentTaskData] = await Promise.all([
    mayViewWorkflows ? GET(`/api/v2/workflows?${workflowQuery.toString()}`) : Promise.resolve({ items: [], total: 0, offset: 0, limit: 25, counts: {} }),
    can('workflow.configure') ? GET('/api/v2/workflows/definitions') : Promise.resolve({ items: [] }),
    mayViewTasks ? GET(`/api/v2/tasks?${taskQuery.toString()}`) : Promise.resolve({ items: [], total: 0, offset: 0, limit: 25, counts: {} }),
    mayViewOrg ? GET('/api/v2/organizations') : Promise.resolve({ items: [] }),
    can('staff.view') ? GET('/api/v2/employees') : Promise.resolve({ items: [] }),
    GET(`/api/v2/notifications?${notificationQuery.toString()}`),
    can('store.view') ? GET('/api/stores').catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
    can('task.assign') ? GET('/api/v2/task-assignees') : Promise.resolve({ items: [] }),
    can('system.audit.view') ? GET(`/api/v2/audit-events?${auditQuery.toString()}`) : Promise.resolve({ items: [], total: 0, offset: 0, limit: 25 }),
    can('store.view') ? GET(`/api/v2/store-operations?${storeOperationQuery.toString()}`) : Promise.resolve({ reports: [], inspections: [], issues: [], pages: {} }),
    can('workflow.configure') && can('system.user.view') ? GET('/api/users').catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
    GET('/api/v2/announcements?includeDrafts=1'),
    mayViewWorkflows ? GET('/api/v2/workflows?limit=10&offset=0') : Promise.resolve({ items: [] }),
    mayViewTasks ? GET('/api/v2/tasks?limit=10&offset=0') : Promise.resolve({ items: [] }),
  ]);
  if (mayViewWorkflows) state.workflowOffset = Number(workflowData.offset || 0);
  if (mayViewTasks) state.taskOffset = Number(taskData.offset || 0);
  state.notificationOffset = Number(noticeData.offset || 0);
  state.ccAuditOffset = Number(auditData.offset || 0);
  for (const key of ['reports','inspections','issues']) if (operationData.pages?.[key]) state.storeOperationOffsets[key] = Number(operationData.pages[key].offset || 0);
  const allWorkflows = workflowData.items || [], workflows = allWorkflows.filter(item => ACTIVE_CONTROL_TYPES[item.type]), archivedWorkflows = allWorkflows.filter(item => !ACTIVE_CONTROL_TYPES[item.type]);
  const tasks = taskData.items || [], orgs = orgData.items || [];
  const definitions = definitionData.items || [];
  const employees = employeeData.items || [], notices = noticeData.items || [], stores = storeData.items || [];
  const announcements = announcementData.items || [];
  const leadAnnouncement = announcements.find(x => x.status === 'published');
  const approverAccounts = (accountData.items || []).filter(x => !x.disabled);
  const remediationCounts = workflowData.countsByType?.store_remediation || {};
  const openRemediationCount = ['pending_approval','returned','approved','execution_pending','awaiting_review'].reduce((sum, status) => sum + Number(remediationCounts[status] || 0), 0);
  const metric = (label, value, area, tone, actionable = false) => {
    const failed = !Number.isFinite(value), empty = value === 0;
    return `<button type="button" class="card cc-overview-card cc-tone-${failed ? 'error' : empty ? 'success' : tone}" ${failed ? 'data-cc-retry' : `data-cc-jump="${area}" ${actionable ? 'data-cc-actionable-jump' : ''}`}><span>${label}</span><strong>${failed ? ccText('Unavailable', '读取失败') : value.toLocaleString()}</strong><small>${failed ? ccText('Retry', '重试加载') : empty ? ccText('✓ Clear', '✓ 已清空') : ccText('Open details', '查看详情') + ' →'}</small></button>`;
  };
  const count = value => value == null || !Number.isFinite(Number(value)) ? NaN : Number(value);
  const recentMatters = [
    ...(recentWorkflowData.items || []).filter(w => ACTIVE_CONTROL_TYPES[w.type]).map(w => ({ title: w.title, type: ccText('Approval', '审批'), status: ccStatus(w.status), area: 'approvals', date: w.updatedAt || w.createdAt })),
    ...(recentTaskData.items || []).map(task => ({ title: task.title, type: ccText('Task', '任务'), status: ccStatus(task.status), area: 'collaboration', date: task.updatedAt || task.createdAt })),
  ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 5);
  const formattedDate = value => {
    const date = new Date(value), diff = Date.now() - date.getTime();
    if (Number.isNaN(date.getTime())) return '';
    if (diff < 0 || diff >= 7 * 86400000) return date.toLocaleDateString();
    if (diff < 60000) return ccText('Just now', '刚刚');
    if (diff < 3600000) return `${Math.floor(diff / 60000)} ${ccText('min ago', '分钟前')}`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} ${ccText('h ago', '小时前')}`;
    return `${Math.floor(diff / 86400000)} ${ccText('d ago', '天前')}`;
  };
  const assignees = assigneeData.items || [];
  const auditEvents = auditData.items || [];
  const storeReports = operationData.reports || [], storeInspections = operationData.inspections || [], storeIssues = operationData.issues || [];
  const stat = uiStat;
  const taskCounts = taskData.counts || {};
  const activeWorkflowTotal = Object.keys(ACTIVE_CONTROL_TYPES).reduce((sum, type) => sum + Object.values(workflowData.countsByType?.[type] || {}).reduce((n, v) => n + Number(v || 0), 0), 0);
  const activeWorkflowStatusCount = status => Object.keys(ACTIVE_CONTROL_TYPES).reduce((sum, type) => sum + Number(workflowData.countsByType?.[type]?.[status] || 0), 0);
  const workspaceStats = {
    approvals: mayViewWorkflows ? [stat(ccText('My pending approvals', '待我审批'), workflowData.pendingForMe, 'warning'), stat(ccText('Current process requests', '当前流程申请'), workflowData.countsByType ? activeWorkflowTotal : null, 'brand'), stat(ccText('Completed', '已完成'), workflowData.countsByType ? activeWorkflowStatusCount('completed') : null, 'success'), stat(ccText('Returned or rejected', '退回或驳回'), workflowData.countsByType ? activeWorkflowStatusCount('returned') + activeWorkflowStatusCount('rejected') : null, 'danger')].join('') : '',
    collaboration: mayViewTasks ? [stat(ccText('Open', '待处理'), taskCounts.open, 'warning'), stat(ccText('In progress', '进行中'), taskCounts.in_progress, 'brand'), stat(ccText('Completed', '已完成'), taskCounts.completed, 'success'), stat(ccText('Cancelled', '已取消'), taskCounts.cancelled, 'neutral')].join('') : '',
    announcements: [stat(ccText('Published', '已发布'), announcements.filter(x => x.status === 'published').length, 'success'), stat(ccText('Pinned', '置顶中'), announcements.filter(x => x.status === 'published' && x.pinned).length, 'brand'), ...(can('announcement.manage') ? [stat(ccText('Drafts', '草稿'), announcements.filter(x => x.status === 'draft').length, 'warning')] : [])].join(''),
    storeops: [stat(ccText('Daily reports', '每日汇报'), operationData.pages?.reports?.total, 'brand'), stat(ccText('Inspections', '巡检记录'), operationData.pages?.inspections?.total, 'success'), stat(ccText('Historical issues', '历史问题'), operationData.pages?.issues?.total, 'neutral')].join(''),
    governance: [mayViewOrg ? stat(ccText('Organizations', '组织单位'), orgs.length, 'brand') : '', can('staff.view') ? stat(ccText('Employees', '员工档案'), employees.length, 'neutral') : '', can('workflow.configure') ? stat(ccText('Approval routes', '审批路径'), definitions.length, 'warning') : '', can('system.audit.view') ? stat(ccText('Audit events', '审计事件'), auditData.total, 'success') : ''].join(''),
  };
  const storeOperationPager = key => {
    const page = operationData.pages?.[key] || { offset: 0, limit: 10, total: 0 };
    return `<div class="cc-actions cc-workflow-pager"><span class="cc-meta">${ccPageSummary(page)}</span>${page.total > page.limit ? `<button type="button" class="btn btn-sm" data-store-operation-page="${key}:prev" ${page.offset <= 0 ? 'disabled' : ''}>${ccText('Previous', '上一页')}</button><button type="button" class="btn btn-sm" data-store-operation-page="${key}:next" ${page.offset + page.limit >= page.total ? 'disabled' : ''}>${ccText('Next', '下一页')}</button>` : ''}</div>`;
  };
  const renderStoreOperationAttachments = (kind, item) => `${(item.attachments || []).map(a => `<div class="cc-meta"><a href="/api/v2/store-operations/${kind}/${encodeURIComponent(item.id)}/attachments/${encodeURIComponent(a.id)}/download">${escapeHtml(a.name)}</a> · ${Math.ceil(Number(a.size || 0) / 1024)} KB · ${escapeHtml(a.uploadedByName || '')}</div>`).join('')}${can('task.create') ? `<form class="cc-inline-form" data-store-operation-attachment="${kind}:${escapeHtml(item.id)}"><input name="attachments" type="file" multiple accept="application/pdf,image/png,image/jpeg"/><button class="btn btn-sm">${ccText('Upload evidence', '上传凭证')}</button></form>` : ''}`;
  const renderStoreReportCard = report => { const additionalNote = report.additionalNote || report.salesNote || ''; return `<article class="card cc-card"><div class="cc-card-top"><strong>${escapeHtml(report.reportDate)} · ${escapeHtml(stores.find(s => s.id === report.storeId)?.name || '')}</strong><span class="cc-meta">${escapeHtml(report.createdByName || '')}</span></div><div>${escapeHtml(report.summary || additionalNote || report.incidents || '')}</div>${additionalNote && report.summary ? `<div class="cc-meta">${escapeHtml(additionalNote)}</div>` : ''}${report.incidents ? `<div class="cc-meta">${ccText('Incidents', '异常')}：${escapeHtml(report.incidents)}</div>` : ''}${renderStoreOperationAttachments('report', report)}</article>`; };
  const renderStoreInspectionCard = inspection => `<article class="card cc-card"><div class="cc-card-top"><strong>${escapeHtml(inspection.inspectionDate)} · ${escapeHtml(stores.find(s => s.id === inspection.storeId)?.name || '')} · ${escapeHtml(ccStatus(inspection.result))}</strong><span class="cc-meta">${escapeHtml(inspection.createdByName || '')}${inspection.score != null ? ` · ${ccText('Score', '评分')} ${inspection.score}` : ''}</span></div>${inspection.checklist ? `<div class="cc-meta">${ccText('Checklist', '检查清单')}：${escapeHtml(inspection.checklist)}</div>` : ''}${inspection.findings ? `<div>${ccText('Findings', '发现问题')}：${escapeHtml(inspection.findings)}</div>` : ''}${inspection.remediationWorkflowId ? `<div class="cc-meta">${ccText('A remediation request has been linked', '已关联整改申请')} · ${escapeHtml(inspection.remediationWorkflowId)}</div>` : ''}${renderStoreOperationAttachments('inspection', inspection)}${can('workflow.create') && ['fail','attention'].includes(inspection.result) && !inspection.remediationWorkflowId ? `<button type="button" class="btn btn-sm btn-primary" data-inspection-remediate="${escapeHtml(inspection.id)}">${ccText('Create remediation request', '发起门店整改')}</button>` : ''}</article>`;
  const workflowApprovalInfo = w => {
    const step = (w.approvalSteps || [])[w.currentStep]; if (!step || !state.me) return null;
    const signed = new Set((w.stepApprovals || []).filter(x => x.step === w.currentStep).map(x => x.approverKey));
    const delegations = (w.approvalDelegations || []).filter(x => x.step === w.currentStep);
    const delegated = delegations.find(x => x.userId === state.me.id && !signed.has(x.approverKey));
    const role = state.me.role === 'manager' ? 'store_manager' : state.me.role;
    const approver = (step.approvers || []).find(a => {
      const matches = a.kind === 'user' ? a.id === state.me.id : (a.id === role || (a.id === 'store_manager' && role === 'manager'));
      const key = `${a.kind}:${a.id}`;
      return matches && !signed.has(key) && !delegations.some(x => x.approverKey === key);
    });
    if (approver) return { key: `${approver.kind}:${approver.id}`, delegated: false };
    return delegated ? { key: delegated.approverKey, delegated: true } : null;
  };
  const canDelegateWorkflow = w => {
    if (!w.actionableForMe) return false;
    const info = workflowApprovalInfo(w); return !!info && !info.delegated;
  };
  const stocktakeDifference = item => {
    if (item.differenceQuantity != null) return item.differenceQuantity;
    const system = item.systemQuantity == null || item.systemQuantity === '' ? null : Number(item.systemQuantity);
    const actualRaw = item.recountedQuantity == null || item.recountedQuantity === '' ? item.countedQuantity : item.recountedQuantity;
    const actual = actualRaw == null || actualRaw === '' ? null : Number(actualRaw);
    return system == null || actual == null || !Number.isFinite(system) || !Number.isFinite(actual) ? '—' : Number((actual - system).toFixed(6));
  };
  const editFieldsHtml = (form, processType) => CONTROL_FIELDS.filter(([key]) => CONTROL_FIELDS_BY_TYPE[processType]?.includes(key) && (key !== 'assigneeId' || can('task.assign'))).map(([key, en, zh, type]) => {
    const value = form?.[key] == null ? '' : String(form[key]);
    if (key === 'assigneeId') return `<label class="cc-field"><span>${ccText(en, zh)}</span><select name="assigneeId"><option value="">${ccText('Unassigned', '暂不指派')}</option>${assignees.map(a => `<option value="${escapeHtml(a.id)}" ${a.id === value ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}</select></label>`;
    return `<label class="cc-field"><span>${ccText(en, zh)}</span>${type === 'textarea' ? `<textarea name="${key}" rows="2">${escapeHtml(value)}</textarea>` : `<input name="${key}" type="${type}" value="${escapeHtml(value)}" ${['amount','estimatedAmount','oldPrice','newPrice'].includes(key) ? 'min="0" step="0.01"' : ['quantity','countedQuantity'].includes(key) ? 'min="0.001" step="0.001"' : key === 'quantityDelta' ? 'step="0.001"' : ''}/>`}</label>`;
  }).join('');
  const flowCards = workflows.map(w => {
    const isCurrentApprover = !!w.actionableForMe;
    const canDiscussWorkflow = (can('workflow.create') && w.createdBy === state.me.id) || isCurrentApprover || (w.assigneeId === state.me.id && can('workflow.execute') && ['approved','execution_pending','awaiting_review'].includes(w.status));
    const canUploadRemediationEvidence = w.type === 'store_remediation' && w.assigneeId === state.me.id && can('workflow.execute') && ['approved','execution_pending','awaiting_review'].includes(w.status);
    const evidenceTypeOptions = canUploadRemediationEvidence ? `<option value="before">${ccText('Before correction', '整改前')}</option><option value="after">${ccText('After correction', '整改后')}</option><option value="supporting">${ccText('Supporting file', '其他凭证')}</option>` : `<option value="supporting">${ccText('Supporting file', '其他凭证')}</option>`;
    return `
    <article class="card cc-card" data-workflow-card data-workflow-status="${escapeHtml(w.status)}" data-workflow-type="${escapeHtml(w.type)}" data-workflow-search="${escapeHtml([w.title, w.createdByName, w.assigneeName, w.form?.storeName, w.form?.warehouseName, w.form?.issue, w.externalDocumentNumber].filter(Boolean).join(' '))}">
      <div class="cc-card-top"><strong>${escapeHtml(CONTROL_TYPES[w.type]?.[String(locale()).toLowerCase().startsWith('zh') ? 1 : 0] || w.type)} · ${escapeHtml(w.title)}</strong><span class="cc-card-statuses">${ccStatusBadge(w.status)}${w.status === 'pending_approval' ? ccDueBadge(w.approvalDueAt) : ''}</span></div>
      <div class="cc-meta">${escapeHtml(w.createdByName)} · ${escapeHtml(new Date(w.createdAt).toLocaleString())}${w.externalDocumentNumber ? ` · ${ccText('External ref', '外部单据号')}: ${escapeHtml(w.externalDocumentNumber)}` : ''}${w.assigneeName ? ` · ${ccText('Responsible', '整改负责人')}: ${escapeHtml(w.assigneeName)}` : ''}</div>
      <div class="cc-meta">${Object.entries(w.form || {}).filter(([key, value]) => key !== 'items' && value != null && String(value).trim() !== '').map(([key, value]) => `${escapeHtml(({warehouseName:'仓库',batchNumber:'批次',countArea:'区域',counterName:'盘点人',countDate:'盘点日期',sourceFileName:'盘点表格',storeName:'门店',issue:'问题',dueDate:'整改期限',reason:'说明'})[key] || key)}: ${escapeHtml(value)}`).join(' · ')}</div>
      ${w.type === 'stocktake' && Array.isArray(w.form?.items) && w.form.items.length ? `<details class="cc-history"><summary>${ccText('Review stocktake lines', '查看盘点明细')} (${w.form.items.length})</summary><div class="cc-stocktake-scroll"><table class="cc-stocktake-table"><thead><tr><th>${ccText('Item code', '商品编码')}</th><th>${ccText('Item name', '商品名称')}</th><th>${ccText('Bin', '库位')}</th><th>${ccText('Book', '账面')}</th><th>${ccText('Counted', '实盘')}</th><th>${ccText('Recount', '复盘')}</th><th>${ccText('Difference', '差异')}</th><th>${ccText('Reason', '原因')}</th><th>${ccText('Remark', '备注')}</th></tr></thead><tbody>${w.form.items.slice(0, 20).map(item => `<tr><td>${escapeHtml(item.itemCode || '')}</td><td>${escapeHtml(item.itemName || '')}</td><td>${escapeHtml(item.location || '')}</td><td>${escapeHtml(item.systemQuantity ?? '—')}</td><td>${escapeHtml(item.countedQuantity ?? '—')}</td><td>${escapeHtml(item.recountedQuantity ?? '—')}</td><td>${escapeHtml(stocktakeDifference(item))}</td><td>${escapeHtml(item.varianceReason || '')}</td><td>${escapeHtml(item.remark || '')}</td></tr>`).join('')}</tbody></table></div>${w.form.items.length > 20 ? `<div class="cc-meta">${ccText('First 20 lines are shown; download the full list.', '此处显示前 20 行，可下载完整明细。')}</div>` : ''}<button type="button" class="btn btn-sm" data-stocktake-export="${escapeHtml(w.id)}">${ccText('Download detail CSV', '下载完整盘点明细')}</button></details>` : ''}
      ${(w.comments || []).length ? `<details class="cc-history" open><summary>${ccText('Comments', '协作备注')} (${w.comments.length})</summary>${w.comments.map(c => `<div class="cc-meta"><strong>${escapeHtml(c.actorName || '')}</strong> · ${escapeHtml(new Date(c.createdAt).toLocaleString())}<div>${escapeHtml(c.comment || '')}</div></div>`).join('')}</details>` : ''}
      ${(w.attachments || []).length ? `<div class="cc-history"><strong>${ccText('Attachments', '凭证附件')}</strong>${w.attachments.map(a => `<div class="cc-meta"><a href="/api/v2/workflows/${encodeURIComponent(w.id)}/attachments/${encodeURIComponent(a.id)}/download">${escapeHtml(a.name)}</a> · ${escapeHtml(({before:'整改前',after:'整改后',supporting:'其他凭证'})[a.evidenceType || 'supporting'] || '')}${a.executionRound ? ` · ${ccText('Round', '第')} ${escapeHtml(a.executionRound)} ${ccText('evidence', '轮凭证')}` : ''} · ${Math.ceil(Number(a.size || 0) / 1024)} KB</div>`).join('')}</div>` : ''}
      ${w.type === 'store_remediation' && ['approved','execution_pending','awaiting_review'].includes(w.status) ? `<div class="cc-meta">${ccText('Upload both before and after evidence before submitting this remediation for review.', '整改提交复查前，需要同时上传整改前和整改后凭证。')}</div>` : ''}
      ${ACTIVE_CONTROL_TYPES[w.type] && !['rejected','cancelled','completed'].includes(w.status) && canDiscussWorkflow ? `<div class="cc-form-grid"><form data-v2-comment="${escapeHtml(w.id)}" class="cc-inline-form"><input name="comment" required maxlength="2000" placeholder="${ccText('Add a process comment', '添加流程备注')}"/><button class="btn btn-sm">${ccText('Comment', '备注')}</button></form><form data-v2-attachment="${escapeHtml(w.id)}" class="cc-inline-form">${w.type === 'store_remediation' ? `<select name="evidenceType">${evidenceTypeOptions}</select>` : `<input type="hidden" name="evidenceType" value="supporting"/>`}<input name="file" type="file" accept="application/pdf,image/png,image/jpeg,.csv,.xlsx,.xls,.xlsm,.xlsb" required/><button class="btn btn-sm">${w.type === 'store_remediation' ? ccText('Upload evidence', '上传凭证') : ccText('Upload attachment', '上传附件')}</button></form></div>` : ''}
      ${(w.history || []).length ? `<details class="cc-history"><summary>${ccText('Approval sign-off and history', '审批签署与流程记录')}</summary>${w.history.map(h => `<div class="cc-meta"><strong>${escapeHtml(h.actorName || '')}</strong> · ${escapeHtml(({submit:'已提交',approve:'已审批',reject:'已驳回',return:'已退回',delegate:'已转交审批',execution:'已登记执行',review_pass:'复查通过',review_return:'退回整改',cancel:'已撤回',resubmit:'重新提交',comment:'添加备注','assignee.update':'调整负责人'})[h.action] || h.action)} · ${escapeHtml(new Date(h.createdAt).toLocaleString())}${h.note ? ` · ${escapeHtml(h.note)}` : ''}</div>`).join('')}</details>` : ''}
      <div class="cc-actions">
        ${ACTIVE_CONTROL_TYPES[w.type] && isCurrentApprover ? `<button class="btn btn-sm" data-v2-action="approve" data-v2-id="${escapeHtml(w.id)}">${ccText('Approve', '批准')}</button><button class="btn btn-sm" data-v2-action="return" data-v2-id="${escapeHtml(w.id)}">${ccText('Return for edits', '退回修改')}</button><button class="btn btn-sm btn-danger" data-v2-action="reject" data-v2-id="${escapeHtml(w.id)}">${ccText('Reject', '驳回')}</button>` : ''}
        ${ACTIVE_CONTROL_TYPES[w.type] && canDelegateWorkflow(w) ? `<button class="btn btn-sm" data-v2-delegate="${escapeHtml(w.id)}">${ccText('Delegate approval', '转交审批')}</button>` : ''}
        ${can('workflow.create') && ACTIVE_CONTROL_TYPES[w.type] && w.status === 'returned' && w.createdBy === state.me.id ? `<details class="cc-resubmit"><summary>${ccText('Edit and resubmit', '修改并重新提交')}</summary><form data-v2-resubmit="${escapeHtml(w.id)}"><label class="cc-field"><span>${ccText('Title', '标题')}</span><input name="title" maxlength="180" value="${escapeHtml(w.title)}"/></label><div class="cc-form-grid">${editFieldsHtml({ ...(w.form || {}), assigneeId: w.assigneeId || '' }, w.type)}</div>${w.type === 'stocktake' ? `<div class="cc-wide" data-stocktake-editor="${escapeHtml(w.id)}"></div>` : ''}<button class="btn btn-sm btn-primary">${ccText('Resubmit', '重新提交')}</button></form></details>` : ''}
        ${w.type === 'store_remediation' && can('task.assign') && ['approved','execution_pending'].includes(w.status) ? `<button class="btn btn-sm" data-v2-action="assign" data-v2-id="${escapeHtml(w.id)}">${ccText(w.assigneeId ? 'Change responsible person' : 'Assign responsible person', w.assigneeId ? '更换整改负责人' : '指派整改负责人')}</button>` : ''}
        ${ACTIVE_CONTROL_TYPES[w.type] && can('workflow.execute') && (w.type !== 'store_remediation' || w.assigneeId === state.me.id) && (w.status === 'approved' || w.status === 'execution_pending') ? `<button class="btn btn-sm btn-primary" data-v2-action="execution" data-v2-id="${escapeHtml(w.id)}">${ccText('Record execution', '登记执行')}</button>` : ''}
        ${w.type === 'store_remediation' && can('workflow.approve') && w.status === 'awaiting_review' && w.createdBy !== state.me.id && w.assigneeId !== state.me.id ? `<button class="btn btn-sm btn-primary" data-v2-action="review_pass" data-v2-id="${escapeHtml(w.id)}">${ccText('Confirm closure', '复查通过并关闭')}</button><button class="btn btn-sm" data-v2-action="review_return" data-v2-id="${escapeHtml(w.id)}">${ccText('Return for rework', '退回继续整改')}</button>` : ''}
        ${ACTIVE_CONTROL_TYPES[w.type] && can('workflow.create') && w.createdBy === state.me.id && ['pending_approval','approved'].includes(w.status) ? `<button class="btn btn-sm" data-v2-action="cancel" data-v2-id="${escapeHtml(w.id)}">${ccText('Withdraw', '撤回')}</button>` : ''}
      </div>
    </article>`;
  }).join('');
  const taskCards = tasks.map(x => {
    const checklist = Array.isArray(x.checklist) ? x.checklist : [];
    const comments = Array.isArray(x.comments) ? x.comments : [];
    const attachments = Array.isArray(x.attachments) ? x.attachments : [];
    const completedCount = checklist.filter(entry => entry.completed).length;
    const isOpen = !['completed','cancelled'].includes(x.status);
    const checklistHtml = checklist.length ? `<div class="cc-task-checklist"><div class="cc-meta">${ccText('Checklist progress', '清单进度')}: ${completedCount}/${checklist.length}</div><progress class="cc-task-progress" value="${completedCount}" max="${checklist.length}" aria-label="${ccText('Checklist progress', '清单进度')}"></progress>${checklist.map(entry => `<label class="cc-task-check"><input type="checkbox" data-task-checklist="${escapeHtml(x.id)}" data-task-check-id="${escapeHtml(entry.id)}" ${entry.completed ? 'checked' : ''} ${!can('task.close') || !isOpen ? 'disabled' : ''}/><span class="${entry.completed ? 'is-complete' : ''}">${escapeHtml(entry.title)}${entry.completedAt ? `<small>${escapeHtml(entry.completedByName || '')} · ${escapeHtml(new Date(entry.completedAt).toLocaleString())}</small>` : ''}</span></label>`).join('')}</div>` : '';
    const completionBlocked = checklist.length > completedCount;
    const activityHtml = `<div class="cc-task-activity">${comments.length ? `<details class="cc-history"><summary>${ccText('Task comments', '任务备注')} (${comments.length})</summary>${comments.slice(-10).map(c => `<div class="cc-meta"><strong>${escapeHtml(c.actorName || '')}</strong> · ${escapeHtml(new Date(c.createdAt).toLocaleString())}<div>${escapeHtml(c.comment || '')}</div></div>`).join('')}</details>` : ''}${attachments.length ? `<details class="cc-history"><summary>${ccText('Completion evidence', '完成凭证')} (${attachments.length})</summary>${attachments.map(a => `<div class="cc-meta"><a href="/api/v2/tasks/${encodeURIComponent(x.id)}/attachments/${encodeURIComponent(a.id)}/download">${escapeHtml(a.name)}</a> · ${Math.ceil(Number(a.size || 0) / 1024)} KB · ${escapeHtml(a.uploadedByName || '')}</div>`).join('')}</details>` : ''}${(can('task.close') || can('task.edit')) && isOpen ? `<div class="cc-form-grid"><form data-task-comment-form="${escapeHtml(x.id)}" class="cc-inline-form"><input name="comment" required maxlength="2000" placeholder="${ccText('Add a task comment', '添加任务备注')}"/><button class="btn btn-sm">${ccText('Comment', '备注')}</button></form><form data-task-attachment-form="${escapeHtml(x.id)}" class="cc-inline-form"><input name="file" type="file" accept="application/pdf,image/png,image/jpeg,.csv,.xlsx,.xls,.xlsm,.xlsb" required/><button class="btn btn-sm">${ccText('Upload completion evidence', '上传完成凭证')}</button></form></div>` : ''}</div>`;
    return `<article class="card cc-card" data-task-card data-task-status="${escapeHtml(x.status)}" data-task-priority="${escapeHtml(x.priority || 'normal')}" data-task-store="${escapeHtml(x.storeId || '')}" data-task-search="${escapeHtml([x.title, x.description || '', x.assigneeName || ''].join(' '))}"><div class="cc-card-top"><strong>${escapeHtml(x.title)}</strong>${ccStatusBadge(x.status)}${isOpen ? ccDueBadge(x.dueAt) : ''}</div><div class="cc-meta">${escapeHtml(x.assigneeName || '—')} · ${x.dueAt ? escapeHtml(x.dueAt.slice(0,10)) : ccText('No due date', '无截止日期')} · ${ccText('Priority', '优先级')}: ${escapeHtml(x.priority || 'normal')}</div><div>${escapeHtml(x.description || '')}</div>${checklistHtml}${activityHtml}${(can('task.close') || can('task.edit')) && isOpen ? `<div class="cc-actions">${can('task.edit') ? `<button class="btn btn-sm" data-task-edit="${escapeHtml(x.id)}">${ccText('Edit task', '编辑任务')}</button>` : ''}${can('task.close') ? `<button class="btn btn-sm" data-task-complete="${escapeHtml(x.id)}" ${completionBlocked ? 'disabled title="' + escapeHtml(ccText('Complete all checklist items first', '请先完成全部清单项目')) + '"' : ''}>${ccText('Mark complete', '标记完成')}</button>` : ''}</div>` : ''}</article>`;
  }).join('');
  const renderWorkflowFields = processType => CONTROL_FIELDS.filter(([key]) => CONTROL_FIELDS_BY_TYPE[processType]?.includes(key) && (key !== 'assigneeId' || can('task.assign'))).map(([key, en, zh, type]) => {
    if (key === 'assigneeId') return `<label class="cc-field"><span>${ccText(en, zh)}</span><select name="assigneeId"><option value="">${ccText('Unassigned', '暂不指派')}</option>${assignees.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('')}</select></label>`;
    return `<label class="cc-field"><span>${ccText(en, zh)}</span>${type === 'textarea' ? `<textarea name="${key}" rows="2"></textarea>` : `<input name="${key}" type="${type}" ${['amount','estimatedAmount','oldPrice','newPrice'].includes(key) ? 'min="0" step="0.01"' : ['quantity','countedQuantity'].includes(key) ? 'min="0.001" step="0.001"' : key === 'quantityDelta' ? 'step="0.001"' : ''}/>`}</label>`;
  }).join('');
  const initialProcessType = Object.keys(ACTIVE_CONTROL_TYPES)[0];
  root.innerHTML = `
    <div class="page-header cc-page-header"><div class="page-header-text"><div class="page-title">${ccText('Control Platform', '中控平台')}</div><div class="page-subtitle">${ccText('Approvals, tasks, store follow-up and announcements', '审批流程、任务协作、门店跟进与内容公告')}</div></div><time>${escapeHtml(new Date().toLocaleDateString())}</time></div>
    <section class="cc-overview"><div class="cc-overview-grid">
      ${mayViewWorkflows ? metric(ccText('My pending approvals', '待我审批'), count(workflowData.pendingForMe), 'approvals', 'warning', true) : ''}
      ${mayViewTasks ? metric(ccText('Open tasks', '未完成任务'), taskData.counts ? count(taskData.counts.open || 0) + count(taskData.counts.in_progress || 0) : NaN, 'collaboration', 'brand') : ''}
      ${mayViewWorkflows ? metric(ccText('Open store remediation', '未完成门店整改'), workflowData.countsByType ? openRemediationCount : NaN, 'approvals', 'danger') : ''}
      ${metric(ccText('Unread notifications', '未读通知'), count(noticeData.unread), 'collaboration', 'neutral')}
    </div>
    <div class="cc-announcement-ticker"><span aria-hidden="true">📢</span><span class="cc-ticker-track"><span class="cc-ticker-content">${leadAnnouncement ? escapeHtml(leadAnnouncement.title) : ccText('No important announcement yet', '暂无重要公告')}</span></span><button type="button" data-cc-jump="announcements">${ccText('View all', '查看全部')} →</button></div>
    <div class="cc-dashboard-grid">
      <section class="card cc-dashboard-panel cc-actions-panel"><h3>${ccText('Quick actions', '快捷办理')}</h3><div class="cc-quick-actions">
        ${can('workflow.create') ? `<button type="button" data-cc-quick="stocktake"><span aria-hidden="true">▤</span><span>${ccText('Start stocktake request', '发起盘点申请')}</span><b aria-hidden="true">→</b></button><button type="button" data-cc-quick="store_remediation"><span aria-hidden="true">◇</span><span>${ccText('Submit store remediation', '提交门店整改')}</span><b aria-hidden="true">→</b></button>` : ''}
        ${can('task.create') ? `<button type="button" data-cc-quick="task"><span aria-hidden="true">☑</span><span>${ccText('Create collaboration task', '创建协作任务')}</span><b aria-hidden="true">→</b></button>` : ''}
        ${can('announcement.manage') ? `<button type="button" data-cc-quick="announcement"><span aria-hidden="true">✦</span><span>${ccText('Publish announcement', '发布内容公告')}</span><b aria-hidden="true">→</b></button>` : ''}
      </div></section>
      <section class="card cc-dashboard-panel"><h3>${ccText('Recent matters', '最近事项')}</h3><div class="cc-dashboard-list">${recentMatters.map(x => `<button type="button" data-cc-jump="${x.area}" data-cc-recent><span><em>${escapeHtml(x.type)}</em><strong>${escapeHtml(x.title)}</strong><small>${escapeHtml(formattedDate(x.date))}</small></span><span class="cc-list-status">${escapeHtml(x.status)} →</span></button>`).join('') || `<span class="cc-muted">${ccText('No recent matters', '暂无最近事项')}</span>`}</div></section>
      <section class="card cc-dashboard-panel"><h3>${ccText('Reminders', '待办提醒')}</h3><div class="cc-dashboard-list">${mayViewWorkflows ? `<button type="button" data-cc-jump="approvals" data-cc-actionable-jump><span>${ccText('Pending approvals', '待我审批')}</span><strong class="cc-count-badge">${escapeHtml(String(workflowData.pendingForMe ?? ccText('Unavailable','读取失败')))}</strong></button>` : ''}${mayViewTasks ? `<button type="button" data-cc-jump="collaboration"><span>${ccText('Open tasks', '未完成任务')}</span><strong class="cc-count-badge">${taskData.counts ? Number(taskData.counts.open || 0) + Number(taskData.counts.in_progress || 0) : ccText('Unavailable','读取失败')}</strong></button>` : ''}<button type="button" data-cc-jump="collaboration"><span>${ccText('Unread notifications', '未读通知')}</span><strong class="cc-count-badge">${escapeHtml(String(noticeData.unread ?? ccText('Unavailable','读取失败')))}</strong></button></div></section>
    </div><div class="cc-detail-heading" hidden><strong id="ccDetailTitle"></strong><small id="ccDetailSubtitle"></small></div><div class="cc-workspace-stats" hidden></div></section>
    <section class="cc-section" data-cc-area="announcements"><h3>${ccText('Announcements', '内容公告')}</h3>
      ${can('announcement.manage') ? `<form id="ccAnnouncementForm" class="card cc-announcement-form"><label class="cc-field"><span>${ccText('Title', '标题')}</span><input name="title" maxlength="180" required/></label><label class="cc-field"><span>${ccText('Content', '内容')}</span><textarea name="body" maxlength="5000" rows="4" required></textarea></label><div class="cc-inline-form"><label><input type="checkbox" name="pinned"/> ${ccText('Pin to ticker', '置顶到公告条')}</label><select name="status"><option value="published">${ccText('Publish now', '立即发布')}</option><option value="draft">${ccText('Save draft', '保存草稿')}</option></select><button class="btn btn-primary">${ccText('Save announcement', '保存公告')}</button></div></form>` : ''}
      <div class="cc-list">${announcements.filter(x => x.status !== 'archived').map(x => `<article class="card cc-announcement-item"><div class="cc-card-top"><strong>${x.pinned ? '📢 ' : ''}${escapeHtml(x.title)}</strong>${ccStatusBadge(x.status, x.status === 'draft' ? ccText('Draft', '草稿') : ccText('Published', '已发布'))}</div><p>${escapeHtml(x.body).replace(/\n/g, '<br>')}</p><div class="cc-meta">${escapeHtml(x.createdByName || '')} · ${escapeHtml(new Date(x.updatedAt).toLocaleString())}</div>${can('announcement.manage') ? `<button type="button" class="btn btn-sm" data-cc-announcement-edit="${escapeHtml(x.id)}">${ccText('Edit', '编辑')}</button>` : ''}</article>`).join('') || ccEmptyState(ccText('No announcements yet', '还没有发布过公告'), ccText('Published updates will appear here.', '发布后，员工可在此查看通知。'), can('announcement.manage') ? ccText('Create first announcement', '新建第一条公告') : '', 'announcement')}</div></section>
    ${can('workflow.create') ? `<section class="card cc-section" data-cc-area="approvals"><h3>${ccText('New request', '新建申请')}</h3><form id="ccWorkflowForm"><div class="cc-form-grid"><label class="cc-field"><span>${ccText('Process type', '流程类型')}</span><select name="type">${Object.entries(ACTIVE_CONTROL_TYPES).map(([k,v]) => `<option value="${k}">${escapeHtml(v[String(locale()).toLowerCase().startsWith('zh') ? 1 : 0])}</option>`).join('')}</select></label><label class="cc-field"><span>${ccText('Title', '标题')}</span><input name="title" required maxlength="180"/></label><div id="ccWorkflowFields" class="cc-form-grid cc-wide">${renderWorkflowFields(initialProcessType)}</div><div id="ccStocktakePanel" data-stocktake-editor="new" class="cc-wide" hidden></div></div><button class="btn btn-primary" type="submit">${ccText('Submit for approval', '提交审批')}</button></form></section>` : ''}
    ${can('task.create') ? `<section class="card cc-section" data-cc-area="collaboration"><h3>${ccText('Create task', '创建任务')}</h3><form id="ccTaskForm"><div class="cc-form-grid"><label class="cc-field"><span>${ccText('Task title', '任务名称')}</span><input name="title" required maxlength="180"/></label><label class="cc-field"><span>${ccText('Assignee', '负责人')}</span><select name="assigneeId"><option value="">${ccText('Unassigned', '暂不指派')}</option>${assignees.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}${a.username ? ` · ${escapeHtml(a.username)}` : ''}</option>`).join('')}</select></label><label class="cc-field"><span>${ccText('Store', '门店')}</span><select name="storeId"><option value="">—</option>${stores.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(tStore(s.name))}</option>`).join('')}</select></label><label class="cc-field"><span>${ccText('Due date', '截止日期')}</span><input name="dueAt" type="date"/></label><label class="cc-field"><span>${ccText('Priority', '优先级')}</span><select name="priority"><option value="normal">${ccText('Normal', '普通')}</option><option value="high">${ccText('High', '高')}</option><option value="urgent">${ccText('Urgent', '紧急')}</option><option value="low">${ccText('Low', '低')}</option></select></label><label class="cc-field cc-wide"><span>${ccText('Description', '任务说明')}</span><textarea name="description" rows="2"></textarea></label><label class="cc-field cc-wide"><span>${ccText('Checklist (one item per line)', '执行清单（每行一项）')}</span><textarea name="checklist" rows="4" maxlength="12000" placeholder="${ccText('Prepare materials\nConfirm completion\nUpload evidence', '准备资料\n确认完成情况\n上传凭证')}"></textarea></label></div><button class="btn btn-primary" type="submit">${ccText('Create task', '创建任务')}</button></form></section>` : ''}
    ${mayViewOrg ? `<section class="card cc-section" data-cc-area="governance"><h3>${ccText('Organization', '组织架构')}</h3><p>${ccText('China management center · Philippines management center', '中国管理中心 · 菲律宾管理中心')}</p>${orgs.length ? orgs.map(o => `<span class="cc-chip">${escapeHtml(o.code)} · ${escapeHtml(o.name)}</span>`).join('') : `<span class="cc-muted">${ccText('No organization records configured yet', '尚未配置组织档案')}</span>`}${can('org.manage') ? `<form id="ccOrgForm" class="cc-inline-form"><input name="code" required placeholder="CN-HQ"/><input name="name" required placeholder="${ccText('Organization name', '组织名称')}"/><select name="countryCode"><option value="CN">CN</option><option value="PH" selected>PH</option></select><button class="btn btn-sm btn-primary">${ccText('Add', '添加')}</button></form>` : ''}</section>` : ''}
    ${can('staff.view') ? `<section class="card cc-section" data-cc-area="governance"><h3>${ccText('Employee directory', '员工名册')}</h3>${employees.length ? employees.map(x => `<span class="cc-chip">${escapeHtml(x.employeeCode)} · ${escapeHtml(x.name)} ${can('staff.edit') ? `<button type="button" class="btn btn-sm" data-v2-edit-employee="${escapeHtml(x.id)}">${ccText('Edit', '编辑')}</button>` : ''}</span>`).join('') : `<span class="cc-muted">${ccText('No employee records configured yet', '尚无员工名册')}</span>`}${can('staff.create') ? `<form id="ccEmployeeForm" class="cc-inline-form"><input name="employeeCode" required placeholder="EMP-001"/><input name="name" required placeholder="${ccText('Employee name', '员工姓名')}"/><input name="phone" placeholder="${ccText('Phone', '电话')}"/><button class="btn btn-sm btn-primary">${ccText('Add', '添加')}</button></form>` : ''}</section>` : ''}
    ${mayViewWorkflows ? `<section class="cc-section" data-cc-area="approvals"><h3>${ccText('Active approvals', '当前审批')}</h3><form id="ccWorkflowFilterForm" class="cc-workflow-filters"><input type="search" name="q" value="${escapeHtml(state.workflowFilters?.q || '')}" placeholder="${ccText('Search title, store, requester or document number', '搜索标题、门店、申请人或单据编号')}"/><select name="status"><option value="" ${!state.workflowFilters?.status ? 'selected' : ''}>${ccText('All statuses', '全部状态')}</option><option value="pending_approval" ${state.workflowFilters?.status === 'pending_approval' ? 'selected' : ''}>${ccText('Pending approval', '待审批')}</option><option value="returned" ${state.workflowFilters?.status === 'returned' ? 'selected' : ''}>${ccText('Returned', '已退回')}</option><option value="approved" ${state.workflowFilters?.status === 'approved' ? 'selected' : ''}>${ccText('Approved', '已批准')}</option><option value="execution_pending" ${state.workflowFilters?.status === 'execution_pending' ? 'selected' : ''}>${ccText('In execution', '执行中')}</option><option value="awaiting_review" ${state.workflowFilters?.status === 'awaiting_review' ? 'selected' : ''}>${ccText('Awaiting review', '待复查')}</option><option value="completed" ${state.workflowFilters?.status === 'completed' ? 'selected' : ''}>${ccText('Completed', '已完成')}</option><option value="rejected" ${state.workflowFilters?.status === 'rejected' ? 'selected' : ''}>${ccText('Rejected', '已驳回')}</option><option value="cancelled" ${state.workflowFilters?.status === 'cancelled' ? 'selected' : ''}>${ccText('Cancelled', '已撤回')}</option></select><select name="type"><option value="" ${!state.workflowFilters?.type ? 'selected' : ''}>${ccText('All process types', '全部流程类型')}</option>${Object.entries(CONTROL_TYPES).map(([key, names]) => `<option value="${escapeHtml(key)}" ${state.workflowFilters?.type === key ? 'selected' : ''}>${escapeHtml(names[String(locale()).toLowerCase().startsWith('zh') ? 1 : 0])}${ACTIVE_CONTROL_TYPES[key] ? '' : ` · ${ccText('Archived', '已归档')}`}</option>`).join('')}</select><button class="btn btn-sm" type="submit">${ccText('Search', '筛选')}</button><button class="btn btn-sm" type="button" data-workflow-reset>${ccText('Reset', '重置')}</button><button class="btn btn-sm" type="button" data-workflow-actionable>${state.workflowFilters?.actionable ? ccText('Show all requests', '显示全部申请') : ccText('My pending approvals', '待我审批')}</button><span class="cc-meta">${ccPageSummary(workflowData)}</span></form><div class="cc-list">${flowCards || ccEmptyState(ccText('No approval records', '暂无审批记录'), ccText('New requests will appear here.', '新申请提交后会显示在这里。'), can('workflow.create') ? ccText('Create request', '新建申请') : '', 'stocktake')}</div><div class="cc-actions cc-workflow-pager">${ccPagerButtons('workflow', workflowData)}</div>${archivedWorkflows.length ? `<details class="cc-archive"><summary>${ccText('Archived request types', '已停用流程的历史记录')} (${archivedWorkflows.length})</summary><p>${ccText('These records are retained for audit and are read-only.', '这些历史记录仅供审计查阅，不再审批或重新提交。')}</p><div class="cc-list">${archivedWorkflows.map(w => `<article class="card cc-card"><div class="cc-card-top"><strong>${escapeHtml(CONTROL_TYPES[w.type]?.[String(locale()).toLowerCase().startsWith('zh') ? 1 : 0] || w.type)} · ${escapeHtml(w.title)}</strong>${ccStatusBadge(w.status)}</div><div class="cc-meta">${escapeHtml(w.createdByName || '')} · ${escapeHtml(new Date(w.createdAt).toLocaleString())}</div><div class="cc-meta">${escapeHtml(JSON.stringify(Object.fromEntries(Object.entries(w.form || {}).filter(([key]) => key !== 'items'))))}</div>${(w.history || []).length ? `<details class="cc-history"><summary>${ccText('History', '历史记录')}</summary>${w.history.map(h => `<div class="cc-meta">${escapeHtml(h.actorName || '')} · ${escapeHtml(h.action)} · ${escapeHtml(new Date(h.createdAt).toLocaleString())}${h.note ? ` · ${escapeHtml(h.note)}` : ''}</div>`).join('')}</details>` : ''}</article>`).join('')}</div></details>` : ''}</section>` : ''}
    ${can('workflow.configure') ? `<section class="card cc-section" data-cc-area="governance"><h3>${ccText('Approval route settings', '审批路径设置')}</h3><p>${ccText('Configure the approval steps for stocktake and store remediation.', '配置库存盘点与门店整改的审批步骤。')}</p><form id="ccDefinitionForm"><div class="cc-form-grid"><label class="cc-field"><span>${ccText('Process type', '流程类型')}</span><select name="type">${Object.entries(ACTIVE_CONTROL_TYPES).map(([k,v]) => `<option value="${k}">${escapeHtml(v[String(locale()).toLowerCase().startsWith('zh') ? 1 : 0])}</option>`).join('')}</select></label><label class="cc-field"><span>${ccText('Approval steps', '审批步骤')}</span><textarea name="steps" id="ccApprovalSteps" rows="4" placeholder="philippines_manager\nowner"></textarea></label><label class="cc-field"><span>${ccText('Approval deadline (hours)', '审批时限（小时）')}</span><input name="slaHours" type="number" min="1" max="720" step="1" placeholder="${ccText('Blank disables reminders', '留空表示不设置时限')}"/></label></div><div class="cc-inline-form"><select id="ccApproverToken"><optgroup label="${ccText('Roles', '系统角色')}">${['admin','owner','philippines_manager'].map(role => `<option value="${escapeHtml(role)}">${escapeHtml(roleLabel(role))} · ${role}</option>`).join('')}</optgroup>${approverAccounts.filter(x => x.id && ['admin','owner','philippines_manager'].includes(x.role === 'manager' ? 'store_manager' : x.role) && can('system.user.view')).length ? `<optgroup label="${ccText('User accounts', '指定账号')}">${approverAccounts.filter(x => x.id && ['admin','owner','philippines_manager'].includes(x.role === 'manager' ? 'store_manager' : x.role) && can('system.user.view')).map(x => `<option value="user:${escapeHtml(x.id)}">${escapeHtml(x.name || x.username)} · ${escapeHtml(x.username)}</option>`).join('')}</optgroup>` : ''}</select><button type="button" class="btn btn-sm" id="ccApproverAdd">${ccText('Add as step', '添加为一步')}</button></div><p class="cc-meta">${ccText('One line is one sequential step. Comma-separated approvers share that step and any one can approve. Prefix a line with all: to require everyone. Individual accounts can also be entered as user:ID. New requests use a snapshot; saved changes affect new requests.', '每行代表一个顺序审批步骤。同一行逗号分隔多个审批人，任意一人通过即可；行首加 all: 表示需要全部通过。指定账号格式为 user:账号ID。新申请使用流程快照，修改只影响之后提交的申请。')}</p><div id="ccApprovalPreview" class="cc-meta" aria-live="polite"></div><p class="cc-meta">${ccText('When a step exceeds this time, current approvers receive one in-app reminder. Leave blank to disable the approval timer.', '超过时限后，当前步骤审批人会收到一次站内提醒；留空则不启用审批计时。')}</p><button class="btn btn-primary">${ccText('Save route', '保存审批路径')}</button></form></section>` : ''}
    ${mayViewTasks ? `<section class="cc-section" data-cc-area="collaboration"><h3>${ccText('Tasks', '集团与门店协作任务')}</h3><form id="ccTaskFilterForm" class="cc-task-filters"><input type="search" name="q" value="${escapeHtml(state.taskFilters?.q || '')}" placeholder="${ccText('Search title, details or assignee', '搜索任务名称、说明或负责人')}"/><select name="status"><option value="" ${!state.taskFilters?.status ? 'selected' : ''}>${ccText('All statuses', '全部状态')}</option><option value="open" ${state.taskFilters?.status === 'open' ? 'selected' : ''}>${ccText('Open', '待处理')}</option><option value="in_progress" ${state.taskFilters?.status === 'in_progress' ? 'selected' : ''}>${ccText('In progress', '进行中')}</option><option value="completed" ${state.taskFilters?.status === 'completed' ? 'selected' : ''}>${ccText('Completed', '已完成')}</option><option value="cancelled" ${state.taskFilters?.status === 'cancelled' ? 'selected' : ''}>${ccText('Cancelled', '已取消')}</option></select><select name="priority"><option value="" ${!state.taskFilters?.priority ? 'selected' : ''}>${ccText('All priorities', '全部优先级')}</option><option value="urgent" ${state.taskFilters?.priority === 'urgent' ? 'selected' : ''}>${ccText('Urgent', '紧急')}</option><option value="high" ${state.taskFilters?.priority === 'high' ? 'selected' : ''}>${ccText('High', '高')}</option><option value="normal" ${state.taskFilters?.priority === 'normal' ? 'selected' : ''}>${ccText('Normal', '普通')}</option><option value="low" ${state.taskFilters?.priority === 'low' ? 'selected' : ''}>${ccText('Low', '低')}</option></select><select name="storeId"><option value="" ${!state.taskFilters?.storeId ? 'selected' : ''}>${ccText('All stores', '全部门店')}</option><option value="none" ${state.taskFilters?.storeId === 'none' ? 'selected' : ''}>${ccText('Group-level task', '集团任务')}</option>${stores.map(s => `<option value="${escapeHtml(s.id)}" ${state.taskFilters?.storeId === s.id ? 'selected' : ''}>${escapeHtml(tStore(s.name))}</option>`).join('')}</select><button class="btn btn-sm" type="submit">${ccText('Search', '筛选')}</button><button class="btn btn-sm" type="button" data-task-reset>${ccText('Reset', '重置')}</button><span class="cc-meta">${ccPageSummary(taskData)}</span></form><div class="cc-list">${taskCards || ccEmptyState(ccText('No tasks', '暂无任务'), ccText('Assigned work will appear here.', '派发的任务会显示在这里。'), can('task.create') ? ccText('Create task', '创建任务') : '', 'task')}</div><div class="cc-actions cc-workflow-pager">${ccPagerButtons('task', taskData)}</div></section>` : ''}
    ${can('task.create') ? `<section class="card cc-section" data-cc-area="storeops"><h3>${ccText('Daily store report', '门店每日汇报')}</h3><form id="ccStoreReportForm" class="cc-form-grid">${!state.me.storeId ? `<label class="cc-field"><span>${ccText('Store', '门店')}</span><select name="storeId" required><option value="">—</option>${stores.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(tStore(s.name))}</option>`).join('')}</select></label>` : ''}<label class="cc-field"><span>${ccText('Report date', '汇报日期')}</span><input name="reportDate" type="date" required value="${new Date(Date.now() - new Date().getTimezoneOffset()*60000).toISOString().slice(0,10)}"/></label><label class="cc-field cc-wide"><span>${ccText('Daily summary', '工作内容')}</span><textarea name="summary" rows="2"></textarea></label><label class="cc-field"><span>${ccText('Additional context (no sales or inventory figures)', '其他工作说明（不填销售额或库存数据）')}</span><textarea name="additionalNote" rows="2"></textarea></label><label class="cc-field"><span>${ccText('Incidents', '异常事项')}</span><textarea name="incidents" rows="2"></textarea></label><label class="cc-field cc-wide"><span>${ccText('Evidence (PDF/PNG/JPG, up to 4 MB each)', '凭证（PDF/PNG/JPG，每个不超过 4MB）')}</span><input name="attachments" type="file" multiple accept="application/pdf,image/png,image/jpeg"/></label><div><button class="btn btn-primary">${ccText('Submit report', '提交汇报')}</button></div></form><div class="cc-list">${storeReports.map(renderStoreReportCard).join('') || `<div class="cc-muted">${ccText('No reports yet', '暂无汇报')}</div>`}</div>${storeOperationPager('reports')}</section>` : ''}
    ${can('task.create') ? `<section class="card cc-section" data-cc-area="storeops"><h3>${ccText('Store inspection', '门店巡检')}</h3><form id="ccInspectionForm" class="cc-form-grid">${!state.me.storeId ? `<label class="cc-field"><span>${ccText('Store', '门店')}</span><select name="storeId" required><option value="">—</option>${stores.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(tStore(s.name))}</option>`).join('')}</select></label>` : ''}<label class="cc-field"><span>${ccText('Inspection date', '巡检日期')}</span><input name="inspectionDate" type="date" required value="${new Date(Date.now() - new Date().getTimezoneOffset()*60000).toISOString().slice(0,10)}"/></label><label class="cc-field"><span>${ccText('Result', '结果')}</span><select name="result"><option value="pass">${ccText('Pass', '通过')}</option><option value="attention">${ccText('Needs attention', '需关注')}</option><option value="fail">${ccText('Fail', '不合格')}</option></select></label><label class="cc-field"><span>${ccText('Score (0–100)', '评分（0–100）')}</span><input name="score" type="number" min="0" max="100" step="1"/></label><label class="cc-field"><span>${ccText('Checklist', '检查清单')}</span><textarea name="checklist" rows="3" placeholder="${ccText('One check per line', '每行一项检查内容')}"></textarea></label><label class="cc-field"><span>${ccText('Findings', '发现问题')}</span><textarea name="findings" rows="3"></textarea></label><label class="cc-field cc-wide"><span>${ccText('Evidence (PDF/PNG/JPG, up to 4 MB each)', '凭证（PDF/PNG/JPG，每个不超过 4MB）')}</span><input name="attachments" type="file" multiple accept="application/pdf,image/png,image/jpeg"/></label><div><button class="btn btn-primary">${ccText('Save inspection', '保存巡检')}</button></div></form><div class="cc-list">${storeInspections.map(renderStoreInspectionCard).join('') || `<div class="cc-muted">${ccText('No inspections yet', '暂无巡检记录')}</div>`}</div>${storeOperationPager('inspections')}</section>` : ''}
    ${can('alert.view') ? `<section class="card cc-section" data-cc-area="storeops"><h3>${ccText('Historical store issues (read-only)', '历史门店问题记录（只读）')}</h3><p>${ccText('Use the Store Remediation workflow in the Approval Center for new issues, evidence, review and closure. Existing direct issue records remain available here for reference.', '新问题请在审批中心提交“门店整改”流程，统一办理审批、证据、复查和关闭；既有独立问题记录保留在此只读查阅。')}</p><div class="cc-list">${storeIssues.map(x => `<article class="card cc-card"><div class="cc-card-top"><strong>${escapeHtml(x.title)}</strong><span class="cc-status">${x.status === 'closed' ? ccText('Closed', '历史已关闭') : ccText('Open · read-only', '未关闭 · 只读历史')}</span></div><div class="cc-meta">${escapeHtml(stores.find(s => s.id === x.storeId)?.name || '')} · ${escapeHtml(x.ownerName || '—')} · ${x.dueAt ? escapeHtml(x.dueAt.slice(0,10)) : ccText('No due date','无期限')}</div><div>${escapeHtml(x.description || '')}</div></article>`).join('') || `<div class="cc-muted">${ccText('No historical issues', '暂无历史记录')}</div>`}</div>${storeOperationPager('issues')}</section>` : ''}
    ${can('system.audit.view') ? `<section class="cc-section" data-cc-area="governance"><h3>${ccText('Audit events', '操作审计')}</h3><form id="ccAuditFilterForm" class="cc-workflow-filters"><input type="search" name="q" value="${escapeHtml(state.ccAuditFilters?.q || '')}" placeholder="${ccText('Search action, user or record', '搜索操作、人员或记录')}"/><label class="cc-field"><span>${ccText('From', '开始日期')}</span><input type="date" name="from" value="${escapeHtml(state.ccAuditFilters?.from || '')}"/></label><label class="cc-field"><span>${ccText('To', '结束日期')}</span><input type="date" name="to" value="${escapeHtml(state.ccAuditFilters?.to || '')}"/></label><button class="btn btn-sm" type="submit">${ccText('Search', '筛选')}</button><button class="btn btn-sm" type="button" data-audit-reset>${ccText('Reset', '重置')}</button><span class="cc-meta">${ccPageSummary(auditData)}</span></form><div class="cc-list">${auditEvents.length ? auditEvents.map(a => `<article class="card cc-card"><div class="cc-card-top"><strong>${escapeHtml(a.action)}</strong><span class="cc-meta">${escapeHtml(new Date(a.createdAt).toLocaleString())}</span></div><div class="cc-meta">${escapeHtml(a.actorName)} · ${escapeHtml(a.resourceType)} · ${escapeHtml(a.resourceId || '')}</div></article>`).join('') : `${ccEmptyState(ccText('No V2 audit events', '暂无 V2 操作记录'), ccText('Audit entries will appear here after actions are performed.', '操作发生后，审计记录会显示在这里。'))}`}</div><div class="cc-actions cc-workflow-pager"><button type="button" class="btn btn-sm" data-audit-page="prev" ${auditData.offset <= 0 ? 'disabled' : ''}>${ccText('Previous', '上一页')}</button><button type="button" class="btn btn-sm" data-audit-page="next" ${auditData.offset + auditData.limit >= auditData.total ? 'disabled' : ''}>${ccText('Next', '下一页')}</button></div></section>` : ''}
    <section class="cc-section" data-cc-area="collaboration"><h3>${ccText('Notifications', '通知')} · ${ccText('Unread', '未读')} ${Number(noticeData.unread || 0)}</h3><div class="cc-list">${notices.length ? notices.map(n => `<article class="card cc-card"><div class="cc-card-top"><strong>${escapeHtml(n.title)}</strong>${!n.readAt ? `<button class="btn btn-sm" data-notice-read="${escapeHtml(n.id)}">${ccText('Mark read', '标为已读')}</button>` : ''}</div><div>${escapeHtml(n.body)}</div><div class="cc-meta">${escapeHtml(new Date(n.createdAt).toLocaleString())}</div></article>`).join('') : `${ccEmptyState(ccText('No notifications', '暂无通知'), ccText('New notifications will appear here.', '有新通知时会显示在这里。'))}`}</div><div class="cc-actions cc-workflow-pager"><span class="cc-meta">${ccPageSummary(noticeData)}</span><button type="button" class="btn btn-sm" data-notice-page="prev" ${noticeData.offset <= 0 ? 'disabled' : ''}>${ccText('Previous', '上一页')}</button><button type="button" class="btn btn-sm" data-notice-page="next" ${noticeData.offset + noticeData.limit >= noticeData.total ? 'disabled' : ''}>${ccText('Next', '下一页')}</button></div></section>`;

  const availableAreas = new Set(Array.from(root.querySelectorAll('[data-cc-area]'), section => section.dataset.ccArea));
  root.querySelectorAll('[data-cc-tab]').forEach(button => { if (button.dataset.ccTab !== 'overview') button.hidden = !availableAreas.has(button.dataset.ccTab); });
  root.querySelectorAll('[data-cc-jump]').forEach(button => { button.hidden = !availableAreas.has(button.dataset.ccJump); });
  const setWorkspace = key => {
    const requested = ['overview','approvals','collaboration','storeops','governance','announcements'].includes(key) ? key : 'overview';
    const active = requested !== 'overview' && !availableAreas.has(requested) ? 'overview' : requested;
    root.querySelectorAll('[data-cc-area]').forEach(section => { section.hidden = active === 'overview' || section.dataset.ccArea !== active; });
    root.querySelector('.cc-dashboard-grid').hidden = active !== 'overview';
    root.querySelector('.cc-overview-grid').hidden = active !== 'overview';
    root.querySelector('.cc-announcement-ticker').hidden = active !== 'overview';
    root.querySelector('.cc-page-header').hidden = active !== 'overview';
    root.querySelector('.cc-detail-heading').hidden = active === 'overview';
    const titles = { approvals: ccText('Approval Center','审批中心'), collaboration: ccText('Tasks & notifications','任务协作'), storeops: ccText('Store follow-up','门店跟进'), governance: ccText('Governance','治理设置'), announcements: ccText('Announcements','内容公告') };
    root.querySelector('#ccDetailTitle').textContent = titles[active] || '';
    const subtitles = { approvals: ccText('Review and track management requests', '审核和跟进管理申请'), collaboration: ccText('Assign tasks and follow progress', '派发任务并跟进执行'), storeops: ccText('Daily reports, inspections and issues', '每日汇报、巡检与问题跟进'), governance: ccText('Organization, routes and audit', '组织、审批路径与审计'), announcements: ccText('Publish updates to staff', '向员工发布通知与提醒') };
    root.querySelector('#ccDetailSubtitle').textContent = subtitles[active] || '';
    const stats = root.querySelector('.cc-workspace-stats');
    stats.innerHTML = workspaceStats[active] || '';
    stats.hidden = active === 'overview' || !stats.innerHTML;
    $$('.nav-item[data-workspace]').forEach(el => el.classList.toggle('active', state.screen === 'controlCenter' && el.dataset.workspace === active));
    $('.nav-item-primary')?.classList.toggle('active', active === 'overview');
    root.querySelectorAll('[data-cc-tab]').forEach(button => { const selected = button.dataset.ccTab === active; button.classList.toggle('active', selected); button.setAttribute('aria-current', selected ? 'page' : 'false'); });
    state.ccWorkspace = active;
    updateHeaderCrumb();
  };
  const setNavBadge = (id, value) => { const badge = $(id); if (!badge) return; badge.hidden = !Number.isFinite(value) || value <= 0; badge.textContent = Number.isFinite(value) ? String(value) : ''; };
  setNavBadge('#navApprovalCount', mayViewWorkflows ? count(workflowData.pendingForMe) : 0);
  setNavBadge('#navTaskCount', mayViewTasks && taskData.counts ? count(taskData.counts.open || 0) + count(taskData.counts.in_progress || 0) : 0);
  setNavBadge('#navAnnouncementCount', announcements.filter(item => item.status === 'published').length);
  root.querySelectorAll('[data-cc-retry]').forEach(button => button.addEventListener('click', () => renderControlCenter(root)));
  root.querySelectorAll('[data-cc-tab]').forEach(button => button.addEventListener('click', () => setWorkspace(button.dataset.ccTab)));
  root.querySelectorAll('[data-cc-jump]').forEach(button => button.addEventListener('click', async () => {
    if (button.hasAttribute('data-cc-recent')) {
      if (button.dataset.ccJump === 'approvals') { state.workflowFilters = { q: '', status: '', type: '', actionable: false }; state.workflowOffset = 0; }
      else { state.taskFilters = { q: '', status: '', priority: '', storeId: '' }; state.taskOffset = 0; }
      state.ccWorkspace = button.dataset.ccJump;
      await renderControlCenter(root);
      return;
    }
    if (button.hasAttribute('data-cc-actionable-jump')) {
      state.workflowFilters = { q: '', status: 'pending_approval', type: '', actionable: true };
      state.workflowOffset = 0;
      state.ccWorkspace = 'approvals';
      await renderControlCenter(root);
      return;
    }
    setWorkspace(button.dataset.ccJump);
  }));
  root.querySelectorAll('[data-cc-quick]').forEach(button => button.addEventListener('click', () => {
    const kind = button.dataset.ccQuick; setWorkspace(kind === 'task' ? 'collaboration' : kind === 'announcement' ? 'announcements' : 'approvals');
    if (kind === 'task') $('#ccTaskForm input[name=title]', root)?.focus();
    else if (kind === 'announcement') $('#ccAnnouncementForm input[name=title]', root)?.focus();
    else { const select = $('#ccWorkflowForm select[name=type]', root); if (select) { select.value = kind; select.dispatchEvent(new Event('change')); $('#ccWorkflowForm input[name=title]', root)?.focus(); } }
  }));
  const announcementForm = $('#ccAnnouncementForm', root);
  const updateAnnouncementAction = () => { const button = announcementForm?.querySelector('button[type="submit"]'); if (button) button.textContent = announcementForm.elements.status.value === 'draft' ? ccText('Save draft', '保存草稿') : ccText('Publish announcement', '发布公告'); };
  announcementForm?.querySelector('select[name="status"]')?.addEventListener('change', updateAnnouncementAction);
  updateAnnouncementAction();
  announcementForm?.addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); try { await POST('/api/v2/announcements', { title: data.get('title'), body: data.get('body'), pinned: data.has('pinned'), status: data.get('status') }); toast(ccText('Announcement saved', '公告已保存'), 'success'); await renderControlCenter(root); } catch (error) { toast(error.message, 'error'); } });
  $$('[data-cc-announcement-edit]', root).forEach(button => button.addEventListener('click', () => { const item = announcements.find(x => x.id === button.dataset.ccAnnouncementEdit); if (!item) return; const modal = openModal({ title: ccText('Edit announcement','编辑公告'), body: `<form id="ccAnnouncementEdit" class="cc-form-grid"><label class="cc-field"><span>${ccText('Title','标题')}</span><input name="title" required maxlength="180" value="${escapeHtml(item.title)}"/></label><label class="cc-field"><span>${ccText('Content','内容')}</span><textarea name="body" required maxlength="5000" rows="5">${escapeHtml(item.body)}</textarea></label><label><input name="pinned" type="checkbox" ${item.pinned ? 'checked' : ''}/> ${ccText('Pin to ticker','置顶到公告条')}</label><select name="status"><option value="published" ${item.status === 'published' ? 'selected' : ''}>${ccText('Published','已发布')}</option><option value="draft" ${item.status === 'draft' ? 'selected' : ''}>${ccText('Draft','草稿')}</option><option value="archived">${ccText('Archive','归档')}</option></select></form>`, footer: `<button class="btn" data-close>${ccText('Cancel','取消')}</button><button class="btn btn-primary" id="ccAnnouncementUpdate">${ccText('Save','保存')}</button>` }); $('#ccAnnouncementUpdate', modal).addEventListener('click', async () => { const form = $('#ccAnnouncementEdit', modal); if (!form.reportValidity()) return; const data = new FormData(form); try { await PUT(`/api/v2/announcements/${encodeURIComponent(item.id)}`, { title: data.get('title'), body: data.get('body'), pinned: data.has('pinned'), status: data.get('status') }); closeModal(); await renderControlCenter(root); } catch(error) { toast(error.message, 'error'); } }); }));
  setWorkspace(state.ccWorkspace || 'overview');

  $('#ccTaskFilterForm')?.addEventListener('submit', async e => {
    e.preventDefault(); const fd = new FormData(e.currentTarget);
    state.taskFilters = { q: String(fd.get('q') || '').trim(), status: String(fd.get('status') || ''), priority: String(fd.get('priority') || ''), storeId: String(fd.get('storeId') || '') };
    state.taskOffset = 0; await renderControlCenter(root);
  });
  $('[data-task-reset]', root)?.addEventListener('click', async () => {
    state.taskFilters = { q: '', status: '', priority: '', storeId: '' }; state.taskOffset = 0; await renderControlCenter(root);
  });
  $$('[data-task-page]', root).forEach(button => button.addEventListener('click', async () => {
    const limit = Number(taskData.limit) || 25;
    const target = button.dataset.taskPage;
    state.taskOffset = Math.max(0, /^\d+$/.test(target) ? (Number(target) - 1) * limit : Number(taskData.offset || 0) + (target === 'next' ? limit : -limit));
    await renderControlCenter(root);
  }));

  $('#ccWorkflowFilterForm')?.addEventListener('submit', async e => {
    e.preventDefault(); const fd = new FormData(e.currentTarget);
    const status = String(fd.get('status') || '');
    state.workflowFilters = { q: String(fd.get('q') || '').trim(), status, type: String(fd.get('type') || ''), actionable: !!state.workflowFilters?.actionable && (!status || status === 'pending_approval') };
    state.workflowOffset = 0; await renderControlCenter(root);
  });
  $('[data-workflow-reset]', root)?.addEventListener('click', async () => {
    state.workflowFilters = { q: '', status: '', type: '', actionable: false }; state.workflowOffset = 0; await renderControlCenter(root);
  });
  $('[data-workflow-actionable]', root)?.addEventListener('click', async () => {
    state.workflowFilters = state.workflowFilters?.actionable
      ? { q: '', status: '', type: '', actionable: false }
      : { ...state.workflowFilters, status: 'pending_approval', actionable: true };
    state.workflowOffset = 0;
    await renderControlCenter(root);
  });
  $$('[data-workflow-page]', root).forEach(button => button.addEventListener('click', async () => {
    const limit = Number(workflowData.limit) || 25;
    const target = button.dataset.workflowPage;
    state.workflowOffset = Math.max(0, /^\d+$/.test(target) ? (Number(target) - 1) * limit : Number(workflowData.offset || 0) + (target === 'next' ? limit : -limit));
    await renderControlCenter(root);
  }));

  $$('[data-stocktake-editor]', root).forEach(el => {
    const workflow = workflows.find(item => item.id === el.dataset.stocktakeEditor);
    el.stocktakeEditor = createStocktakeEditor(el, workflow?.form?.items || [], workflow?.form?.sourceFileName || '');
  });
  const workflowForm = $('#ccWorkflowForm');
  const mainStocktakeEditor = $('[data-stocktake-editor="new"]', root)?.stocktakeEditor;
  workflowForm?.addEventListener('submit', async e => {
    e.preventDefault(); const fd = new FormData(e.currentTarget), type = fd.get('type'), form = {};
    CONTROL_FIELDS.forEach(([key]) => { const v = String(fd.get(key) || '').trim(); if (v || key === 'assigneeId' && fd.has(key)) form[key] = v; });
    const sourceFile = type === 'stocktake' ? mainStocktakeEditor?.getSourceFile() : null;
    if (type === 'stocktake') {
      form.items = mainStocktakeEditor?.getRows() || [];
      if (!form.items.length && !sourceFile) { toast(ccText('Upload a spreadsheet or add a manual line', '请上传表格或手动添加一条盘点明细'), 'error'); return; }
      if (sourceFile) form.sourceFileName = sourceFile.name;
    }
    try {
      const sourceFilePayload = sourceFile ? { fileName: sourceFile.name, mimeType: stocktakeSourceMime(sourceFile), data: await readFileAsDataUrl(sourceFile, stocktakeSourceMime(sourceFile)) } : null;
      await POST('/api/v2/workflows', { type, title: fd.get('title'), form, ...(sourceFilePayload ? { sourceFile: sourceFilePayload } : {}) });
      toast(ccText('Request submitted', '申请已提交'), 'success'); await renderControlCenter(root);
    }
    catch (err) { toast(err.message, 'error'); }
  });
  const syncNewWorkflowFields = () => {
    const type = workflowForm.elements.type.value;
    $('#ccWorkflowFields').innerHTML = renderWorkflowFields(type);
    $('#ccStocktakePanel').hidden = type !== 'stocktake';
  };
  workflowForm?.elements.type.addEventListener('change', syncNewWorkflowFields);
  if (workflowForm) syncNewWorkflowFields();
  $$('[data-stocktake-export]', root).forEach(button => button.addEventListener('click', () => {
    const workflow = workflows.find(item => item.id === button.dataset.stocktakeExport);
    if (workflow) downloadStocktakeCsv(workflow.form?.items || [], `${workflow.id}-stocktake-detail.csv`);
  }));
  $('#ccTaskForm')?.addEventListener('submit', async e => {
    e.preventDefault(); const fd = new FormData(e.currentTarget);
    try { await POST('/api/v2/tasks', Object.fromEntries(fd.entries())); toast(ccText('Task created', '任务已创建'), 'success'); await renderControlCenter(root); }
    catch (err) { toast(err.message, 'error'); }
  });
  const validateStoreOperationFiles = files => {
    const actual = files.filter(file => file && file.size);
    if (actual.length > 10 || actual.some(file => file.size > 4 * 1024 * 1024) || actual.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) throw new Error(ccText('Attach up to 10 files, each no larger than 4 MB and 20 MB total.', '最多上传 10 个文件，每个不超过 4MB，合计不超过 20MB。'));
    return actual;
  };
  const uploadStoreOperationFiles = async (kind, itemId, files) => {
    for (const file of files) {
      const mimeType = uploadMimeType(file);
      await POST(`/api/v2/store-operations/${kind}/${encodeURIComponent(itemId)}/attachments`, { fileName: file.name, mimeType, data: await readFileAsDataUrl(file, mimeType) });
    }
  };
  const bindStoreOperationForm = (selector, kind, endpoint, successMessage) => {
    $(selector)?.addEventListener('submit', async e => {
      e.preventDefault(); const fd = new FormData(e.currentTarget); let created = null;
      try {
        const files = validateStoreOperationFiles(fd.getAll('attachments'));
        const payload = Object.fromEntries(fd.entries()); delete payload.attachments;
        created = (await POST(endpoint, payload)).item;
        await uploadStoreOperationFiles(kind, created.id, files);
        toast(ccText(successMessage[0], successMessage[1]), 'success'); await renderControlCenter(root);
      } catch (err) { toast(err.message, 'error'); if (created) await renderControlCenter(root); }
    });
  };
  bindStoreOperationForm('#ccStoreReportForm', 'report', '/api/v2/store-reports', ['Report submitted', '汇报已提交']);
  bindStoreOperationForm('#ccInspectionForm', 'inspection', '/api/v2/store-inspections', ['Inspection saved', '巡检已保存']);
  $$('[data-inspection-remediate]', root).forEach(button => button.addEventListener('click', () => {
    const inspection = storeInspections.find(x => x.id === button.dataset.inspectionRemediate); if (!inspection) return;
    const storeName = stores.find(x => x.id === inspection.storeId)?.name || '';
    const issue = inspection.findings || ccText('Please review the failed store inspection.', '请复核本次不合格的门店巡检。');
    const reason = `${ccText('Source inspection', '来源巡检')} · ${inspection.inspectionDate} · ${ccStatus(inspection.result)}${inspection.score == null ? '' : ` · ${ccText('Score', '评分')} ${inspection.score}`}`;
    const modal = openModal({ title: ccText('Create store remediation', '发起门店整改'), body: `<p>${ccText('Store inspection attachments will be copied to this request as supporting evidence. The assignee must still upload before/after evidence during each correction round.', '巡检附件会复制到整改申请中作为其他凭证；负责人仍须在每轮整改中上传整改前、整改后证据。')}</p><form id="ccInspectionRemediationForm" class="cc-form-grid"><label class="cc-field"><span>${ccText('Store', '门店')}</span><input name="storeName" readonly value="${escapeHtml(storeName)}"/></label><label class="cc-field"><span>${ccText('Due date', '整改期限')}</span><input name="dueDate" type="date" required/></label>${can('task.assign') ? `<label class="cc-field cc-wide"><span>${ccText('Assignee', '整改负责人')}</span><select name="assigneeId"><option value="">${ccText('Unassigned', '暂不指派')}</option>${assignees.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('')}</select></label>` : ''}<label class="cc-field cc-wide"><span>${ccText('Issue', '问题描述')}</span><textarea name="issue" rows="3" required>${escapeHtml(issue)}</textarea></label><input type="hidden" name="reason" value="${escapeHtml(reason)}"/></form>`, footer: `<button class="btn" data-close>${ccText('Cancel', '取消')}</button><button class="btn btn-primary" id="ccInspectionRemediationSave">${ccText('Create request', '提交整改申请')}</button>`, wide: true });
    $('#ccInspectionRemediationSave', modal).addEventListener('click', async () => {
      const fd = new FormData($('#ccInspectionRemediationForm', modal)), formData = Object.fromEntries(fd.entries());
      if (!formData.dueDate) { toast(ccText('Choose a due date', '请选择整改期限'), 'error'); return; }
      try {
        await POST('/api/v2/workflows', { type: 'store_remediation', title: `${ccText('Store remediation', '门店整改')} · ${storeName}`, sourceInspectionId: inspection.id, form: formData });
        closeModal(); state.ccWorkspace = 'approvals'; toast(ccText('Remediation request created', '门店整改申请已创建'), 'success'); await renderControlCenter(root);
      } catch (err) { toast(err.message, 'error'); }
    });
  }));
  $$('[data-store-operation-attachment]', root).forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault(); const [kind, itemId] = String(form.dataset.storeOperationAttachment || '').split(':');
    try { const files = validateStoreOperationFiles(new FormData(form).getAll('attachments')); if (!files.length) return; await uploadStoreOperationFiles(kind, itemId, files); toast(ccText('Evidence uploaded', '凭证已上传'), 'success'); await renderControlCenter(root); }
    catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-store-operation-page]', root).forEach(button => button.addEventListener('click', async () => {
    const [key, direction] = String(button.dataset.storeOperationPage || '').split(':');
    const page = operationData.pages?.[key]; if (!page) return;
    state.storeOperationOffsets[key] = Math.max(0, Number(page.offset || 0) + (direction === 'next' ? Number(page.limit || 10) : -Number(page.limit || 10)));
    await renderControlCenter(root);
  }));
  $('#ccOrgForm')?.addEventListener('submit', async e => { e.preventDefault(); const fd = new FormData(e.currentTarget); try { await POST('/api/v2/organizations', Object.fromEntries(fd.entries())); await renderControlCenter(root); } catch (err) { toast(err.message, 'error'); } });
  $('#ccEmployeeForm')?.addEventListener('submit', async e => { e.preventDefault(); const fd = new FormData(e.currentTarget); try { await POST('/api/v2/employees', Object.fromEntries(fd.entries())); await renderControlCenter(root); } catch (err) { toast(err.message, 'error'); } });
  $$('[data-v2-edit-employee]', root).forEach(button => button.addEventListener('click', () => {
    const item = employees.find(x => x.id === button.dataset.v2EditEmployee); if (!item) return;
    const modal = openModal({ title: ccText('Edit employee', '编辑员工档案'), body: `<form id="ccEmployeeEdit" class="cc-form-grid"><label class="cc-field"><span>${ccText('Name', '姓名')}</span><input name="name" required value="${escapeHtml(item.name)}"/></label><label class="cc-field"><span>${ccText('Phone', '电话')}</span><input name="phone" value="${escapeHtml(item.phone || '')}"/></label><label class="cc-field"><span>${ccText('Email', '邮箱')}</span><input name="email" type="email" value="${escapeHtml(item.email || '')}"/></label></form>`, footer: `<button class="btn" data-close>${ccText('Cancel', '取消')}</button><button class="btn btn-primary" id="ccEmployeeSave">${ccText('Save', '保存')}</button>` });
    $('#ccEmployeeSave', modal).addEventListener('click', async () => { const fd = new FormData($('#ccEmployeeEdit', modal)); try { await PUT(`/api/v2/employees/${encodeURIComponent(item.id)}`, Object.fromEntries(fd.entries())); closeModal(); await renderControlCenter(root); } catch (err) { toast(err.message, 'error'); } });
  }));
  $$('[data-v2-resubmit]', root).forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault(); const fd = new FormData(form), payload = { action: 'resubmit', title: fd.get('title'), form: {} };
    CONTROL_FIELDS.forEach(([key]) => { const value = String(fd.get(key) || '').trim(); if (value || key === 'assigneeId' && fd.has(key)) payload.form[key] = value; });
    const editor = $('[data-stocktake-editor]', form)?.stocktakeEditor;
    const sourceFile = editor?.getSourceFile() || null;
    if (editor) {
      payload.form.items = editor.getRows();
      if (!payload.form.items.length && !sourceFile && !workflows.find(x => x.id === form.dataset.v2Resubmit)?.attachments?.some(a => ['.xlsx','.xls','.xlsm','.xlsb','.csv'].some(ext => a.name?.toLowerCase().endsWith(ext)))) { toast(ccText('Upload a spreadsheet or add a manual line', '请上传表格或手动添加一条盘点明细'), 'error'); return; }
      if (sourceFile) payload.form.sourceFileName = sourceFile.name;
    }
    try {
      if (sourceFile) payload.sourceFile = { fileName: sourceFile.name, mimeType: stocktakeSourceMime(sourceFile), data: await readFileAsDataUrl(sourceFile, stocktakeSourceMime(sourceFile)) };
      await POST(`/api/v2/workflows/${encodeURIComponent(form.dataset.v2Resubmit)}/actions`, payload);
      toast(ccText('Request resubmitted', '申请已重新提交'), 'success'); await renderControlCenter(root);
    }
    catch (err) { toast(err.message, 'error'); }
  }));
  const definitionForm = $('#ccDefinitionForm');
  if (definitionForm) {
    const fillDefinition = () => {
      const d = definitions.find(x => x.type === definitionForm.elements.type.value);
      const steps = d?.config?.steps || [{ mode: 'any', approvers: [{ kind: 'role', id: 'admin' }, { kind: 'role', id: 'owner' }, { kind: 'role', id: 'philippines_manager' }] }];
      definitionForm.elements.steps.value = steps.map(s => `${s.mode === 'all' ? 'all:' : ''}${(s.approvers || []).map(a => `${a.kind === 'user' ? 'user:' : ''}${a.id}`).join(',')}`).join('\n');
      definitionForm.elements.slaHours.value = d?.config?.slaHours ?? '';
      renderRoutePreview();
    };
    const renderRoutePreview = () => {
      const preview = $('#ccApprovalPreview'), textarea = $('#ccApprovalSteps'); if (!preview || !textarea) return;
      const d = definitions.find(x => x.type === definitionForm.elements.type.value);
      const lines = textarea.value.split('\n').map(x => x.trim()).filter(Boolean);
      preview.innerHTML = `${d ? `${ccText('Current route version', '当前流程版本')} v${Number(d.version || 1)} · ` : ''}${lines.length ? lines.map((line, index) => { const all = line.startsWith('all:'), tokens = (all ? line.slice(4) : line).split(',').map(x => x.trim()).filter(Boolean); return `<div>${ccText('Step', '第')} ${index + 1} · ${all ? ccText('Everyone must approve', '全部会签') : ccText('Any one may approve', '任一人通过')} · ${escapeHtml(tokens.join('、') || ccText('No approver', '未设置审批人'))}</div>`; }).join('') : ccText('Add at least one approval step.', '请至少添加一个审批步骤。')}`;
    };
    definitionForm.elements.type.addEventListener('change', fillDefinition); fillDefinition();
    $('#ccApprovalSteps')?.addEventListener('input', renderRoutePreview);
    $('#ccApproverAdd')?.addEventListener('click', () => {
      const textarea = $('#ccApprovalSteps'), token = $('#ccApproverToken')?.value; if (!textarea || !token) return;
      textarea.value = `${textarea.value.trim()}${textarea.value.trim() ? '\n' : ''}${token}`;
      textarea.dispatchEvent(new Event('input', { bubbles: true })); textarea.focus();
    });
    definitionForm.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const steps = definitionForm.elements.steps.value.split('\n').map(line => line.trim()).filter(Boolean).map((line, index) => {
          const mode = line.startsWith('all:') ? 'all' : 'any', spec = mode === 'all' ? line.slice(4) : line;
          const approvers = spec.split(',').map(raw => raw.trim()).filter(Boolean).map(token => token.startsWith('user:') ? { kind: 'user', id: token.slice(5) } : { kind: 'role', id: token });
          return { label: `Step ${index + 1}`, mode, approvers };
        });
        if (!steps.length) throw new Error(ccText('Add at least one approval step', '至少添加一个审批步骤'));
        const rawSla = String(definitionForm.elements.slaHours.value || '').trim();
        const slaHours = rawSla ? Number(rawSla) : null;
        if (slaHours !== null && (!Number.isInteger(slaHours) || slaHours < 1 || slaHours > 720)) throw new Error(ccText('Approval time must be 1 to 720 hours', '审批时限须为 1 至 720 小时'));
        await PUT(`/api/v2/workflows/definitions/${encodeURIComponent(definitionForm.elements.type.value)}`, { steps, slaHours });
        toast(ccText('Approval route saved', '审批路径已保存'), 'success'); await renderControlCenter(root);
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  $$('[data-v2-action]', root).forEach(btn => btn.addEventListener('click', async () => {
    const action = btn.dataset.v2Action, payload = { action };
    if (action === 'assign') {
      try {
        const workflow = workflows.find(item => item.id === btn.dataset.v2Id);
        const data = await GET(`/api/v2/workflows/${encodeURIComponent(btn.dataset.v2Id)}/assignees`);
        const candidates = (data.items || []).filter(item => item.id !== workflow?.assigneeId);
        if (!candidates.length) throw new Error(ccText('No eligible person is available for assignment', '暂无可指派的整改负责人'));
        const modal = openModal({ title: ccText('Assign responsible person', '指派整改负责人'), body: `<form id="ccAssignRemediationForm"><label class="cc-field"><span>${ccText('Responsible person', '整改负责人')}</span><select name="assigneeId" required>${candidates.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${item.username ? ` · ${escapeHtml(item.username)}` : ''}</option>`).join('')}</select></label></form>`, footer: `<button class="btn" data-close>${ccText('Cancel', '取消')}</button><button class="btn btn-primary" id="ccAssignRemediationSave">${ccText('Save assignment', '保存指派')}</button>` });
        $('#ccAssignRemediationSave', modal).addEventListener('click', async () => {
          const assigneeId = String(new FormData($('#ccAssignRemediationForm', modal)).get('assigneeId') || '');
          try { await POST(`/api/v2/workflows/${encodeURIComponent(btn.dataset.v2Id)}/actions`, { action: 'assign', assigneeId }); closeModal(); toast(ccText('Responsible person updated', '整改负责人已更新'), 'success'); await renderControlCenter(root); }
          catch (err) { toast(err.message, 'error'); }
        });
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (action === 'execution') {
      const workflow = workflows.find(item => item.id === btn.dataset.v2Id), needsExternalRef = workflow?.type !== 'store_remediation';
      const modal = openModal({ title: ccText('Record execution', '登记执行结果'), body: `<form id="ccExecutionForm" class="cc-form-grid"><label class="cc-field cc-wide"><span>${ccText('External document number', '外部单据编号')}${needsExternalRef ? ' *' : ''}</span><input name="externalDocumentNumber" maxlength="120" ${needsExternalRef ? 'required' : ''} placeholder="${ccText('Enter the number from your business system', '填写金蝶或其他业务系统单据编号')}"/></label><label class="cc-field"><span>${ccText('Execution status', '执行状态')}</span><select name="executionStatus"><option value="completed">${ccText('Completed', '已完成')}</option><option value="in_progress">${ccText('In progress', '进行中')}</option></select></label><label class="cc-field cc-wide"><span>${ccText('Execution note', '执行说明')}</span><textarea name="note" rows="3" maxlength="1000"></textarea></label></form>`, footer: `<button class="btn" data-close>${ccText('Cancel', '取消')}</button><button class="btn btn-primary" id="ccExecutionSave">${ccText('Save execution', '保存执行记录')}</button>`, wide: true });
      $('#ccExecutionSave', modal).addEventListener('click', async () => {
        const fd = new FormData($('#ccExecutionForm', modal)), externalDocumentNumber = String(fd.get('externalDocumentNumber') || '').trim();
        if (needsExternalRef && !externalDocumentNumber) { toast(ccText('Enter the external document number', '请填写外部单据编号'), 'error'); return; }
        try { await POST(`/api/v2/workflows/${encodeURIComponent(btn.dataset.v2Id)}/actions`, { action, externalDocumentNumber, executionStatus: fd.get('executionStatus'), note: fd.get('note') }); closeModal(); toast(ccText('Execution recorded', '执行记录已保存'), 'success'); await renderControlCenter(root); }
        catch (err) { toast(err.message, 'error'); }
      });
      return;
    }
    if (action === 'reject' || action === 'return' || action === 'review_return') { payload.note = window.prompt(ccText('Enter a reason', '请输入原因')) || ''; if (!payload.note) return; }
    try { await POST(`/api/v2/workflows/${encodeURIComponent(btn.dataset.v2Id)}/actions`, payload); toast(ccText('Workflow updated', '流程已更新'), 'success'); await renderControlCenter(root); }
    catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-v2-delegate]', root).forEach(btn => btn.addEventListener('click', async () => {
    try {
      const data = await GET(`/api/v2/workflows/${encodeURIComponent(btn.dataset.v2Delegate)}/delegates`);
      const slots = data.slots || [], users = data.users || [];
      if (!slots.length || !users.length) { toast(ccText('No eligible approver or approval slot is available', '当前没有可转交的审批名额或合适审批人'), 'error'); return; }
      const modal = openModal({ title: ccText('Delegate approval', '转交审批'), body: `<form id="ccDelegateForm" class="cc-form-grid">${slots.length > 1 ? `<label class="cc-field"><span>${ccText('Approval slot', '审批名额')}</span><select name="approverKey">${slots.map(x => `<option value="${escapeHtml(x.key)}">${escapeHtml(x.label)}</option>`).join('')}</select></label>` : `<input type="hidden" name="approverKey" value="${escapeHtml(slots[0].key)}"/>`}<label class="cc-field cc-wide"><span>${ccText('Delegate to', '转交给')}</span><select name="delegateUserId" required>${users.map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)} · ${escapeHtml(x.username)}</option>`).join('')}</select></label><label class="cc-field cc-wide"><span>${ccText('Note', '说明')}</span><textarea name="note" rows="3" maxlength="1000"></textarea></label></form>`, footer: `<button class="btn" data-close>${ccText('Cancel', '取消')}</button><button class="btn btn-primary" id="ccDelegateSave">${ccText('Confirm delegation', '确认转交')}</button>`, wide: true });
      $('#ccDelegateSave', modal).addEventListener('click', async () => {
        const payload = Object.fromEntries(new FormData($('#ccDelegateForm', modal)).entries());
        try { await POST(`/api/v2/workflows/${encodeURIComponent(btn.dataset.v2Delegate)}/actions`, { action: 'delegate', ...payload }); closeModal(); toast(ccText('Approval delegated', '审批已转交'), 'success'); await renderControlCenter(root); }
        catch (err) { toast(err.message, 'error'); }
      });
    } catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-v2-comment]', root).forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault(); const comment = new FormData(form).get('comment');
    try { await POST(`/api/v2/workflows/${encodeURIComponent(form.dataset.v2Comment)}/actions`, { action: 'comment', comment }); toast(ccText('Comment added', '备注已添加'), 'success'); await renderControlCenter(root); }
    catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-v2-attachment]', root).forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault(); const fd = new FormData(form), file = fd.get('file'); if (!file || !file.size) return;
    try {
      const mimeType = uploadMimeType(file);
      const data = await readFileAsDataUrl(file, mimeType);
      await POST(`/api/v2/workflows/${encodeURIComponent(form.dataset.v2Attachment)}/attachments`, { fileName: file.name, mimeType, evidenceType: fd.get('evidenceType'), data });
      toast(ccText('Evidence uploaded', '凭证已上传'), 'success'); await renderControlCenter(root);
    } catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-task-checklist]', root).forEach(input => input.addEventListener('change', async () => { try { await POST(`/api/v2/tasks/${encodeURIComponent(input.dataset.taskChecklist)}/checklist/${encodeURIComponent(input.dataset.taskCheckId)}`, { completed: input.checked }); await renderControlCenter(root); } catch (err) { input.checked = !input.checked; toast(err.message, 'error'); } }));
  $$('[data-task-comment-form]', root).forEach(form => form.addEventListener('submit', async e => { e.preventDefault(); const comment = new FormData(form).get('comment'); try { await POST(`/api/v2/tasks/${encodeURIComponent(form.dataset.taskCommentForm)}/comments`, { comment }); toast(ccText('Comment added', '备注已添加'), 'success'); await renderControlCenter(root); } catch (err) { toast(err.message, 'error'); } }));
  $$('[data-task-attachment-form]', root).forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault(); const file = new FormData(form).get('file'); if (!file || !file.size) return;
    const mimeType = uploadMimeType(file);
    try {
      await POST(`/api/v2/tasks/${encodeURIComponent(form.dataset.taskAttachmentForm)}/attachments`, { fileName: file.name, mimeType, data: await readFileAsDataUrl(file, mimeType) });
      toast(ccText('Evidence uploaded', '完成凭证已上传'), 'success'); await renderControlCenter(root);
    } catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-task-complete]', root).forEach(btn => btn.addEventListener('click', async () => { try { await POST(`/api/v2/tasks/${encodeURIComponent(btn.dataset.taskComplete)}/complete`, {}); await renderControlCenter(root); } catch (err) { toast(err.message, 'error'); } }));
  $$('[data-task-edit]', root).forEach(btn => btn.addEventListener('click', () => {
    const task = tasks.find(x => x.id === btn.dataset.taskEdit); if (!task) return;
    const modal = openModal({ title: ccText('Edit task', '编辑任务'), body: `<form id="ccTaskEdit" class="cc-form-grid"><label class="cc-field cc-wide"><span>${ccText('Task title', '任务名称')}</span><input name="title" required maxlength="180" value="${escapeHtml(task.title)}"/></label><label class="cc-field"><span>${ccText('Priority', '优先级')}</span><select name="priority">${[['low','低'],['normal','普通'],['high','高'],['urgent','紧急']].map(([v,l]) => `<option value="${v}" ${v === task.priority ? 'selected' : ''}>${ccText(v, l)}</option>`).join('')}</select></label><label class="cc-field"><span>${ccText('Due date', '截止日期')}</span><input type="date" name="dueAt" value="${escapeHtml(task.dueAt ? task.dueAt.slice(0,10) : '')}"/></label><label class="cc-field"><span>${ccText('Status', '状态')}</span><select name="status"><option value="open" ${task.status === 'open' ? 'selected' : ''}>${ccText('Open', '待处理')}</option><option value="in_progress" ${task.status === 'in_progress' ? 'selected' : ''}>${ccText('In progress', '进行中')}</option></select></label>${can('task.assign') ? `<label class="cc-field"><span>${ccText('Assignee', '负责人')}</span><select name="assigneeId"><option value="">${ccText('Unassigned', '暂不指派')}</option>${assignees.map(a => `<option value="${escapeHtml(a.id)}" ${a.id === task.assigneeId ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}</select></label>` : ''}<label class="cc-field cc-wide"><span>${ccText('Description', '任务说明')}</span><textarea name="description" rows="3">${escapeHtml(task.description || '')}</textarea></label></form>`, footer: `<button class="btn" data-close>${ccText('Cancel', '取消')}</button><button class="btn btn-primary" id="ccTaskSave">${ccText('Save', '保存')}</button>`, wide: true });
    $('#ccTaskSave', modal).addEventListener('click', async () => { const fd = new FormData($('#ccTaskEdit', modal)); const payload = Object.fromEntries(fd.entries()); if (!can('task.assign')) delete payload.assigneeId; try { await PUT(`/api/v2/tasks/${encodeURIComponent(task.id)}`, payload); closeModal(); await renderControlCenter(root); } catch (err) { toast(err.message, 'error'); } });
  }));
  $$('[data-notice-read]', root).forEach(btn => btn.addEventListener('click', async () => { try { await POST(`/api/v2/notifications/${encodeURIComponent(btn.dataset.noticeRead)}/read`, {}); await renderControlCenter(root); } catch (err) { toast(err.message, 'error'); } }));
  $$('[data-notice-page]', root).forEach(button => button.addEventListener('click', async () => { state.notificationOffset = Math.max(0, Number(noticeData.offset || 0) + (button.dataset.noticePage === 'next' ? Number(noticeData.limit || 25) : -Number(noticeData.limit || 25))); await renderControlCenter(root); }));
  $('#ccAuditFilterForm')?.addEventListener('submit', async e => {
    e.preventDefault(); const fd = new FormData(e.currentTarget);
    const from = String(fd.get('from') || ''), to = String(fd.get('to') || '');
    if (from && to && from > to) { toast(ccText('Start date must be before end date', '开始日期不能晚于结束日期'), 'error'); return; }
    state.ccAuditFilters = { q: String(fd.get('q') || '').trim(), from, to }; state.ccAuditOffset = 0;
    try { await renderControlCenter(root); } catch (err) { toast(err.message, 'error'); }
  });
  $('[data-audit-reset]', root)?.addEventListener('click', async () => { state.ccAuditFilters = { q: '', from: '', to: '' }; state.ccAuditOffset = 0; await renderControlCenter(root); });
  $$('[data-audit-page]', root).forEach(button => button.addEventListener('click', async () => {
    state.ccAuditOffset = Math.max(0, Number(auditData.offset || 0) + (button.dataset.auditPage === 'next' ? Number(auditData.limit || 25) : -Number(auditData.limit || 25)));
    await renderControlCenter(root);
  }));
}

function approvalPill(status) {
  const map = {
    pending:  ['ap-pending',  'approval.stPending'],
    approved: ['ap-approved', 'approval.stApproved'],
    rejected: ['ap-rejected', 'approval.stRejected'],
  };
  const [cls, key] = map[status] || map.pending;
  return `<span class="ap-pill ${cls}">${escapeHtml(t(key))}</span>`;
}

async function renderApprovals(root) {
  const cur = (state.approvals && state.approvals.status) || 'pending';
  const data = await GET('/api/pending?status=' + encodeURIComponent(cur));
  const items = data.items || [];
  // 前端门禁：「通过」与「驳回」是两个彼此独立的能力，矩阵里未必同时授予。
  //   store_manager / regional_manager 只有 approval.view + approval.create ——
  //   若照旧无条件渲染按钮，他们每点一次都只会拿到后端 403。
  //   这里按各自权限决定是否渲染（真正的安全边界仍在后端）。
  const canApprove = can('approval.approve');
  const canReject = can('approval.reject');

  root.innerHTML = `
    <div class="page-header">
      <div class="page-header-text">
        <div class="page-title">${t('approval.title')}</div>
        <div class="page-subtitle">${escapeHtml(t('approval.subtitle'))}</div>
      </div>
      <div class="page-spacer"></div>
      <select class="filter-select" id="apStatus">
        ${[['pending', 'approval.tabPending'], ['approved', 'approval.tabApproved'],
           ['rejected', 'approval.tabRejected'], ['all', 'approval.tabAll']]
          .map(([k, key]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${escapeHtml(t(key))}</option>`).join('')}
      </select>
    </div>
    <div id="apList" class="ap-list"></div>
  `;

  $('#apStatus').addEventListener('change', async (e) => {
    state.approvals = { status: e.target.value };
    await renderScreen();
  });

  const list = $('#apList');
  if (!items.length) {
    list.innerHTML = `<div class="card card-empty">${escapeHtml(t('approval.empty'))}</div>`;
    return;
  }

  list.innerHTML = items.map(r => {
    // 已通过的显示实际发放值，未通过的显示预估值
    const showPts = (r.status === 'approved' && r.grantedPoints != null) ? r.grantedPoints
      : (r.estPoints != null ? r.estPoints : r.points);
    const desc = r.kind === 'purchase'
      ? t('approval.kindPurchase', { amount: peso(r.purchaseAmount) })
      : t('approval.kindEarn', { points: fmt(r.points) });
    return `
      <div class="card ap-card" data-id="${escapeHtml(r.id)}">
        <div class="ap-main">
          <div class="ap-line1">
            <span class="ap-name">${escapeHtml(r.memberName)}</span>
            ${approvalPill(r.status)}
          </div>
          <div class="ap-desc">${escapeHtml(desc)}</div>
          ${r.reason ? `<div class="ap-reason">${escapeHtml(r.reason)}</div>` : ''}
          <div class="ap-meta">
            <span>${escapeHtml(tStore(r.storeName))}</span>
            <span>${escapeHtml(r.memberPhone || '')}</span>
            <span>${escapeHtml(t('approval.by'))} ${escapeHtml(r.requestedByName || '')}</span>
            <span>${escapeHtml((r.requestedAt || '').slice(0, 16).replace('T', ' '))}</span>
          </div>
          ${(r.status !== 'pending' && r.decisionNote) ? `<div class="ap-note">${escapeHtml(t('approval.note'))}：${escapeHtml(r.decisionNote)}</div>` : ''}
        </div>
        <div class="ap-side">
          <div class="ap-points">${r.status === 'approved' ? '+' : ''}${fmt(showPts)}<span class="ap-unit">${escapeHtml(t('mall.pointsUnit'))}</span></div>
          ${r.status === 'pending'
            ? ((canApprove || canReject) ? `
            <div class="ap-actions">
              ${canApprove ? `<button class="btn btn-sm btn-primary" data-act="approve">${t('approval.approve')}</button>` : ''}
              ${canReject ? `<button class="btn btn-sm" data-act="reject">${t('approval.reject')}</button>` : ''}
            </div>` : '')
            : `<div class="ap-decided">${escapeHtml(r.decidedByName || '')}</div>`}
        </div>
      </div>`;
  }).join('');

  // 事件委托：列表每次都整段重绘，绑在按钮上会丢
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.ap-card');
    const id = card && card.dataset.id;
    if (!id) return;
    if (btn.dataset.act === 'approve') {
      const yes = await confirmDialog({
        title: t('approval.approveTitle'),
        body: t('approval.approveBody'),
        confirmLabel: t('approval.approve'),
      });
      if (!yes) return;
      try {
        const r = await POST('/api/pending/' + encodeURIComponent(id) + '/approve', {});
        toast(t('approval.approved', { points: fmt(r.request && r.request.grantedPoints) }), 'success');
        await renderScreen();
      } catch (err) { toast(err.message, 'error'); }
    } else {
      openRejectModal(id);
    }
  });
}

function openRejectModal(id) {
  const root = openModal({
    title: t('approval.rejectTitle'),
    body: `
      <form data-form>
        <div class="modal-form-row">
          <label><span>${escapeHtml(t('approval.rejectReason'))}</span>
          <textarea name="note" rows="3" required placeholder="${escapeHtml(t('approval.rejectReasonPh'))}"></textarea></label>
        </div>
      </form>`,
    footer: `<button class="btn" data-close>${t('common.cancel')}</button>
             <button class="btn btn-danger" id="doReject">${t('approval.reject')}</button>`,
  });
  $('#doReject', root).addEventListener('click', async () => {
    const note = ((root.querySelector('textarea[name=note]') || {}).value || '').trim();
    if (!note) { toast(t('approval.needReason'), 'error'); return; }
    try {
      await POST('/api/pending/' + encodeURIComponent(id) + '/reject', { note });
      closeModal();
      toast(t('approval.rejected'), 'success');
      await renderScreen();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// =================== 积分商城（2026-09-19 上线） ===================
// 店长代客兑换：选会员 → 选商品 → 扣分生成兑换单 → 点「已发放」。

function productImgHtml(p) {
  return p.image
    ? `<img class="mall-img" src="/api/mall/image/${encodeURIComponent(p.image)}" alt="${escapeHtml(p.name)}" loading="lazy" />`
    : `<div class="mall-img mall-img-empty">${escapeHtml(t('mall.noImage'))}</div>`;
}

async function renderMall(root) {
  state.mall = state.mall || { tab: 'shop', member: null };
  // 「管理商品」入口需要商品维护能力（原为 role === 'admin'）
  const canManageProducts = can('mall.create');
  const [prodRes, orderRes] = await Promise.all([
    GET('/api/products'),
    GET('/api/redemptions?status=all'),
  ]);
  const products = prodRes.items || [];
  const orders = orderRes.items || [];

  root.innerHTML = `
    <div class="page-header">
      <div class="page-header-text">
        <div class="page-title">${t('mall.title')}</div>
        <div class="page-subtitle">${escapeHtml(t('mall.subtitle'))}</div>
      </div>
      <div class="page-spacer"></div>
      ${canManageProducts ? `<button class="btn" id="btnManageProducts">${t('mall.manage')}</button>` : ''}
    </div>
    <div class="db-tabs" id="mallTabs">
      <button class="db-tab ${state.mall.tab === 'shop' ? 'active' : ''}" data-tab="shop">${t('mall.tabShop')}</button>
      <button class="db-tab ${state.mall.tab === 'orders' ? 'active' : ''}" data-tab="orders">${t('mall.tabOrders')} (${orders.length})</button>
    </div>
    <div id="mallBody"></div>
  `;

  $('#mallTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    state.mall.tab = b.dataset.tab;
    renderScreen();
  });
  if (canManageProducts) $('#btnManageProducts').addEventListener('click', openProductManager);

  const body = $('#mallBody');
  if (state.mall.tab === 'orders') renderMallOrders(body, orders);
  else renderMallShop(body, products);
}

function renderMallShop(body, products) {
  const sel = state.mall.member;
  const list = products.filter(p => p.active !== false);

  body.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${escapeHtml(t('mall.pickMember'))}</div>
          <div class="card-subtitle">${escapeHtml(t('mall.pickMemberSub'))}</div>
        </div>
      </div>
      <div class="filter-bar">
        <input class="filter-input" id="mallMemberSearch" type="search"
               placeholder="${escapeHtml(t('mall.searchPh'))}" autocomplete="off" />
      </div>
      <div id="mallMemberResult" class="mall-search-result"></div>
      ${sel ? `
        <div class="mall-selected">
          <div>
            <div class="mall-sel-name">${escapeHtml(sel.name)}</div>
            <div class="mall-sel-sub">${escapeHtml(sel.phone || '')} · ${escapeHtml(tStore(sel.storeName))}</div>
          </div>
          <div class="page-spacer"></div>
          <div class="mall-sel-pts">${fmt(sel.points)}<span class="ap-unit">${escapeHtml(t('mall.pointsUnit'))}</span></div>
          <button class="btn btn-sm" id="mallClearMember">${t('mall.clear')}</button>
        </div>` : ''}
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="card-header">
        <div class="card-title">${escapeHtml(t('mall.products'))}</div>
        <div class="page-spacer"></div>
        <div class="card-subtitle">${list.length ? '' : escapeHtml(t('mall.noProducts'))}</div>
      </div>
      ${list.length ? `<div class="mall-grid">${list.map(productCardHtml).join('')}</div>` : ''}
    </div>
  `;

  const input = $('#mallMemberSearch');
  const result = $('#mallMemberResult');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) { result.innerHTML = ''; return; }
      try {
        const res = await GET('/api/members?q=' + encodeURIComponent(q) + '&page=1&pageSize=8');
        const items = res.items || [];
        result.innerHTML = items.length
          ? items.map(m => `<div class="mall-hit" data-id="${escapeHtml(m.id)}">
              <span class="mall-hit-name">${escapeHtml(m.name)}</span>
              <span class="mall-hit-sub">${escapeHtml(m.phone || '')} · ${fmt(m.points)} ${escapeHtml(t('mall.pointsUnit'))}</span>
            </div>`).join('')
          : `<div class="mall-hit-empty">${escapeHtml(t('mall.noMember'))}</div>`;
      } catch (e) { result.innerHTML = ''; }
    }, 250);
  });

  // 事件委托：搜索结果会反复重绘
  result.addEventListener('click', async (e) => {
    const hit = e.target.closest('.mall-hit');
    if (!hit) return;
    const id = hit.dataset.id;
    const isSame = state.mall.member && state.mall.member.id === id;
    if (isSame) { state.mall.member = null; renderScreen(); return; }
    try {
      const m = await GET('/api/members/' + encodeURIComponent(id));
      state.mall.member = m;
      renderScreen();
    } catch (err) { toast(err.message, 'error'); }
  });

  if (sel) $('#mallClearMember').addEventListener('click', () => { state.mall.member = null; renderScreen(); });
  body.addEventListener('click', onMallRedeemClick);
}

function productCardHtml(p) {
  const sel = state.mall.member;
  const affordable = sel && Number(sel.points || 0) >= Number(p.points || 0);
  const disabled = !sel || !affordable;
  // 前端门禁：兑换需要 mall.redeem。有 mall.view 但没有它（sales / warehouse / owner / hq_operator）
  //   时不要渲染兑换按钮，否则点了必然 403。
  const canRedeem = can('mall.redeem');
  return `
    <div class="mall-card">
      ${productImgHtml({ image: p.image, name: p.name })}
      <div class="mall-card-body">
        <div class="mall-card-name">${escapeHtml(p.name)}</div>
        ${p.description ? `<div class="mall-card-desc">${escapeHtml(p.description)}</div>` : ''}
        <div class="mall-card-pts">${fmt(p.points)} <span class="ap-unit">${escapeHtml(t('mall.pointsUnit'))}</span></div>
        ${canRedeem ? `
        <button class="btn btn-sm ${disabled ? '' : 'btn-primary'}" data-redeem="${escapeHtml(p.id)}" ${disabled ? 'disabled' : ''}>
          ${!sel ? t('mall.needMember') : (affordable ? t('mall.redeem') : t('mall.notEnough'))}
        </button>` : ''}
      </div>
    </div>`;
}

async function onMallRedeemClick(e) {
  const btn = e.target.closest('[data-redeem]');
  if (!btn || btn.disabled) return;
  const productId = btn.dataset.redeem;
  const member = state.mall.member;
  if (!member) return;
  const card = btn.closest('.mall-card');
  const nameEl = card && card.querySelector('.mall-card-name');
  const productName = nameEl ? nameEl.textContent : '';
  const yes = await confirmDialog({
    title: t('mall.confirmTitle'),
    body: t('mall.confirmBody', { name: escapeHtml(member.name), product: escapeHtml(productName) }),
    confirmLabel: t('mall.redeem'),
  });
  if (!yes) return;
  try {
    const r = await POST('/api/redemptions', { memberId: member.id, productId });
    toast(t('mall.redeemDone', { product: r.redemption.productName, points: fmt(r.redemption.points) }), 'success');
    state.mall.member = r.member;
    state.mall.tab = 'orders';
    await renderScreen();
  } catch (err) { toast(err.message, 'error'); }
}

function renderMallOrders(body, orders) {
  if (!orders.length) {
    body.innerHTML = `<div class="card card-empty">${escapeHtml(t('mall.noOrders'))}</div>`;
    return;
  }
  // 前端门禁：「已发放」与「取消」是两个独立能力（mall.fulfill / mall.cancel）。
  //   只判 mall.view 就渲染会出现「点了必然 403」的按钮。
  const canFulfill = can('mall.fulfill');
  const canCancel = can('mall.cancel');
  body.innerHTML = `<div class="mall-orders">${orders.map(o => {
    const st = o.status === 'fulfilled' ? 'ap-approved' : (o.status === 'cancelled' ? 'ap-rejected' : 'ap-pending');
    const stKey = o.status === 'fulfilled' ? 'mall.stFulfilled' : (o.status === 'cancelled' ? 'mall.stCancelled' : 'mall.stPending');
    return `
      <div class="card mall-order" data-id="${escapeHtml(o.id)}">
        <div class="mall-order-img">${productImgHtml({ image: o.productImage, name: o.productName })}</div>
        <div class="mall-order-main">
          <div class="ap-line1">
            <span class="ap-name">${escapeHtml(o.productName)}</span>
            <span class="ap-pill ${st}">${escapeHtml(t(stKey))}</span>
          </div>
          <div class="ap-meta">
            <span>${escapeHtml(o.memberName)}</span>
            <span>${escapeHtml(tStore(o.storeName))}</span>
            <span>${escapeHtml((o.createdAt || '').slice(0, 16).replace('T', ' '))}</span>
          </div>
          <div class="ap-meta">
            <span>-${fmt(o.points)} ${escapeHtml(t('mall.pointsUnit'))}</span>
            ${o.fulfilledByName ? `<span>${escapeHtml(t('mall.by'))} ${escapeHtml(o.fulfilledByName)}</span>` : ''}
          </div>
        </div>
        <div class="ap-side">
          ${(o.status === 'pending' && (canFulfill || canCancel)) ? `
            <div class="ap-actions">
              ${canFulfill ? `<button class="btn btn-sm btn-primary" data-order="fulfill">${t('mall.fulfill')}</button>` : ''}
              ${canCancel ? `<button class="btn btn-sm" data-order="cancel">${t('mall.cancel')}</button>` : ''}
            </div>` : ''}
        </div>
      </div>`;
  }).join('')}</div>`;

  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-order]');
    if (!btn) return;
    const card = btn.closest('.mall-order');
    const id = card && card.dataset.id;
    if (!id) return;
    if (btn.dataset.order === 'fulfill') {
      try {
        await POST('/api/redemptions/' + encodeURIComponent(id) + '/fulfill', {});
        toast(t('mall.fulfilled'), 'success');
        await renderScreen();
      } catch (err) { toast(err.message, 'error'); }
    } else {
      const yes = await confirmDialog({
        title: t('mall.cancelTitle'),
        body: t('mall.cancelBody'),
        confirmLabel: t('mall.cancel'),
        danger: true,
      });
      if (!yes) return;
      try {
        await POST('/api/redemptions/' + encodeURIComponent(id) + '/cancel', {});
        toast(t('mall.cancelled'), 'success');
        await renderScreen();
      } catch (err) { toast(err.message, 'error'); }
    }
  });
}

/** 商品管理（仅管理员）：列表 + 新增/编辑 + 图片上传 */
async function openProductManager() {
  const products = (await GET('/api/products')).items || [];
  const root = openModal({
    wide: true,
    title: t('mall.manageTitle'),
    body: `<div id="pmList"></div>
      <div class="pm-add">
        <div class="card-title" style="margin-bottom:8px;">${escapeHtml(t('mall.addTitle'))}</div>
        <div class="modal-form-row">
          <label><span>${escapeHtml(t('mall.name'))}</span><input name="name" type="text" maxlength="60" placeholder="${escapeHtml(t('mall.namePh'))}" /></label>
        </div>
        <div class="modal-form-row">
          <label><span>${escapeHtml(t('mall.points'))}</span><input name="points" type="number" min="1" step="1" placeholder="500" /></label>
        </div>
        <div class="modal-form-row">
          <label><span>${escapeHtml(t('mall.desc'))}</span><textarea name="description" rows="2" maxlength="300" placeholder="${escapeHtml(t('mall.descPh'))}"></textarea></label>
        </div>
        <div class="modal-form-row">
          <label><span>${escapeHtml(t('mall.image'))}</span>
            <input type="file" id="pmFile" accept="image/png,image/jpeg,image/webp" />
          </label>
        </div>
        <div id="pmPreview" class="pm-preview"></div>
      </div>`,
    footer: `<button class="btn" data-close>${t('common.close')}</button>
             <button class="btn btn-primary" id="pmAdd">${t('mall.add')}</button>`,
  });

  let pendingImage = null;

  const renderList = async () => {
    const list = (await GET('/api/products')).items || [];
    $('#pmList', root).innerHTML = list.length ? list.map(p => `
      <div class="pm-row">
        <div class="pm-row-img">${productImgHtml({ image: p.image, name: p.name })}</div>
        <div class="pm-row-main">
          <div class="pm-row-name">${escapeHtml(p.name)} ${p.active === false ? `<span class="ap-pill ap-rejected">${escapeHtml(t('mall.off'))}</span>` : ''}</div>
          <div class="pm-row-sub">${fmt(p.points)} ${escapeHtml(t('mall.pointsUnit'))}${p.description ? ' · ' + escapeHtml(p.description) : ''}</div>
        </div>
        <div class="pm-row-actions">
          <button class="btn btn-sm" data-pm="toggle" data-id="${escapeHtml(p.id)}">${p.active === false ? t('mall.on') : t('mall.off')}</button>
        </div>
      </div>`).join('') : `<div class="pm-empty">${escapeHtml(t('mall.noProducts'))}</div>`;
  };
  await renderList();

  // 图片先在本地压到最长边 800px 再上传，避免 3MB 上限被随手拍的照片撑爆
  $('#pmFile', root).addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await shrinkImage(file, 800);
      const r = await POST('/api/products/image', { image: dataUrl });
      pendingImage = r.file;
      $('#pmPreview', root).innerHTML = `<img src="/api/mall/image/${encodeURIComponent(r.file)}" class="pm-preview-img" alt="" />`;
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#pmAdd', root).addEventListener('click', async () => {
    const name = (root.querySelector('input[name=name]') || {}).value || '';
    const pts = Number((root.querySelector('input[name=points]') || {}).value || 0);
    const description = (root.querySelector('textarea[name=description]') || {}).value || '';
    if (!name.trim()) { toast(t('mall.needName'), 'error'); return; }
    if (!(pts > 0)) { toast(t('mall.needPoints'), 'error'); return; }
    try {
      await POST('/api/products', { name: name.trim(), points: Math.round(pts), description, image: pendingImage });
      pendingImage = null;
      $('#pmPreview', root).innerHTML = '';
      root.querySelector('input[name=name]').value = '';
      root.querySelector('input[name=points]').value = '';
      root.querySelector('textarea[name=description]').value = '';
      toast(t('mall.added'), 'success');
      await renderList();
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#pmList', root).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-pm="toggle"]');
    if (!btn) return;
    const id = btn.dataset.id;
    const list = (await GET('/api/products')).items || [];
    const p = list.find(x => x.id === id);
    if (!p) return;
    try {
      await PUT('/api/products/' + encodeURIComponent(id), { active: p.active === false });
      toast(t('mall.updated'), 'success');
      await renderList();
    } catch (err) { toast(err.message, 'error'); }
  });
}

/** 把图片压到指定最长边后再转 base64（dataURL） */
function shrinkImage(file, maxSide) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t('mall.imgReadFail')));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error(t('mall.imgReadFail')));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// =================== 工具 ===================
function fmt(n) { return Number(n || 0).toLocaleString(); }
function peso(n) { return '₱ ' + fmt(Math.round(Number(n || 0))); }
function levelMeta(key) {
  return ({
    silver: { label: t('level.silver'), cls: 'silver' },
    gold: { label: t('level.gold'), cls: 'gold' },
    platinum: { label: t('level.platinum'), cls: 'platinum' },
    partner: { label: t('level.partner'), cls: 'partner' },
    bronze: { label: t('level.bronze'), cls: 'bronze' },
  })[key] || { label: key, cls: 'silver' };
}
function typeMeta(key) {
  return key === 'b2b'
    ? { label: t('type.b2b'), cls: 'pill-b2b' }
    : { label: t('type.retail'), cls: 'pill-retail' };
}
function statusMeta(key) {
  return key === 'frozen'
    ? { label: t('status.frozen'), cls: 'pill-frozen', dot: false }
    : { label: t('status.active'), cls: 'pill-active', dot: true };
}
function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// =================== 弹窗 ===================
let activeModal = null;
function openModal({ title, body, footer, wide = false }) {
  closeModal();
  const root = $('#modalRoot');
  root.classList.remove('hidden');
  root.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-header">
        <div class="modal-title">${escapeHtml(title)}</div>
        <button class="modal-close" data-close>✕</button>
      </div>
      <div class="modal-body">${body}</div>
      <div class="modal-footer">${footer || `<button class="btn" data-close>${t('common.close')}</button>`}</div>
    </div>
  `;
  root.addEventListener('click', closeOnBackdrop);
  $$('[data-close]', root).forEach(b => b.addEventListener('click', closeModal));
  activeModal = root;
  return root;
}
function closeModal() {
  if (activeModal) {
    activeModal.classList.add('hidden');
    activeModal.innerHTML = '';
    activeModal = null;
  }
}
function closeOnBackdrop(e) { if (e.target === activeModal) closeModal(); }

/** 通用二次确认弹窗：返回 Promise<boolean>。用于规则变更、人工调分等高风险操作。 */
function confirmDialog({ title, body, confirmLabel, danger = false }) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; closeModal(); resolve(v); };
    const root = openModal({
      title,
      body: `<div style="font-size:14px;line-height:1.75;">${body}</div>`,
      footer: `
        <button class="btn" id="cdCancel">${t('common.cancel')}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cdOk">${escapeHtml(confirmLabel || t('common.confirm'))}</button>
      `,
    });
    $('#cdOk', root).addEventListener('click', () => finish(true));
    $('#cdCancel', root).addEventListener('click', () => finish(false));
    // 点遮罩或按 ✕ 关掉也算取消
    root.addEventListener('click', e => { if (e.target === root) finish(false); });
  });
}

/** 规则里「变更需二次确认」是否开启。规则页没访问过时按需拉一次。 */
async function rulesRequireConfirm() {
  if (!state.rules) {
    try { state.rules = await GET('/api/rules'); } catch (e) { return false; }
  }
  return !!state.rules?.rules?.requireConfirm;
}

function formFromTemplate(html, handler) {
  // 弹窗中通过 form[data-form] 提交
  const form = activeModal.querySelector('form[data-form]');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const data = {};
    for (const [k, v] of fd.entries()) data[k] = v;
    const errEl = form.querySelector('.modal-form-error');
    if (errEl) errEl.textContent = '';
    try { await handler(data, form); }
    catch (err) { if (errEl) errEl.textContent = tMsg(err.message); }
  });
}

// =================== 数据总览 ===================
async function renderDashboard(root) {
  const data = await GET('/api/dashboard');
  state.dashboard = data;
  // 范围文案由「权限的数据范围」推出，而不是判断角色名：
  // store / region / self → 只看本店/本区；global / hq / philippines → 全部门店。
  const narrow = !isWideScope('dashboard.view');
  const storeName = narrow ? tStore(state.stores.find(s => s.id === state.me.storeId)?.name || '') : '';
  const scope = narrow ? storeName : t('dash.allStores');
  // 读不到同步状态时，副标题里就不提数据存放位置，
  // 否则 state.sheets 为空会被当成「本地存储」，显示与实际不符。
  const canSeeSync = can('sync.view');
  const syncLabel = canSeeSync
    ? (state.sheets?.configured ? t('dash.syncedToSheets') : t('dash.localOnly'))
    : '';
  const subTitle = narrow
    ? (canSeeSync
      ? t('biz.overview.subtitleStore', { store: storeName })
      : t('dash.subtitleStoreNoSync', { store: storeName }))
    : (canSeeSync
      ? t('biz.overview.subtitleAll', { n: data.storeDist.length })
      : t('dash.subtitleAllNoSync', { n: data.storeDist.length }));
  root.innerHTML = `
    <div class="dash-hero">
      <div class="dash-hero-top">
        <div>
          <h1 class="dash-hero-title">${t('biz.overview.title')}</h1>
          <div class="dash-hero-tagline">${t('dash.heroTagline')}</div>
          <div class="dash-hero-scope">${escapeHtml(subTitle)}</div>
        </div>
        <div class="dash-hero-spacer"></div>
        ${can('report.export') ? `<button class="btn" id="btnExport">${t('dash.exportReport')}</button>` : ''}
      </div>
      <div class="kpi-glass-row">
        <div class="kpi-glass">
          <div class="kpi-glass-head">
            <div class="kpi-glass-ico c-green"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M4 20V10M9.3 20V4M14.7 20v-8M20 20V7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></div>
            <div class="kpi-glass-label">${t('biz.kpiSales')}</div>
          </div>
          <div class="kpi-glass-value">${t('biz.noSalesData')}</div>
          <div class="kpi-glass-sub is-pending">${t('biz.dataPending')}</div>
        </div>
        <div class="kpi-glass">
          <div class="kpi-glass-head">
            <div class="kpi-glass-ico c-blue"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M3.5 4.5h2.2l2 11h10.6l2-8H7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9.5" cy="19" r="1.5" fill="currentColor"/><circle cx="16.5" cy="19" r="1.5" fill="currentColor"/></svg></div>
            <div class="kpi-glass-label">${t('biz.kpiOrders')}</div>
          </div>
          <div class="kpi-glass-value">${t('biz.noSalesData')}</div>
          <div class="kpi-glass-sub is-pending">${t('biz.dataPending')}</div>
        </div>
        <div class="kpi-glass">
          <div class="kpi-glass-head">
            <div class="kpi-glass-ico c-amber"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg></div>
            <div class="kpi-glass-label">${t('biz.kpiProductCategories')}</div>
          </div>
          <div class="kpi-glass-value">${t('biz.noSalesData')}</div>
          <div class="kpi-glass-sub is-pending">${t('biz.dataPending')}</div>
        </div>
        <div class="kpi-glass">
          <div class="kpi-glass-head">
            <div class="kpi-glass-ico c-purple"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M4.5 9l1.2-4.5h12.6L19.5 9" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M5 9v9.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" stroke="currentColor" stroke-width="1.9"/><path d="M10 19.5v-5h4v5" stroke="currentColor" stroke-width="1.9"/></svg></div>
            <div class="kpi-glass-label">${t('biz.kpiStores')}</div>
          </div>
          <div class="kpi-glass-value mono">${data.storeDist.length}</div>
          <div class="kpi-glass-sub">${narrow ? escapeHtml(storeName) : t('dash.allStores')}</div>
        </div>
      </div>
    </div>
    <div class="bento">
      <div class="card span-2">
        <div class="card-header">
          <div>
            <div class="card-title">${t('biz.trendTitle')}</div>
            <div class="card-subtitle">${t('biz.trendSub')}</div>
          </div>
        </div>
        <div class="empty-design">
          <svg class="ed-art" width="200" height="64" viewBox="0 0 200 64" fill="none">
            <path d="M6 52 C 34 48, 48 32, 74 36 S 122 50, 146 32 S 182 12, 194 15" stroke="currentColor" stroke-width="2" stroke-dasharray="5 7" stroke-linecap="round" opacity=".5"/>
            <circle cx="194" cy="15" r="3.2" fill="currentColor" opacity=".4"/>
          </svg>
          <div class="ed-title">${t('biz.noSalesData')}</div>
          <div class="ed-hint">${t('biz.trendEmptyHint')}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">${t('biz.storeOverviewTitle')}</div>
        <div class="card-subtitle">${t('biz.storeOverviewSub')}</div>
        <div class="biz-overview-stats">
          <div class="biz-overview-stat"><div class="v mono">${data.total}</div><div class="k">${t('biz.store.kpiMembers')}</div></div>
          <div class="biz-overview-stat"><div class="v mono">${data.storeDist.length}</div><div class="k">${t('biz.kpiStores')}</div></div>
          <div class="biz-overview-stat"><div class="v mono">${data.retail}</div><div class="k">${t('dash.reportRetail')}</div></div>
          <div class="biz-overview-stat"><div class="v mono">${data.b2b}</div><div class="k">${t('dash.reportB2b')}</div></div>
        </div>
        <button class="btn" data-goto="storeBiz">${t('biz.viewDetail')}</button>
      </div>
      <div class="card span-3">
        <div class="card-header">
          <div>
            <div class="card-title">${t('dash.storeDist')}</div>
            <div class="card-subtitle">${t('dash.storeDistSub')}</div>
          </div>
        </div>
        ${renderStoreDist(data.storeDist)}
      </div>
    </div>
  `;
  // 导出按钮已按 report.export 权限渲染，无权限时该节点不存在，需判空
  const exportBtn = $('#btnExport');
  if (exportBtn) exportBtn.addEventListener('click', () => exportReport(data));
  // 经营概览卡片的「查看详情」按钮，跳转到对应经营页
  $$('[data-goto]').forEach(b => b.addEventListener('click', () => setScreen(b.dataset.goto)));
}

// 门店会员分布：Horizontal Ranking Bars（真实 storeDist 数据；0 门店 → 设计化空状态，不造假数据）
function renderStoreDist(storeDist) {
  if (!storeDist.length) {
    return `
      <div class="empty-design">
        <svg class="ed-art" width="170" height="56" viewBox="0 0 170 56" fill="none">
          <path d="M8 48v-0.01M8 48h20M44 48v-14M44 48h20M80 48v-26M80 48h20M116 48v-8M116 48h20" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".45"/>
        </svg>
        <div class="ed-title">${t('biz.emptyDistTitle')}</div>
        <div class="ed-hint">${t('biz.emptyDistHint')}</div>
      </div>`;
  }
  const max = Math.max(...storeDist.map(s => s.count), 1);
  const sorted = [...storeDist].sort((a, b) => b.count - a.count);
  return `
    <div class="rank-list">
      ${sorted.map((s, i) => `
        <div class="rank-item">
          <div class="rank-no">${i + 1}</div>
          <div class="rank-name" title="${escapeHtml(tStore(s.storeName))}">${escapeHtml(tStore(s.storeName))}</div>
          <div class="rank-track"><div class="rank-fill" style="width:${Math.max(4, Math.round(s.count / max * 100))}%"></div></div>
          <div class="rank-val mono">${s.count}</div>
        </div>`).join('')}
    </div>`;
}

function renderTrendSvg(buckets) {
  const W = 800, H = 180, PAD = 30;
  const max = Math.max(1, ...buckets.flatMap(b => [b.earn, b.redeem]));
  const xs = buckets.map((_, i) => PAD + i * ((W - PAD * 2) / (buckets.length - 1)));
  const ys = v => H - PAD - (v / max) * (H - PAD * 2);
  const earnPath = buckets.map((b, i) => `${i === 0 ? 'M' : 'L'} ${xs[i]} ${ys(b.earn)}`).join(' ');
  const redeemPath = buckets.map((b, i) => `${i === 0 ? 'M' : 'L'} ${xs[i]} ${ys(b.redeem)}`).join(' ');
  const areaPath = earnPath + ` L ${xs[xs.length - 1]} ${H - PAD} L ${xs[0]} ${H - PAD} Z`;
  const labels = buckets.map((b, i) => `<text x="${xs[i]}" y="${H - 8}" font-size="10" fill="#9AA8A2" text-anchor="middle">${b.date}</text>`).join('');
  // 没有任何流水时不画平线（否则两条线重叠在 0 轴上，看着像有数据）
  const hasData = buckets.some(b => ((b.earn || 0) + (b.redeem || 0)) > 0);
  return `
    <line x1="${PAD}" y1="${PAD}" x2="${W - PAD}" y2="${PAD}" stroke="#EFF3F1"/>
    <line x1="${PAD}" y1="${H / 2}" x2="${W - PAD}" y2="${H / 2}" stroke="#EFF3F1"/>
    <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="#E4E9E5"/>
    ${hasData ? `<path d="${areaPath}" fill="#16A34A" fill-opacity="0.10"/>
    <path d="${earnPath}" stroke="#16A34A" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${redeemPath}" stroke="#F59E0B" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${xs[xs.length - 1]}" cy="${ys(buckets[buckets.length - 1].earn)}" r="4" fill="#16A34A"/>
    <circle cx="${xs[xs.length - 1]}" cy="${ys(buckets[buckets.length - 1].redeem)}" r="4" fill="#F59E0B"/>`
    : `<text x="${W / 2}" y="${H / 2 + 4}" font-size="12" fill="#9AA8A2" text-anchor="middle" font-family="Inter, sans-serif">${t('dash.trendEmpty')}</text>`}
    ${labels}
  `;
}

function exportReport(data) {
  // CSV 单元格转义：门店名里出现逗号或引号会串列
  const cell = (v) => {
    const str = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  };
  const row = (...cells) => lines.push(cells.map(cell).join(','));
  const lines = [cell(t('dash.reportTitle')), cell(t('dash.reportGenerated', { time: new Date().toLocaleString(locale()) })), ''];
  row(t('dash.reportTotal'), data.total);
  row(t('dash.reportRetail'), data.retail);
  row(t('dash.reportB2b'), data.b2b);
  row(t('dash.reportPoints'), data.points);
  row(t('dash.reportSpend'), data.spend);
  lines.push('');
  row(t('dash.reportStore'), t('dash.reportStoreCount'));
  data.storeDist.forEach(s => row(tStore(s.storeName), s.count));
  lines.push('');
  lines.push(cell(t('dash.reportTrend')));
  row(t('dash.reportBucket'), t('dash.reportEarn'), t('dash.reportRedeem'));
  data.buckets.forEach(b => row(b.date, b.earn, b.redeem));
  const csv = lines.join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `SolarPoints-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  toast(t('dash.reportDownloaded'), 'success');
}

// =================== 会员管理 ===================
async function renderMembers(root) {
  await loadMembers(1);
  // 副标题按「会员可见范围」区分，不再判断角色名
  const wideMembers = isWideScope('member.view');
  // 「新增 / 导入」入口需要建档能力。无此权限的角色（如老板、总部运营、销售、仓库、售后）
  // 隐藏入口 —— 否则点开填完表单，后端仍会按 member.create 返回 403。
  const canCreateMember = can('member.create');
  const subtitle = wideMembers
    ? t('members.subtitleAdmin', { n: fmt(state.members.total) })
    : t('members.subtitleMgr', { n: fmt(state.members.total) });
  root.innerHTML = `
    <div class="page-header">
      <div class="page-header-text">
        <div class="page-title">${t('members.title')}</div>
        <div class="page-subtitle">${subtitle}</div>
      </div>
      <div class="page-spacer"></div>
      ${canCreateMember ? `
      <button class="btn" id="btnImport">${t('members.import')}</button>
      <button class="btn btn-primary" id="btnAddMember">${t('members.add')}</button>` : ''}
    </div>
    <div class="filter-bar">
      <input class="filter-input" id="fQ" placeholder="${escapeHtml(t('members.searchPh'))}" value="${escapeHtml(state._memberQ || '')}"/>
      <select class="filter-select" id="fType">
        <option value="" ${state._memberType ? '' : 'selected'}>${t('members.allTypes')}</option>
        <option value="retail" ${state._memberType === 'retail' ? 'selected' : ''}>${t('type.retail')}</option>
        <option value="b2b" ${state._memberType === 'b2b' ? 'selected' : ''}>B2B</option>
      </select>
      ${wideMembers ? `
        <select class="filter-select" id="fStore">
          <option value="">${t('members.allStores')}</option>
          ${state.stores.map(s => `<option value="${s.id}" ${state._memberStore === s.id ? 'selected' : ''}>${escapeHtml(tStore(s.name))}</option>`).join('')}
        </select>` : ''}
      <select class="filter-select" id="fLevel">
        <option value="" ${state._memberLevel ? '' : 'selected'}>${t('members.allLevels')}</option>
        <option value="silver" ${state._memberLevel === 'silver' ? 'selected' : ''}>Silver</option>
        <option value="gold" ${state._memberLevel === 'gold' ? 'selected' : ''}>Gold</option>
        <option value="platinum" ${state._memberLevel === 'platinum' ? 'selected' : ''}>Platinum</option>
        <option value="partner" ${state._memberLevel === 'partner' ? 'selected' : ''}>${t('level.partner')}</option>
        <option value="bronze" ${state._memberLevel === 'bronze' ? 'selected' : ''}>Bronze</option>
      </select>
      <div class="page-spacer"></div>
      <button class="btn" id="btnReset">${t('common.reset')}</button>
      <button class="btn btn-primary" id="btnQuery">${t('common.query')}</button>
    </div>
    <div class="tbl-wrap" id="membersTableWrap"></div>
  `;
  renderMembersTable();
  // 事件（入口没渲染出来就不绑，避免 null 报错）
  if (canCreateMember) $('#btnAddMember').addEventListener('click', () => openMemberForm(null));
  $('#btnQuery').addEventListener('click', () => { state._memberQ = $('#fQ').value; state._memberType = $('#fType').value; state._memberStore = $('#fStore')?.value || ''; state._memberLevel = $('#fLevel').value; loadMembers(1).then(renderMembersTable); });
  $('#btnReset').addEventListener('click', () => { state._memberQ = ''; state._memberType = ''; state._memberStore = ''; state._memberLevel = ''; renderMembers(root); });
  if (canCreateMember) $('#btnImport').addEventListener('click', () => openImportMembers());
  $('#fQ').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnQuery').click(); });
}

async function loadMembers(page) {
  const params = new URLSearchParams({ page, pageSize: state.members.pageSize });
  if (state._memberQ) params.set('q', state._memberQ);
  if (state._memberType) params.set('type', state._memberType);
  if (state._memberStore) params.set('storeId', state._memberStore);
  if (state._memberLevel) params.set('level', state._memberLevel);
  state.members = await GET('/api/members?' + params);
  state.members.page = page;
}

/** 会员列表是否带着筛选条件 */
function memberFilterActive() {
  return !!(state._memberQ || state._memberType || state._memberStore || state._memberLevel);
}

function renderMembersTable() {
  const wrap = $('#membersTableWrap');
  if (!wrap) return;
  const { items, total, page, pageSize } = state.members;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const mobile = isMobile();
  // 前端门禁：行上的「录入消费」「编辑」各自需要 points.grant / member.edit，
  //   与 member.view 是不同能力。缺少时不要渲染 —— 否则点了必然 403。
  //   「详情」只需要 member.view，本页已要求，故无需再判。
  const canPurchaseRow = can('points.grant');
  const canEditRow = can('member.edit');

  // 手机走卡片列表，桌面走数据表格（同一份数据、同一套事件）
  wrap.className = mobile ? 'mcard-wrap' : 'tbl-wrap';

  if (mobile) {
    wrap.innerHTML = items.length === 0
      ? `<div class="mcard-empty">${t(memberFilterActive() ? 'members.emptyFiltered' : 'members.empty')}</div>`
      : `<div class="mcard-list">${items.map(memberCardHtml).join('')}</div>${pagerHtml(total, page, pageSize, totalPages)}`;
  } else {
    // 列宽合计 1030。styles.css 里 .tbl-head/.tbl-row 的 min-width 是
    // 「内边距 40 + 列间距 84 + 本值」，三处必须一起改，否则最后一列会被裁掉。
    // 操作列从 198 加宽到 268，用来放新增的「登记消费」主按钮。
    const COLS = 'grid-template-columns:176px 58px 134px 82px 104px 140px 72px 264px;';
    wrap.innerHTML = `
      <div class="tbl-head" style="${COLS}">
        <div>${t('members.colMember')}</div>
        <div>${t('members.colType')}</div>
        <div>${t('members.colLevel')}</div>
        <div>${t('members.colPoints')}</div>
        <div>${t('members.colSpend')}</div>
        <div>${t('members.colStore')}</div>
        <div>${t('members.colStatus')}</div>
        <div>${t('members.colActions')}</div>
      </div>
      ${items.length === 0 ? `<div class="card-empty card-empty-lg">${t(memberFilterActive() ? 'members.emptyFiltered' : 'members.empty')}</div>` : items.map(m => {
        const tm = typeMeta(m.type); const lm = levelMeta(m.level); const sm = statusMeta(m.status);
        return `
          <div class="tbl-row" style="${COLS}">
            <div class="tbl-cell member" title="${escapeHtml(m.name)}">
              <div class="avatar">${initials(m.name)}</div>
              <div class="stack">
                <div class="name">${escapeHtml(m.name)}</div>
                <div class="sub mono">${escapeHtml(m.phone)}</div>
              </div>
            </div>
            <div class="tbl-cell"><span class="pill ${tm.cls}">${tm.label}</span></div>
            <div class="tbl-cell"><span class="pill-level ${lm.cls}">${lm.label}</span></div>
            <div class="tbl-cell mono">${fmt(m.points)}</div>
            <div class="tbl-cell mono">${peso(m.spend)}</div>
            <div class="tbl-cell" title="${escapeHtml(memberStoreName(m) || '')}">${escapeHtml(memberStoreName(m) || '\u2014')}</div>
            <div class="tbl-cell"><span class="pill ${sm.cls}">${sm.dot ? '<span class="d"></span>' : ''}${sm.label}</span></div>
            <div class="tbl-cell tbl-actions">
              ${canPurchaseRow ? `<button class="btn btn-sm btn-primary" data-action="purchase" data-id="${m.id}" ${m.status === 'frozen' ? 'disabled' : ''} title="${escapeHtml(t('memberDetail.recordPurchase'))}">${t('members.recordShort')}</button>` : ''}
              <button class="btn btn-sm" data-action="detail" data-id="${m.id}">${t('common.detail')}</button>
              ${canEditRow ? `<button class="btn btn-sm" data-action="edit" data-id="${m.id}">${t('common.edit')}</button>` : ''}
              ${can('member.delete') ? `<button class="btn btn-sm btn-danger" data-action="del" data-id="${m.id}">${t('common.delete')}</button>` : ''}
            </div>
          </div>
        `;
      }).join('')}
      ${items.length === 0 ? '' : pagerHtml(total, page, pageSize, totalPages)}
    `;
  }

  // 事件（两种布局共用）
  $$('[data-action]', wrap).forEach(b => {
    b.addEventListener('click', () => {
      const id = b.dataset.id;
      const m = items.find(x => x.id === id);
      if (!m) return;
      if (b.dataset.action === 'detail') openMemberDetail(m);
      if (b.dataset.action === 'edit') openMemberForm(m);
      if (b.dataset.action === 'del') confirmDeleteMember(m);
      if (b.dataset.action === 'purchase') openPurchaseForm(m);
    });
  });
  $$('.pager-btn', wrap).forEach(b => b.addEventListener('click', () => { loadMembers(parseInt(b.dataset.page)).then(renderMembersTable); }));
}

/** 移动端会员卡片：把店员最常用的「登记消费」提到第一层，拇指区可点 */
function memberCardHtml(m) {
  const tm = typeMeta(m.type); const lm = levelMeta(m.level); const sm = statusMeta(m.status);
  const frozen = m.status === 'frozen';
  // 与桌面表格同一套门禁（双布局必须同步，否则手机端仍会出现必 403 的按钮）
  const canPurchaseRow = can('points.grant');
  const canEditRow = can('member.edit');
  return `
    <div class="mcard">
      <div class="mcard-top">
        <div class="avatar">${initials(m.name)}</div>
        <div class="stack">
          <div class="name">${escapeHtml(m.name)}</div>
          <div class="sub mono">${escapeHtml(m.phone)}</div>
        </div>
        <div class="mcard-pts">
          <div class="pts mono">${fmt(m.points)}</div>
          <div class="lbl">${t('common.points')}</div>
        </div>
      </div>
      <div class="mcard-meta">
        <span class="pill ${tm.cls}">${tm.label}</span>
        <span class="pill-level ${lm.cls}">${lm.label}</span>
        <span class="pill ${sm.cls}">${sm.dot ? '<span class="d"></span>' : ''}${sm.label}</span>
        <span class="mcard-store">${escapeHtml(memberStoreName(m) || '\u2014')}</span>
      </div>
      <div class="mcard-actions">
        ${canPurchaseRow ? `<button class="btn btn-primary" data-action="purchase" data-id="${m.id}" ${frozen ? 'disabled' : ''}>${t('memberDetail.recordPurchase')}</button>` : ''}
        <button class="btn" data-action="detail" data-id="${m.id}">${t('common.detail')}</button>
        ${canEditRow ? `<button class="btn" data-action="edit" data-id="${m.id}">${t('common.edit')}</button>` : ''}
        ${can('member.delete') ? `<button class="btn btn-danger" data-action="del" data-id="${m.id}">${t('common.delete')}</button>` : ''}
      </div>
    </div>
  `;
}

function pagerHtml(total, page, pageSize, totalPages) {
  return `
    <div class="pager">
      <span>${t('members.pager', { total: fmt(total), size: pageSize, page, pages: totalPages })}</span>
      <div class="spacer"></div>
      <button class="pager-btn" data-page="${Math.max(1, page - 1)}" ${page === 1 ? 'disabled' : ''}>${t('members.prev')}</button>
      ${renderPagerPages(page, totalPages)}
      <button class="pager-btn" data-page="${Math.min(totalPages, page + 1)}" ${page === totalPages ? 'disabled' : ''}>${t('members.next')}</button>
    </div>
  `;
}

function renderPagerPages(p, total) {
  // 显示首页、末页以及当前页附近，避免页数一多就只能一页页点过去
  const wanted = new Set([1, total, p - 1, p, p + 1]);
  const marks = [];
  let prev = 0;
  for (let i = 1; i <= total; i++) {
    if (!wanted.has(i)) continue;
    if (prev && i - prev > 1) marks.push('…');
    marks.push(i);
    prev = i;
  }
  return marks.map(x => x === '…'
    ? `<span class="pager-btn" style="border:none;background:transparent;">…</span>`
    : `<button class="pager-btn ${x === p ? 'active' : ''}" data-page="${x}">${x}</button>`
  ).join('');
}

function openMemberForm(m) {
  const isEdit = !!m;
  // 字段级权限与后端保持一致（后端 PUT /api/members/:id 的字段白名单）：
  //   type / storeId / spend / status → member.manage
  //   points                          → points.adjust
  // 无权限的字段在界面上禁用，避免「改了但被静默忽略」的误导。
  const canManage = can('member.manage');
  const canAdjust = can('points.adjust');
  openModal({
    title: isEdit ? t('memberForm.edit') : t('memberForm.new'),
    wide: true,
    body: `
      <form data-form>
        <div class="modal-form-row col2">
          <label><span>${t('memberForm.name')}</span><input name="name" required value="${escapeHtml(m?.name || '')}" placeholder="Maria Santos"/></label>
          <label><span>${t('memberForm.phone')}</span><input name="phone" required value="${escapeHtml(m?.phone || '')}" placeholder="0917 000 0000"/></label>
        </div>
        <div class="modal-form-row col2">
          <label><span>${t('memberForm.type')}</span>
            <select name="type" required ${canManage ? '' : 'disabled'}>
              <option value="retail" ${m?.type !== 'b2b' ? 'selected' : ''}>${t('type.retailCustomer')}</option>
              <option value="b2b" ${m?.type === 'b2b' ? 'selected' : ''}>${t('type.b2bCustomer')}</option>
            </select>
          </label>
          <label><span>${t('memberForm.store')}</span>
            <select name="storeId" required ${canManage ? '' : 'disabled'}>
              ${state.stores.map(s => `<option value="${s.id}" ${(m?.storeId || (!canManage ? state.me.storeId : '')) === s.id ? 'selected' : ''}>${escapeHtml(tStore(s.name))}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="modal-form-row col2">
          <label><span>${t('memberForm.spend')}</span><input name="spend" type="number" min="0" step="0.01" value="${m?.spend || 0}" ${canManage ? '' : 'disabled'}/></label>
          <label>
            <span>${t('memberForm.points')}${canAdjust ? '' : ' ' + t('memberForm.pointsHint')}</span>
            <input name="points" type="number" min="0" value="${m?.points || 0}" ${canAdjust ? '' : 'disabled'}/>
          </label>
        </div>
        ${canAdjust ? `<div class="inset inset-tight">
          ${isEdit ? t('memberForm.adjustNoteEdit') : t('memberForm.adjustNoteNew')}
        </div>` : ''}
        <div class="modal-form-row col2">
          <label><span>${t('memberDetail.status')}</span>
            <select name="status" ${canManage ? '' : 'disabled'}>
              <option value="active" ${m?.status !== 'frozen' ? 'selected' : ''}>${t('status.active')}</option>
              <option value="frozen" ${m?.status === 'frozen' ? 'selected' : ''}>${t('status.frozen')}</option>
            </select>
          </label>
          <label><span>${t('memberDetail.notes')}</span><input name="notes" value="${escapeHtml(m?.notes || '')}" placeholder="${escapeHtml(t('common.optional'))}"/></label>
        </div>
        <div class="modal-form-error"></div>
      </form>
    `,
    footer: `
      <button class="btn" data-close>${t('common.cancel')}</button>
      <button class="btn btn-primary" form="modalFormSubmit">${isEdit ? t('common.save') : t('common.create')}</button>
    `,
  });
  // 由于 form 不在 modal-footer，需要让 footer 的按钮触发 form submit
  $$('.modal-footer button.btn-primary', activeModal).forEach(btn => {
    btn.addEventListener('click', e => { e.preventDefault(); activeModal.querySelector('form[data-form]').requestSubmit(); });
  });
  formFromTemplate(null, async (data) => {
    if (data.spend !== undefined) data.spend = Number(data.spend);
    // 只有能调整积分的人才提交 points 字段；否则删掉，避免后端按「无权限字段」忽略造成误解
    if (canAdjust && data.points !== undefined && data.points !== '') data.points = Number(data.points);
    else delete data.points;
    if (isEdit) await PUT(`/api/members/${m.id}`, data);
    else await POST('/api/members', data);
    closeModal();
    toast(isEdit ? t('memberForm.saved') : t('memberForm.createdMsg'), 'success');
    await loadMembers(state.members.page);
    renderMembersTable();
  });
}

const TX_META = {
  earn:    { key: 'tx.earn',    cls: 'pill-active' },
  welcome: { key: 'tx.welcome', cls: 'pill-b2b' },
  redeem:  { key: 'tx.redeem',  cls: 'pill-b2b' },
  expire:  { key: 'tx.expire',  cls: 'pill-frozen' },
  adjust:  { key: 'tx.adjust',  cls: '' },
};
function txMeta(type) {
  const m = TX_META[type];
  return m ? { label: t(m.key), cls: m.cls } : { label: type, cls: '' };
}

async function openMemberDetail(m) {
  const txs = await GET(`/api/members/${m.id}/transactions`);
  const tm = typeMeta(m.type); const lm = levelMeta(m.level); const sm = statusMeta(m.status);
  const expDays = m.pointsExpireAt ? Math.ceil((new Date(m.pointsExpireAt).getTime() - Date.now()) / 86400000) : null;
  const expTxt = !m.pointsExpireAt ? '—'
    : expDays <= 0 ? t('memberDetail.expired')
    : t('memberDetail.expiryIn', { date: new Date(m.pointsExpireAt).toLocaleDateString(locale()), days: expDays });
  const frozen = m.status === 'frozen';
  // 4 个操作入口分别对应 4 个独立权限，与后端路由的权限门一一对应：
  //   登记消费 → POST /api/members/:id/purchase   → points.grant
  //   兑换     → POST /api/redemptions            → mall.redeem
  //   调整积分 → POST /api/members/:id/transactions(adjust) → points.adjust
  //   编辑资料 → PUT  /api/members/:id            → member.edit
  // 无权限的角色（如老板、总部运营、销售、仓库、售后都只有查看权）不应看到这些入口，
  // 否则点进去填完表单，后端仍会按权限返回 403。
  const canPurchase = can('points.grant');
  const canRedeem = can('mall.redeem');
  const canAdjust = can('points.adjust');
  const canEditMember = can('member.edit');
  openModal({
    title: m.name,
    wide: true,
    body: `
      <div class="detail-grid">
        <div class="detail-row"><span class="k">${t('memberDetail.phone')}</span><span class="v mono">${escapeHtml(m.phone)}</span></div>
        <div class="detail-row"><span class="k">${t('memberDetail.type')}</span><span class="v"><span class="pill ${tm.cls}">${tm.label}</span></span></div>
        <div class="detail-row"><span class="k">${t('memberDetail.level')}</span><span class="v"><span class="pill-level ${lm.cls}">${lm.label}</span></span></div>
        <div class="detail-row"><span class="k">${t('memberDetail.status')}</span><span class="v"><span class="pill ${sm.cls}">${sm.label}</span></span></div>
        <div class="detail-row"><span class="k">${t('memberDetail.balance')}</span><span class="v mono" style="font-size:16px;color:#17201B;font-weight:600;">${fmt(m.points)}</span></div>
        <div class="detail-row"><span class="k">${t('memberDetail.earned')}</span><span class="v mono">${fmt(m.earnedTotal || 0)}</span></div>
        <div class="detail-row"><span class="k">${t('memberDetail.redeemed')}</span><span class="v mono">${fmt(m.redeemedTotal || 0)}</span></div>
        <div class="detail-row"><span class="k">${t('memberDetail.expiry')}</span><span class="v" style="${expDays !== null && expDays <= 30 ? 'color:var(--warn-ink);font-weight:500;' : ''}">${expTxt}</span></div>
        <div class="detail-row"><span class="k">${t('memberDetail.spend')}</span><span class="v mono">${peso(m.spend)}</span></div>
        <div class="detail-row"><span class="k">${t('memberDetail.lastPurchase')}</span><span class="v mono">${m.lastPurchaseAt ? new Date(m.lastPurchaseAt).toLocaleDateString(locale()) : '—'}</span></div>
        <div class="detail-row"><span class="k">${t('memberDetail.store')}</span><span class="v">${escapeHtml(memberStoreName(m) || '—')}</span></div>
        <div class="detail-row"><span class="k">${t('memberDetail.createdAt')}</span><span class="v mono">${new Date(m.createdAt).toLocaleString(locale())}</span></div>
      </div>
      ${m.notes ? `<div class="inset inset-tight">${escapeHtml(m.notes)}</div>` : ''}
      ${(canPurchase || canRedeem || canAdjust || canEditMember) ? `
      <div class="detail-actions">
        ${canPurchase ? `<button class="btn btn-primary" id="btnPurchase" ${frozen ? 'disabled' : ''}>${t('memberDetail.recordPurchase')}</button>` : ''}
        ${canRedeem ? `<button class="btn" id="btnRedeem" ${frozen ? 'disabled' : ''}>${t('memberDetail.redeem')}</button>` : ''}
        ${canAdjust ? `<button class="btn" id="btnAdjust">${t('memberDetail.adjust')}</button>` : ''}
        <div class="page-spacer"></div>
        ${canEditMember ? `<button class="btn" id="btnEdit">${t('common.edit')}</button>` : ''}
      </div>` : ''}
      <div>
        <div style="font-size:13px;font-weight:600;color:#17201B;margin:8px 0;">${t('memberDetail.ledger')}</div>
        ${txs.items.length === 0 ? `<div class="card-empty">${t('memberDetail.noTx')}</div>` : `
        <div class="tx-list">
          ${txs.items.map(tx => {
            const meta = txMeta(tx.type);
            const sign = tx.amount >= 0 ? '+' : '-';
            const color = tx.amount >= 0 ? 'var(--brand)' : 'var(--danger-ink)';
            return `
            <div class="tx-row">
              <span class="mono tx-amt" style="color:${color};">${sign}${fmt(Math.abs(tx.amount))}</span>
              <span><span class="pill ${meta.cls}">${meta.label}</span></span>
              <span class="tx-reason">${escapeHtml(tx.reason || '')}</span>
              <span class="mono tx-time">${new Date(tx.createdAt).toLocaleString(locale())}</span>
            </div>`;
          }).join('')}
        </div>`}
      </div>
    `,
    footer: `<button class="btn" data-close>${t('common.close')}</button>`,
  });
  if (canPurchase) $('#btnPurchase').addEventListener('click', () => { closeModal(); openPurchaseForm(m); });
  if (canRedeem) $('#btnRedeem').addEventListener('click', () => { closeModal(); openRedeemForm(m); });
  if (canAdjust) $('#btnAdjust').addEventListener('click', () => { closeModal(); openAdjustForm(m); });
  if (canEditMember) $('#btnEdit').addEventListener('click', () => { closeModal(); openMemberForm(m); });
}

/** 登记消费：输入订单金额，系统按规则自动算分发放 */
function openPurchaseForm(m) {
  openModal({
    title: t('purchase.title', { name: m.name }),
    body: `
      <form data-form>
        <div class="inset inset-tight" style="margin-bottom:8px;">
          ${t('purchase.balanceLine', { points: fmt(m.points), spend: peso(m.spend) })}
        </div>
        <div class="modal-form-row">
          <label><span>${t('purchase.amount')}</span><input name="amount" type="number" min="1" step="0.01" required placeholder="${escapeHtml(t('purchase.amountPh'))}" autofocus/></label>
        </div>
        <div id="purchasePreview" class="note note-ok" style="margin-bottom:4px;">
          ${t('purchase.previewEmpty')}
        </div>
        <div class="modal-form-row">
          <label><span>${t('purchase.note')}</span><input name="note" placeholder="${escapeHtml(t('purchase.notePh'))}"/></label>
        </div>
        <div class="modal-form-error"></div>
      </form>
    `,
    footer: `
      <button class="btn" data-close>${t('common.cancel')}</button>
      <button class="btn btn-primary" id="confirmPurchase">${t('purchase.confirm')}</button>
    `,
  });
  const input = activeModal.querySelector('input[name=amount]');
  const box = activeModal.querySelector('#purchasePreview');
  let quoteTimer = null;
  const refreshQuote = async () => {
    const amt = Number(input.value);
    if (!(amt > 0)) {
      box.innerHTML = t('purchase.previewEmpty');
      return;
    }
    try {
      const q = await GET(`/api/members/${m.id}/quote?purchaseAmount=${amt}`);
      const e = q.earn;
      const perPeso = t('purchase.perPeso', { rate: fmt(q.rules.spendPerPoint) });
      box.innerHTML = `
        ${t('purchase.orderAmountLine', { amount: peso(amt) })}<br/>
        ${t('purchase.baseLine', { base: fmt(e.basePoints), perPeso })}
        <div style="margin-top:6px;font-size:15px;font-weight:600;">${t('purchase.resultLine', { points: fmt(e.points) })}</div>
      `;
    } catch (err) { box.textContent = t('purchase.calcFailed', { msg: tMsg(err.message || err) }); }
  };
  input.addEventListener('input', () => { clearTimeout(quoteTimer); quoteTimer = setTimeout(refreshQuote, 250); });
  input.focus();
  $('#confirmPurchase').addEventListener('click', e => { e.preventDefault(); activeModal.querySelector('form[data-form]').requestSubmit(); });
  formFromTemplate(null, async (data) => {
    const amt = Number(data.amount);
    if (!(amt > 0)) throw new Error(t('purchase.invalidAmount'));
    const r = await POST(`/api/members/${m.id}/purchase`, { amount: amt, note: data.note });
    closeModal();
    if (r.pending) {
      // 2026-09-19 起：店长登记消费需管理员审核，这里必须说清楚「不是没成功，是在等审核」，
      // 否则店长会以为系统坏了而反复提交。
      toast(t('approval.submittedToast', { amount: peso(amt) }), 'info');
    } else {
      toast(t('purchase.done', { amount: peso(amt), points: fmt(r.earn.points) }), 'success');
      if (r.levelUp) toast(t('purchase.levelUp', { from: levelMeta(r.levelUp.from).label, to: levelMeta(r.levelUp.to).label }), 'success');
    }
    await loadMembers(state.members.page);
    renderMembersTable();
    openMemberDetail(r.member);
  });
}

/** 核销积分：先填本次订单金额，再按规则校验起兑门槛与抵扣上限 */
function openRedeemForm(m) {
  openModal({
    title: t('redeem.title', { name: m.name }),
    body: `
      <form data-form>
        <div class="inset inset-tight" style="margin-bottom:8px;">
          ${t('redeem.balanceLine', { points: fmt(m.points) })}
        </div>
        <div class="modal-form-row">
          <label><span>${t('redeem.orderAmount')}</span><input name="purchaseAmount" type="number" min="0" step="0.01" required placeholder="${escapeHtml(t('redeem.orderAmountPh'))}" autofocus/></label>
        </div>
        <div class="modal-form-row">
          <label><span>${t('redeem.usePoints')}</span><input name="amount" type="number" min="1" step="1" required placeholder="0"/></label>
        </div>
        <div id="redeemPreview" class="inset inset-tight" style="margin-bottom:4px;">
          ${t('redeem.previewEmpty')}
        </div>
        <div class="modal-form-row">
          <label><span>${t('redeem.note')}</span><input name="reason" placeholder="${escapeHtml(t('common.optional'))}"/></label>
        </div>
        <div class="modal-form-error"></div>
      </form>
    `,
    footer: `
      <button class="btn" data-close>${t('common.cancel')}</button>
      <button class="btn btn-primary" id="confirmRedeem">${t('redeem.confirm')}</button>
    `,
  });
  const pInput = activeModal.querySelector('input[name=purchaseAmount]');
  const aInput = activeModal.querySelector('input[name=amount]');
  const box = activeModal.querySelector('#redeemPreview');
  let q = null, timer = null;
  const refresh = async () => {
    const amt = Number(pInput.value);
    if (!(amt > 0)) { box.innerHTML = t('redeem.previewEmpty'); return; }
    try {
      q = (await GET(`/api/members/${m.id}/quote?purchaseAmount=${amt}`)).redeem;
      if (!q.eligible) {
        box.innerHTML = `<span style="color:var(--warn-ink);">${t('redeem.belowMin', { min: fmt(q.minPoints), balance: fmt(q.balance) })}</span>`;
        return;
      }
      const used = Number(aInput.value) || 0;
      const value = used * q.unitValue;
      const cap = q.noCap ? t('redeem.capNone') : t('redeem.capPercent', { pct: q.maxPercent });
      const limitNote = q.limitedBy === 'percent' ? `<span style="color:var(--warn-ink);">${t('redeem.percentApplied')}</span>`
        : q.limitedBy === 'order' ? `<span style="color:var(--warn-ink);">${t('redeem.orderApplied')}</span>` : '';
      box.innerHTML = `
        ${t('redeem.rateLine', { p: q.ratioPoints, v: q.ratioValue, cap })}<br/>
        ${t('redeem.maxLine', { points: fmt(q.maxPoints), value: peso(q.maxValue) })}${limitNote}
        <div style="margin-top:8px;">
          <button type="button" class="btn" id="useMax" style="padding:4px 10px;font-size:12px;">${t('redeem.useMax', { points: fmt(q.maxPoints) })}</button>
        </div>
        <div style="margin-top:8px;font-size:13px;">${t('redeem.usedLine', { used: fmt(used), value: peso(value) })}</div>
      `;
      const b = activeModal.querySelector('#useMax');
      if (b) b.addEventListener('click', () => { aInput.value = q.maxPoints; refresh(); });
    } catch (err) { box.textContent = t('purchase.calcFailed', { msg: tMsg(err.message || err) }); }
  };
  const debounce = () => { clearTimeout(timer); timer = setTimeout(refresh, 250); };
  pInput.addEventListener('input', debounce);
  aInput.addEventListener('input', debounce);
  pInput.focus();
  $('#confirmRedeem').addEventListener('click', e => { e.preventDefault(); activeModal.querySelector('form[data-form]').requestSubmit(); });
  formFromTemplate(null, async (data) => {
    const r = await POST(`/api/members/${m.id}/transactions`, {
      type: 'redeem',
      amount: Number(data.amount),
      purchaseAmount: Number(data.purchaseAmount),
      reason: data.reason,
    });
    closeModal();
    toast(t('redeem.done', { points: fmt(Math.abs(r.transaction.amount)) }), 'success');
    await loadMembers(state.members.page);
    renderMembersTable();
    openMemberDetail(r.member);
  });
}

/** 人工调整：可正可负，留痕但不走消费规则（仅管理员） */
function openAdjustForm(m) {
  openModal({
    title: t('adjust.title', { name: m.name }),
    body: `
      <form data-form>
        <div class="note note-warn" style="margin-bottom:8px;">
          ${t('adjust.warning')}
        </div>
        <div class="inset inset-tight" style="margin-bottom:8px;">
          ${t('adjust.balanceLine', { points: fmt(m.points) })}
        </div>
        <div class="modal-form-row">
          <label><span>${t('adjust.amount')}</span><input name="amount" type="number" step="1" required placeholder="${escapeHtml(t('adjust.amountPh'))}" autofocus/></label>
        </div>
        <div class="modal-form-row">
          <label><span>${t('adjust.reason')}</span><input name="reason" required placeholder="${escapeHtml(t('adjust.reasonPh'))}"/></label>
        </div>
        <div class="modal-form-error"></div>
      </form>
    `,
    footer: `
      <button class="btn" data-close>${t('common.cancel')}</button>
      <button class="btn btn-primary" id="confirmAdjust">${t('adjust.confirm')}</button>
    `,
  });
  $('#confirmAdjust').addEventListener('click', e => { e.preventDefault(); activeModal.querySelector('form[data-form]').requestSubmit(); });
  formFromTemplate(null, async (data) => {
    const amt = Number(data.amount);
    if (!amt) throw new Error(t('adjust.invalid'));
    if (await rulesRequireConfirm()) {
      const ok = await confirmDialog({
        title: t('adjust.confirmTitle'),
        body: t('adjust.confirmBody', { amount: (amt > 0 ? '+' : '') + fmt(amt) }),
        confirmLabel: t('adjust.confirm'),
        danger: true,
      });
      if (!ok) return;
    }
    const r = await POST(`/api/members/${m.id}/transactions`, { type: 'adjust', amount: amt, reason: data.reason });
    closeModal();
    toast(t('adjust.done', { sign: amt > 0 ? '+' : '', amount: amt }), 'success');
    await loadMembers(state.members.page);
    renderMembersTable();
    openMemberDetail(r.member);
  });
}

async function confirmDeleteMember(m) {
  const ok = await confirmDialog({
    title: t('deleteMember.title'),
    body: t('deleteMember.body', { name: escapeHtml(m.name) }),
    confirmLabel: t('deleteMember.confirm'),
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await DELETE(`/api/members/${m.id}`);
    const removedTx = (r && r.removedTransactions) || 0;
    toast(removedTx ? t('deleteMember.doneWithTx', { n: removedTx }) : t('common.deleted'), 'success');
    await loadMembers(state.members.page);
    renderMembersTable();
  } catch (e) {
    toast(tMsg(e.message || e), 'error');
  }
}

function openImportMembers() {
  const sample = `name,phone,type,storeName,spend,points,notes
Maria Santos,0917 482 1129,retail,${state.stores[0]?.name || 'Manila Flagship Store'},486200,58240,
Juan Dela Cruz,0918 235 7682,retail,${state.stores[1]?.name || 'Quezon City Branch'},152800,21306,`;
  openModal({
    title: t('import.title'),
    wide: true,
    body: `
      <div class="inset inset-tight">
        ${t('import.hint')}
      </div>
      <div class="modal-form-row">
        <label><span>${t('import.csvContent')}</span><textarea data-csv rows="10" placeholder="${escapeHtml(sample)}"></textarea></label>
      </div>
      <div class="modal-form-error"></div>
    `,
    footer: `<button class="btn" data-close>${t('common.cancel')}</button><button class="btn btn-primary" id="btnDoImport">${t('common.import')}</button>`,
  });
  $('#btnDoImport').addEventListener('click', async () => {
    const text = activeModal.querySelector('[data-csv]').value.trim();
    if (!text) return toast(t('import.paste'), 'error');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const header = lines[0].split(',').map(s => s.trim());
    const idx = name => header.indexOf(name);
    const req = ['name', 'phone', 'type'];
    for (const r of req) if (idx(r) < 0) return toast(t('import.missingCol', { col: r }), 'error');
    let ok = 0, fail = 0;
    const reasons = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(s => s.trim());
      const name = cols[idx('name')]; const phone = cols[idx('phone')];
      const type = cols[idx('type')] || 'retail';
      const storeName = cols[idx('storeName')];
      const store = state.stores.find(s => s.name === storeName) || state.stores[0];
      const spend = Number(cols[idx('spend')] || 0);
      const points = Number(cols[idx('points')] || 0);
      const notes = cols[idx('notes')] || '';
      try { await POST('/api/members', { name, phone, type, storeId: store.id, spend, points, notes }); ok++; }
      catch (e) {
        fail++;
        // 只带前两条，否则 toast 会撑爆；最常见的原因是手机号重复
        if (reasons.length < 2) reasons.push(`#${i + 1} ${tMsg(e.message || e)}`);
      }
    }
    closeModal();
    if (fail > 0) toast(t('import.doneDetail', { ok, fail, detail: reasons.join(' · ') }), 'error');
    else toast(t('import.done', { ok, fail }), 'success');
    await loadMembers(1); renderMembersTable();
  });
}

// =================== 积分规则 ===================
async function renderRules(root) {
  state.rules = await GET('/api/rules');
  const r = state.rules.rules;
  // 规则页：保存/编辑字段需 points.rule.edit；到期试算需 points.expiry.scan（两个能力分开）
  const canEditRules = can('points.rule.edit');
  const canScanExpiry = can('points.expiry.scan');
  const noCap = Number(r.redeemMaxPercent) === 0;
  const noMin = Number(r.redeemMinPoints) === 0;
  root.innerHTML = `
    <div class="page-header">
      <div class="page-header-text">
        <div class="page-title">${t('rules.title')}</div>
        <div class="page-subtitle">${t('rules.subtitle')}</div>
      </div>
      <div class="page-spacer"></div>
      ${canEditRules ? `<button class="btn btn-primary" id="btnSaveRules">${t('rules.saveBtn')}</button>` : `<span class="pill pill-frozen">${t('rules.readOnly')}</span>`}
    </div>
    <div class="row-2-eq">
      <div class="card">
        <div class="card-title">${t('rules.earningCard')}</div>
        <div class="card-subtitle" style="margin-bottom:16px;">${t('rules.earningSub')}</div>
        <div class="section">
          <div class="kv-row"><span class="k">${t('rules.spendPerPoint')}</span><input class="filter-input" id="rSpend" type="number" min="1" value="${r.spendPerPoint}" style="width:120px;" ${!canEditRules ? 'disabled' : ''}/><span class="v">${t('rules.spendPerPointUnit')}</span></div>
          <div class="kv-row"><span class="k">${t('rules.expiryMonths')}</span><input class="filter-input" id="rExpiry" type="number" min="1" value="${r.expiryMonths}" style="width:120px;" ${!canEditRules ? 'disabled' : ''}/><span class="v">${t('rules.expiryMonthsUnit')}</span></div>
          <div class="kv-row"><span class="k">${t('rules.welcome')}</span><input class="filter-input" id="rWelcome" type="number" min="0" value="${r.welcomeBonus}" style="width:120px;" ${!canEditRules ? 'disabled' : ''}/><span class="v">${t('rules.welcomeUnit')}</span></div>
        </div>
        <div class="note note-ok" style="margin-top:12px;">
          <b>${t('rules.effect')}</b><br/>
          ${t('rules.effectWelcome', { n: fmt(r.welcomeBonus) })}
          ${t('rules.effectEarn', { rate: fmt(r.spendPerPoint) })}
          ${Number(r.expiryMonths) > 0 ? t('rules.effectExpiry', { months: r.expiryMonths }) : t('rules.effectExpiryNone')}
        </div>
      </div>
      <div class="card">
        <div class="card-title">${t('rules.redeemCard')}</div>
        <div class="card-subtitle" style="margin-bottom:16px;">${t('rules.redeemSub')}</div>
        <div class="section">
          <div class="kv-row"><span class="k">${t('rules.ratio')}</span><input class="filter-input" id="rRedeemRatio" value="${r.redeemRatio}" style="width:120px;" ${!canEditRules ? 'disabled' : ''}/><span class="v">${t('rules.ratioUnit')}</span></div>
          <div class="kv-row"><span class="k">${t('rules.maxPercent')}</span><input class="filter-input" id="rMaxPct" type="number" min="0" max="100" value="${r.redeemMaxPercent}" style="width:120px;" ${!canEditRules ? 'disabled' : ''}/><span class="v">${t('rules.maxPercentUnit')}</span></div>
          <div class="kv-row"><span class="k">${t('rules.minPoints')}</span><input class="filter-input" id="rMinPts" type="number" min="0" value="${r.redeemMinPoints}" style="width:120px;" ${!canEditRules ? 'disabled' : ''}/><span class="v">${t('rules.minPointsUnit')}</span></div>
          <div class="kv-row"><span class="k">${t('rules.requireConfirm')}</span><span class="spacer"></span><div class="switch ${r.requireConfirm ? 'on' : ''}" id="rConfirm" data-key="requireConfirm" ${!canEditRules ? 'style="pointer-events:none;opacity:0.6;"' : ''}><div class="switch-knob"></div></div></div>
        </div>
        <div class="note note-info" style="margin-top:12px;">
          <b>${t('rules.effect')}</b><br/>
          ${noMin ? t('rules.effectMinNone') : t('rules.effectMin', { n: fmt(r.redeemMinPoints) })}
          ${noCap ? t('rules.effectMaxNone') : t('rules.effectMax', { n: r.redeemMaxPercent })}
          ${t('rules.effectCounter')}
        </div>
        ${state.rules.engine?.expiry ? `
        <div class="kv-row" style="margin-top:12px;padding-top:12px;border-top:1px solid #EFF3F1;">
          <span class="k">${t('rules.expiryScan')}</span>
          <span class="v" style="font-size:12px;color:#718078;">
            ${state.rules.engine.expiry.lastRunAt ? t('rules.expiryLast', { time: new Date(state.rules.engine.expiry.lastRunAt).toLocaleString(locale()) }) : t('rules.expiryNever')}
            ${t('rules.expiryCycle')}${state.rules.engine.expiry.expiredMembers ? t('rules.expiryResult', { n: state.rules.engine.expiry.expiredMembers, points: fmt(state.rules.engine.expiry.expiredPoints) }) : ''}
          </span>
        </div>
        ${canScanExpiry ? `<button class="btn" id="btnExpiryPreview" style="margin-top:8px;">${t('rules.expiryDryRun')}</button>` : ''}` : ''}
      </div>
    </div>
    <div class="row-2-eq" style="margin-top:16px;">
      <div class="card">
        <div class="card-title">${t('rules.levelsCard')}</div>
        <div class="card-subtitle" style="margin-bottom:16px;">${t('rules.levelsSub')}</div>
        <div class="section">${r.levels.map((lv, i) => `
          <div class="tier-row">
            <span class="pill" style="background:${lv.color}1A;color:${lv.color};">${escapeHtml(lv.key)}</span>
            <input class="filter-input tier-name" data-level-name="${i}" value="${escapeHtml(lv.name)}" ${!canEditRules ? 'disabled' : ''}/>
            <input class="filter-input tier-thr" data-level-thr="${i}" type="number" min="0" value="${lv.threshold}" ${!canEditRules ? 'disabled' : ''}/>
            <span class="tier-unit">${t('rules.thresholdUnit')}</span>
          </div>
        `).join('')}</div>
      </div>
      <div class="card">
        <div class="card-title">${t('rules.b2bCard')}</div>
        <div class="card-subtitle">${t('rules.b2bSub')}</div>
        <div class="inset inset-tight" style="border-radius:6px;margin-top:6px;margin-bottom:16px;">${t('rules.b2bNotWired')}</div>
        <div class="section">${r.b2bTiers.map((lv, i) => `
          <div class="tier-row">
            <span class="pill" style="background:${lv.color}1A;color:${lv.color};">${escapeHtml(lv.key)}</span>
            <input class="filter-input tier-name" data-b2b-name="${i}" value="${escapeHtml(lv.name)}" ${!canEditRules ? 'disabled' : ''}/>
            <input class="filter-input tier-thr" data-b2b-thr="${i}" type="number" min="0" value="${lv.threshold}" ${!canEditRules ? 'disabled' : ''}/>
            <span class="tier-unit">${t('rules.b2bThresholdUnit')}</span>
            <input class="filter-input tier-rate" data-b2b-rate="${i}" type="number" step="0.005" min="0" value="${lv.rate}" ${!canEditRules ? 'disabled' : ''}/>
            <span class="tier-unit">${t('rules.rateUnit')}</span>
          </div>
        `).join('')}</div>
      </div>
    </div>
  `;
  // 保存规则（points.rule.edit）与到期试算（points.expiry.scan）是两个独立能力，
  // 无论哪个按钮不存在，事件绑定都必须判空，否则会抛错打断整个渲染。
  if (canEditRules) {
    $('#btnSaveRules')?.addEventListener('click', saveRules);
    $$('.switch').forEach(sw => sw.addEventListener('click', () => sw.classList.toggle('on')));
  }
  if (canScanExpiry) {
    $('#btnExpiryPreview')?.addEventListener('click', async () => {
      const res = await POST('/api/rules/expiry-scan', {});
      const p = res.preview || {};
      toast(p.expiredMembers > 0
        ? t('rules.expiryFound', { n: p.expiredMembers, points: fmt(p.expiredPoints) })
        : t('rules.expiryNone'), 'success');
      await renderRules($('#content'));
    });
  }
}

async function saveRules() {
  const r = state.rules.rules;
  const data = {
    spendPerPoint: Number($('#rSpend').value),
    expiryMonths: Number($('#rExpiry').value),
    welcomeBonus: Number($('#rWelcome').value),
    redeemRatio: $('#rRedeemRatio').value,
    redeemMaxPercent: Number($('#rMaxPct').value),
    redeemMinPoints: Number($('#rMinPts').value),
    requireConfirm: $('#rConfirm').classList.contains('on'),
    realtimePush: r.realtimePush,
    levels: r.levels.map((_, i) => ({
      key: r.levels[i].key,
      name: $(`[data-level-name="${i}"]`).value,
      threshold: Number($(`[data-level-thr="${i}"]`).value),
      color: r.levels[i].color,
    })),
    b2bTiers: r.b2bTiers.map((_, i) => ({
      key: r.b2bTiers[i].key,
      name: $(`[data-b2b-name="${i}"]`).value,
      threshold: Number($(`[data-b2b-thr="${i}"]`).value),
      rate: Number($(`[data-b2b-rate="${i}"]`).value),
      color: r.b2bTiers[i].color,
    })),
  };
  // 「变更需二次确认」开关在这里真正生效：规则一改，全员立即受影响
  if (r.requireConfirm) {
    const ok = await confirmDialog({
      title: t('rules.confirmTitle'),
      body: t('rules.confirmBody'),
      confirmLabel: t('rules.saveBtn'),
    });
    if (!ok) return;
  }
  await PUT('/api/rules', data);
  toast(t('rules.savedMsg'), 'success');
  await renderRules($('#content'));
}

// =================== 门店管理 ===================
/**
 * 本店的「现任店长」是否就是当前登录用户自己。
 *
 * 为什么需要判断：后端有一条 self-target 护栏（2026-09-22 部署）——
 * 若调用者正是该门店 managerId 指向的账号，则「分配店长」与「解绑店长」都会被
 * 返回 400「你不能通过本流程替换或停用自己」。所以店长在自己门店上看到这两个
 * 按钮是永远点不动的死按钮，应当在渲染阶段就不要给出来。
 * （护栏本身不变，这里只做「不显示用不了的按钮」。）
 *
 * 注：门店卡「未分配店长」那一支（managerId 为空）不需要再判 ——
 * isSelfManager 恒为 false，而且此时分配店长不会停用任何人，属于合法操作。
 */
function isSelfManager(store) {
  return !!(state.me && store && store.managerId && store.managerId === state.me.id);
}

async function renderStores(root) {
  // 防御：没有 store.view 时不要请求接口（403 会抛错），直接给一段说明
  if (!can('store.view')) {
    root.innerHTML = `<div class="card card-empty">${escapeHtml(t('common.noPermission'))}</div>`;
    return;
  }
  await refreshStores();
  if (can('org.view')) { try { state.regions = (await GET('/api/v2/regions')).items || []; } catch (e) { state.regions = []; } }
  // 门店页涉及 4 种彼此独立的能力，分别按权限控制（原来一律 role === 'admin'）：
  //   创建 store.create ｜ 编辑 store.edit ｜ 删除 store.delete ｜ 店长任命/解绑 staff.assign
  const canCreateStore = can('store.create');
  const canEditStore = can('store.edit');
  const canDeleteStore = can('store.delete');
  const canAssignManager = can('staff.assign');
  const wideStores = isWideScope('store.view');
  const subtitle = wideStores
    ? t('stores.subtitleAdmin', { n: state.stores.length })
    : t('stores.subtitleMgr', { n: state.stores.length });
  const regionNames = new Map((state.regions || []).map(region => [region.id, region.name]));
  const regionCounts = new Map();
  for (const store of state.stores) {
    const name = regionNames.get(store.regionId) || store.city || ccText('Unassigned', '未分配区域');
    regionCounts.set(name, (regionCounts.get(name) || 0) + 1);
  }
  const regionBars = [...regionCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => `<div class="cc-region-row"><span>${escapeHtml(name)}</span><div class="cc-region-track" role="img" aria-label="${escapeHtml(name)}: ${count}"><i style="width:${Math.round(count / Math.max(1, state.stores.length) * 100)}%"></i></div><strong>${count}</strong></div>`).join('');
  root.innerHTML = `
    <div class="page-header">
      <div class="page-header-text">
        <div class="page-title">${t('stores.title')}</div>
        <div class="page-subtitle">${subtitle}</div>
      </div>
      <div class="page-spacer"></div>
      ${canCreateStore ? `<button class="btn btn-primary" id="btnAddStore">${t('stores.add')}</button>` : ''}
    </div>
    <div class="cc-workspace-stats">${uiStat(ccText('Visible stores', '可见门店'), state.stores.length, 'brand')}${uiStat(ccText('Manager assigned', '已指派负责人'), state.stores.filter(s => s.managerId).length, 'success')}${uiStat(ccText('No manager assigned', '未指派负责人'), state.stores.filter(s => !s.managerId).length, 'warning')}${uiStat(ccText('Regions', '涉及区域'), new Set(state.stores.map(s => s.regionId || s.city).filter(Boolean)).size, 'neutral')}</div>
    <section class="card cc-region-card"><div class="card-title">${ccText('Visible stores by region', '可见门店区域分布')}</div><div class="card-subtitle">${ccText('Counts are based on stores within your access scope.', '数量仅统计当前账号可查看的门店。')}</div>${regionBars || ccEmptyState(ccText('No stores', '暂无门店'), ccText('Stores will appear after they are added.', '添加门店后会显示区域分布。'))}</section>
    <div class="store-grid">
      ${state.stores.map(s => `
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">${escapeHtml(tStore(s.name))}</div>
              <div class="card-subtitle">${escapeHtml(s.city)} · ${escapeHtml(s.address)}</div>
            </div>
            <div class="spacer"></div>
            <span class="mono" style="font-size:12px;color:#9AA8A2;">${escapeHtml(s.phone)}</span>
          </div>
          <div class="inset">
            <div style="font-size:12px;color:#718078;margin-bottom:8px;">${t('stores.currentManager')}</div>
            ${s.managerId ? `
              <div style="display:flex;align-items:center;gap:10px;">
                <div class="avatar" style="width:36px;height:36px;background:#16A34A;color:#FFF;display:flex;align-items:center;justify-content:center;border-radius:50%;font-weight:600;">${initials(s.managerName)}</div>
                <div style="flex:1;">
                  <div style="font-size:14px;font-weight:500;">${escapeHtml(tName(s.managerName))}</div>
                  <div class="mono" style="font-size:12px;color:#718078;">${t('stores.managerActive')}</div>
                </div>
                ${(canAssignManager && !isSelfManager(s)) ? `<button class="btn btn-sm btn-danger" data-action="unbind" data-store="${s.id}" data-manager="${s.managerId}">${t('stores.unbind')}</button>` : ''}
              </div>
            ` : `
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <span style="color:#9AA8A2;font-size:13px;">${t('stores.noManager')}</span>
                ${canAssignManager ? `<button class="btn btn-primary btn-sm" data-action="assign" data-store="${s.id}">${t('stores.assign')}</button>` : ''}
              </div>
            `}
          </div>
          ${canEditStore || (canAssignManager && !isSelfManager(s)) || canDeleteStore ? `
            <div style="display:flex;gap:8px;">
              ${canEditStore ? `<button class="btn btn-sm" data-action="edit-store" data-store="${s.id}">${t('stores.editStore')}</button>` : ''}
              ${(canAssignManager && !isSelfManager(s)) ? `<button class="btn btn-sm" data-action="assign" data-store="${s.id}">${s.managerId ? t('stores.changeManager') : t('stores.addManager')}</button>` : ''}
              <div class="spacer" style="flex:1;"></div>
              ${canDeleteStore ? `<button class="btn btn-sm btn-danger" data-action="delete-store" data-store="${s.id}">${t('stores.deleteStore')}</button>` : ''}
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
  `;
  $('#btnAddStore')?.addEventListener('click', () => openStoreForm(null));
  $$('[data-action]', root).forEach(b => b.addEventListener('click', () => {
    if (b.dataset.action === 'assign') openManagerForm(b.dataset.store);
    if (b.dataset.action === 'edit-store') openStoreForm(state.stores.find(s => s.id === b.dataset.store));
    if (b.dataset.action === 'unbind') confirmUnbind(b.dataset.store, b.dataset.manager);
    if (b.dataset.action === 'delete-store') confirmDeleteStore(b.dataset.store);
  }));
}

async function refreshStores() { state.stores = (await GET('/api/stores')).items; }

function openStoreForm(store) {
  const isEdit = !!store;
  // 已绑定店长账号时，门店经理名由分配/解绑逻辑维护，表单里不允许手改
  const managerBound = isEdit && !!store.managerId;
  const managerVal = escapeHtml(store?.managerName && store.managerName !== '待分配' ? store.managerName : '');
  openModal({
    title: isEdit ? t('storeForm.edit') : t('storeForm.new'),
    body: `
      <form data-form>
        <div class="modal-form-row">
          <label><span>${t('storeForm.name')}</span><input name="name" required value="${escapeHtml(store?.name || '')}"/></label>
        </div>
        <div class="modal-form-row col2">
          <label><span>${t('storeForm.code')}</span><input name="storeCode" value="${escapeHtml(store?.storeCode || '')}" placeholder="NSS-001"/></label>
          <label><span>${t('storeForm.kingdee')}</span><input name="kingdeeAccount" value="${escapeHtml(store?.kingdeeAccount || '')}" placeholder="${escapeHtml(t('common.optional'))}"/></label>
        </div>
        ${(can('org.manage') || (!isEdit && can('store.create'))) && can('org.view') ? `<div class="modal-form-row"><label><span>${ccText('Region', '所属区域')}</span><select name="regionId" ${!isEdit ? 'required' : ''}><option value="">${ccText('Select region', '选择区域')}</option>${state.regions.map(r => `<option value="${escapeHtml(r.id)}" ${r.id === store?.regionId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}</select></label></div>` : ''}
        <div class="modal-form-row">
          <label><span>${t('storeForm.manager')}</span>
            <input name="managerName" value="${managerVal}" placeholder="${escapeHtml(t('common.optional'))}" ${managerBound ? 'disabled' : ''}/>
          </label>
          ${managerBound ? `<div style="font-size:11.5px;color:var(--muted);margin-top:-2px;">${t('storeForm.managerBound')}</div>` : ''}
        </div>
        <div class="modal-form-error"></div>
      </form>
    `,
    footer: `<button class="btn" data-close>${t('common.cancel')}</button><button class="btn btn-primary" id="confirmStore">${isEdit ? t('common.save') : t('common.create')}</button>`,
  });
  $('#confirmStore').addEventListener('click', e => { e.preventDefault(); activeModal.querySelector('form[data-form]').requestSubmit(); });
  formFromTemplate(null, async (data) => {
    if (!data.managerName || (data.managerName = data.managerName.trim()) === '') delete data.managerName;
    if (isEdit) await PUT(`/api/stores/${store.id}`, data);
    else await POST('/api/stores', data);
    closeModal(); toast(isEdit ? t('common.saved') : t('storeForm.createdMsg'), 'success');
    await refreshStores(); renderStores($('#content'));
  });
}

function openManagerForm(storeId) {
  const store = state.stores.find(s => s.id === storeId);
  openModal({
    title: t('managerForm.title', { store: tStore(store.name) }),
    wide: true,
    body: `
      <div class="inset inset-tight">
        ${t('managerForm.hint')}
      </div>
      <form data-form>
        <div class="modal-form-row col2">
          <label><span>${t('managerForm.username')}</span><input name="username" required pattern="[a-zA-Z0-9_]+" placeholder="manila_mgr"/></label>
          <label><span>${t('managerForm.name')}</span><input name="name" required placeholder="Maria Cruz"/></label>
        </div>
        <div class="modal-form-row col2">
          <label><span>${t('managerForm.password')}</span><input name="password" type="password" autocomplete="new-password" required minlength="12" placeholder="${escapeHtml(t('managerForm.passwordPh'))}"/></label>
          <label><span>${t('managerForm.phone')}</span><input name="phone" placeholder="0917 000 0000"/></label>
        </div>
        <div class="modal-form-error"></div>
      </form>
    `,
    footer: `<button class="btn" data-close>${t('common.cancel')}</button><button class="btn btn-primary" id="confirmMgr">${t('managerForm.confirm')}</button>`,
  });
  $('#confirmMgr').addEventListener('click', e => { e.preventDefault(); activeModal.querySelector('form[data-form]').requestSubmit(); });
  formFromTemplate(null, async (data) => {
    const r = await POST(`/api/stores/${storeId}/managers`, data);
    closeModal();
    toast(t('managerForm.created', { name: r.manager.name, username: r.manager.username }), 'success');
    await refreshStores(); renderStores($('#content'));
  });
}

async function confirmUnbind(storeId, managerId) {
  const store = state.stores.find(s => s.id === storeId);
  if (!store) return;
  const ok = await confirmDialog({
    title: t('unbind.title'),
    body: t('unbind.body', { manager: escapeHtml(tName(store.managerName)), store: escapeHtml(tStore(store.name)) }),
    confirmLabel: t('unbind.confirm'),
    danger: true,
  });
  if (!ok) return;
  try {
    await DELETE(`/api/stores/${storeId}/managers/${managerId}`);
    toast(t('unbind.done'), 'success');
    await refreshStores(); renderStores($('#content'));
  } catch (e) {
    toast(tMsg(e.message || e), 'error');
  }
}

/** 删除门店：后端会拒绝「名下还有会员」的门店，这里把原因如实弹出来 */
async function confirmDeleteStore(storeId) {
  const store = state.stores.find(s => s.id === storeId);
  if (!store) return;
  const ok = await confirmDialog({
    title: t('stores.deleteTitle'),
    body: t('stores.deleteBody', { name: escapeHtml(tStore(store.name)) }),
    confirmLabel: t('common.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await DELETE(`/api/stores/${storeId}`);
    toast(t('stores.deletedMsg'), 'success');
    await refreshStores(); renderStores($('#content'));
  } catch (e) {
    toast(tMsg(e.message || e), 'error');
  }
}

// =================== 云同步（服务器自动同步 → Google Sheets）===================
// 由服务器定时自动推送，门店无需任何操作；「立即同步」也在服务器端执行。

let sheetsLiveTimer = null;

function stopSheetsLive() {
  if (sheetsLiveTimer) { clearInterval(sheetsLiveTimer); sheetsLiveTimer = null; }
}

async function refreshSheets() {
  state.sheets = await GET('/api/sheets/status');
  updateSyncChip();
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(locale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function autoOn(cfg) { return (cfg || {}).autoSync !== false; }

/** 隐藏顶栏同步状态（店长看不到云同步相关的一切） */
function hideSyncChip() {
  const chip = $('#syncChip');
  if (chip) chip.style.display = 'none';
}

function updateSyncChip() {
  const chip = $('#syncChip');
  const txt = $('#syncChipText');
  if (!chip || !txt) return;
  // 同步仅属于旧会员积分模块；集团中控及系统页面不显示其状态。
  const inMemberPoints = Boolean($('#legacyNavGroup')?.querySelector(`.nav-item[data-screen="${state.screen}"]`));
  chip.style.display = can('sync.view') && inMemberPoints ? '' : 'none';
  if (!can('sync.view') || !inMemberPoints) return;
  chip.classList.remove('warn', 'err');
  const cfg = state.sheets || {};
  const rt = cfg.runtime || {};
  if (!cfg.gasUrl || !cfg.spreadsheetId) {
    txt.textContent = t('sheets.chipNotConfigured');
    chip.classList.add('warn');
  } else if (rt.syncing) {
    txt.textContent = t('sheets.chipSyncing');
  } else if (cfg.lastSyncResult === 'failed') {
    txt.textContent = t('sheets.chipError');
    chip.classList.add('err');
  } else if (rt.pendingChanges) {
    txt.textContent = t('sheets.chipPending');
  } else if (cfg.lastSyncAt) {
    txt.textContent = t(autoOn(cfg) ? 'sheets.chipAuto' : 'sheets.chipSynced', { time: fmtTime(cfg.lastSyncAt) });
  } else {
    txt.textContent = t('sheets.chipReady');
  }
}

/** 同步状态卡片的内部 HTML（独立刷新，不影响输入框） */
function syncStatusHtml() {
  const cfg = state.sheets || {};
  const rt = cfg.runtime || {};
  const configured = !!(cfg.gasUrl && cfg.spreadsheetId);
  const on = autoOn(cfg);
  const interval = cfg.autoSyncInterval || 15;
  const sourceLabel = cfg.lastSyncSource === 'manual' ? t('sheets.sourceManual')
    : cfg.lastSyncSource === 'auto' ? t('sheets.sourceAuto') : '—';
  const intervalOptions = [5, 10, 15, 30, 60, 120].map(m =>
    `<option value="${m}" ${Number(interval) === m ? 'selected' : ''}>${t('sheets.everyNMin', { n: m })}</option>`).join('');

  if (!configured) {
    return `
      <div class="card-subtitle" style="margin-bottom:14px;">${t('sheets.notConfigured')}</div>
      <div class="section">
        <div class="kv-row"><span class="k">${t('sheets.gasUrl')}</span><span class="v">${t('sheets.notFilled')}</span></div>
        <div class="kv-row"><span class="k">${t('sheets.sheetId')}</span><span class="v">${t('sheets.notFilled')}</span></div>
      </div>`;
  }

  return `
    <div class="card-subtitle" style="margin-bottom:16px;">${on
      ? t('sheets.running', { n: interval })
      : t('sheets.paused')}</div>

    <div class="kv-row"><span class="k">${t('sheets.statusCard')}</span><span class="v">${
      rt.syncing ? `<span class="pill pill-retail">${t('sheets.stSyncing')}</span>`
      : rt.pendingChanges ? `<span class="pill pill-frozen">${t('sheets.stPending')}</span>`
      : cfg.lastSyncResult === 'failed' ? `<span class="pill pill-frozen">${t('sheets.stFailed')}</span>`
      : `<span class="pill pill-active"><span class="d"></span>${t('sheets.stIdle')}</span>`}</span></div>
    <div class="kv-row"><span class="k">${t('sheets.nextSync')}</span><span class="v">${rt.syncing ? t('sheets.inProgress') : fmtTime(cfg.nextSyncAt)}</span></div>
    <div class="kv-row"><span class="k">${t('sheets.lastSync')}</span><span class="v">${fmtTime(cfg.lastSyncAt)}</span></div>
    <div class="kv-row"><span class="k">${t('sheets.source')}</span><span class="v">${sourceLabel}${cfg.lastSyncCostMs ? ` · ${(cfg.lastSyncCostMs / 1000).toFixed(1)}s` : ''}</span></div>
    <div class="kv-row"><span class="k">${t('sheets.content')}</span><span class="v">${escapeHtml(tMsg(cfg.lastSyncSummary) || '—')}</span></div>
    <div class="kv-row"><span class="k">${t('sheets.count')}</span><span class="v">${fmt(cfg.syncCount || 0)}</span></div>

    <div class="section" style="margin-top:16px;padding-top:14px;border-top:1px solid #F1F3F2;">
      <div class="switch-row">
        <div>
          <div class="switch-label">${t('sheets.autoSync')}</div>
          <div class="switch-hint">${t('sheets.autoSyncHint')}</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="autoSyncToggle" ${on ? 'checked' : ''}/>
          <span class="track"><span class="thumb"></span></span>
        </label>
      </div>
      <div class="switch-row">
        <div>
          <div class="switch-label">${t('sheets.interval')}</div>
          <div class="switch-hint">${t('sheets.intervalHint')}</div>
        </div>
        <select class="filter-input" id="syncIntervalSel" style="width:130px;">${intervalOptions}</select>
      </div>
    </div>

    <div class="section" style="margin-top:16px;padding-top:14px;border-top:1px solid #F1F3F2;">
      <div class="kv-row"><span class="k">${t('sheets.gasUrl')}</span><span class="v mono" style="font-size:11px;word-break:break-all;">${escapeHtml(cfg.gasUrl.slice(0, 36) + '…')}</span></div>
      <div class="kv-row"><span class="k">${t('sheets.sheetId')}</span><span class="v mono" style="font-size:11px;word-break:break-all;">${escapeHtml(cfg.spreadsheetId)}</span></div>
    </div>
    ${cfg.lastError ? `<div style="background:#FEE2E2;color:#DC2626;padding:10px;border-radius:8px;font-size:12px;font-family:monospace;white-space:pre-wrap;margin-top:14px;">${escapeHtml(tMsg(cfg.lastError))}</div>` : ''}
  `;
}

function paintSyncStatus() {
  const box = $('#syncStatusBody');
  if (box) box.innerHTML = syncStatusHtml();
}

async function renderSheets(root) {
  // 云同步页面涉及 3 个独立能力：查看 sync.view ｜ 手动触发 sync.run ｜ 改配置 sync.config
  const canViewSync = can('sync.view');
  const canRunSync = can('sync.run');
  const canConfigSync = can('sync.config');
  const cfg = state.sheets || {};
  const configured = !!(cfg.gasUrl && cfg.spreadsheetId);
  root.innerHTML = `
    <div class="page-header">
      <div class="page-header-text">
        <div class="page-title">${t('sheets.title')}</div>
        <div class="page-subtitle">${t('sheets.subtitle')}</div>
      </div>
      <div class="page-spacer"></div>
      ${canRunSync && configured ? `<button class="btn" id="btnPush">${t('sheets.syncNow')}</button>` : ''}
    </div>
    ${cfg._legacy ? `<div class="note note-warn" style="margin-bottom:16px;font-size:13px;">⚠️ ${escapeHtml(tMsg(cfg._legacy))}</div>` : ''}
    <div class="row-2">
      <div class="card">
        <div class="card-title">${t('sheets.statusCard')}</div>
        <div id="syncStatusBody" style="margin-top:12px;">${syncStatusHtml()}</div>
      </div>
      <div class="card">
        <div class="card-title">${t('sheets.configCard')}</div>
        <div class="card-subtitle" style="margin-bottom:16px;">${configured ? t('sheets.configSubEdit') : t('sheets.configSubNew')}</div>
        ${!configured ? `
        <div style="display:flex;flex-direction:column;gap:10px;font-size:13px;">
          <div style="display:flex;gap:10px;align-items:flex-start;">
            <div class="step-dot">1</div>
            <div>${t('sheets.step1')}</div>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-start;">
            <div class="step-dot">2</div>
            <div>${t('sheets.step2')}</div>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-start;">
            <div class="step-dot">3</div>
            <div>${t('sheets.step3')}</div>
          </div>
        </div>` : ''}
        ${canConfigSync ? `
          <div style="margin-top:16px;display:flex;flex-direction:column;gap:8px;">
            <input class="filter-input" id="gasUrlInput" placeholder="${escapeHtml(t('sheets.gasUrlPh'))}" value="${escapeHtml(cfg.gasUrl || '')}"/>
            <input class="filter-input" id="sheetIdInput" placeholder="Google Sheet ID" value="${escapeHtml(cfg.spreadsheetId || '')}"/>
            <button class="btn btn-primary" id="btnSaveCfg">${t('sheets.saveCfg')}</button>
          </div>` : `<div style="margin-top:16px;color:#9AA8A2;font-size:12px;">${t('sheets.adminOnly')}</div>`}
        <div style="margin-top:14px;font-size:12px;color:#9AA8A2;line-height:1.7;">
          ${t('sheets.footnote')}
        </div>
      </div>
    </div>
  `;
  bindSheetsHandlers();
  if (!canViewSync) return;
  // 页面停留期间每 15 秒刷新一次状态（只换状态区，不动输入框）
  stopSheetsLive();
  sheetsLiveTimer = setInterval(async () => {
    if (state.screen !== 'sheets') { stopSheetsLive(); return; }
    try {
      const me = await GET('/api/sheets/status');
      state.sheets = me;
      updateSyncChip();
      paintSyncStatus();
    } catch (e) { /* 忽略瞬时错误 */ }
  }, 15000);
}

/** 事件委托：状态区会被局部重绘，绑在 document 上才不会丢监听 */
let sheetsBound = false;
function bindSheetsHandlers() {
  if (sheetsBound) return;
  sheetsBound = true;

  document.addEventListener('click', async (e) => {
    if (state.screen !== 'sheets' || !can('sync.view')) return;
    if (e.target.closest('#btnPush')) {
      const btn = $('#btnPush');
      if (btn) { btn.disabled = true; btn.textContent = t('sheets.syncing'); }
      await doPush();
      const b2 = $('#btnPush');
      if (b2) { b2.disabled = false; b2.textContent = t('sheets.syncNow'); }
      return;
    }
    if (e.target.closest('#btnSaveCfg')) {
      const url = $('#gasUrlInput')?.value.trim() || '';
      const sid = $('#sheetIdInput')?.value.trim() || '';
      if (!url) return toast(t('sheets.fillUrl'), 'error');
      if (!sid) return toast(t('sheets.fillId'), 'error');
      try {
        await POST('/api/sheets/config', { gasUrl: url, spreadsheetId: sid, autoSync: true });
        toast(t('sheets.cfgSaved'), 'success');
        await refreshSheets();
        paintSyncStatus();
        setTimeout(() => doPush(true), 600);
      } catch (err) { toast(t('sheets.cfgFailed', { msg: tMsg(err.message || err) }), 'error'); }
    }
  });

  document.addEventListener('change', async (e) => {
    if (state.screen !== 'sheets' || !can('sync.view')) return;
    const el = e.target;
    if (el.id === 'autoSyncToggle') {
      try {
        await POST('/api/sheets/config', { autoSync: el.checked });
        toast(el.checked ? t('sheets.autoOn') : t('sheets.autoOff'), 'success');
      } catch (err) { toast(t('sheets.settingFailed', { msg: tMsg(err.message || err) }), 'error'); }
      await refreshSheets();
      paintSyncStatus();
      return;
    }
    if (el.id === 'syncIntervalSel') {
      try {
        await POST('/api/sheets/config', { autoSyncInterval: Number(el.value) });
        toast(t('sheets.intervalUpdated'), 'success');
      } catch (err) { toast(t('sheets.settingFailed', { msg: tMsg(err.message || err) }), 'error'); }
      await refreshSheets();
      paintSyncStatus();
    }
  });
}

/** 立即同步：由服务器执行（服务器可直连 Google） */
async function doPush(silent) {
  try {
    const r = await POST('/api/sheets/sync-now', {});
    if (!silent) toast(t('sheets.syncDone', { summary: tMsg(r.summary || '') }), 'success');
  } catch (e) {
    toast(t('sheets.syncFailed', { msg: tMsg(e.message || e) }), 'error');
  }
  await refreshSheets();
  paintSyncStatus();
}


// =================== 数据主库（管理员只读查看）===================
// 直接读取服务器 data/ 下的原始数据文件：只读、可搜索、可导出，不会改动线上数据。

function dbFmtSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function renderDbShell() {
  const ov = state.db.overview || {};
  const cols = ov.collections || [];
  return `
    <div class="page-header">
      <div class="page-header-text">
        <div class="page-title">${t('db.title')}</div>
        <div class="page-subtitle">${t('db.subtitle')}</div>
      </div>
      <div class="page-spacer"></div>
      <button class="btn" id="dbExportAll">${t('db.exportAll')}</button>
      <button class="btn btn-primary" id="dbRefresh">${t('common.refresh')}</button>
    </div>
    <div class="db-tabs" id="dbTabs">
      ${cols.map(c => `
        <button class="db-tab ${c.key === state.db.key ? 'active' : ''}" data-db-key="${c.key}">
          ${escapeHtml(tMsg(c.label))}<span class="cnt">${fmt(c.count)}</span>
        </button>`).join('')}
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="db-toolbar">
        <input class="filter-input" id="dbQ" placeholder="${escapeHtml(t('db.searchPh'))}" value="${escapeHtml(state.db.q || '')}" style="width:240px;"/>
        <button class="btn btn-sm" id="dbSearch">${t('common.search')}</button>
        ${state.db.q ? `<button class="btn btn-sm" id="dbClearQ">${t('common.clear')}</button>` : ''}
        <div class="page-spacer"></div>
        <select class="filter-input" id="dbPageSize" style="width:120px;">
          ${[10, 20, 50, 100].map(n => `<option value="${n}" ${state.db.pageSize === n ? 'selected' : ''}>${t('db.perPage', { n })}</option>`).join('')}
        </select>
        <button class="btn btn-sm" id="dbExportCsv">${t('db.exportCsv')}</button>
        <button class="btn btn-sm" id="dbExportJson">${t('db.exportJson')}</button>
      </div>
      <div id="dbTable"></div>
    </div>
    <div class="row-2" style="margin-top:16px;">
      <div class="card">
        <div class="card-title">${t('db.storageCard')}</div>
        <div class="card-subtitle" style="margin-bottom:14px;">${t('db.storageSub')}</div>
        <div id="dbStorage"></div>
      </div>
      <div class="card">
        <div class="card-title">${t('db.backupCard')}</div>
        <div class="card-subtitle" style="margin-bottom:14px;">${t('db.backupSub')}</div>
        ${(ov.backups || []).length === 0 ? `<div style="color:#9AA8A2;font-size:13px;">${t('db.noBackup')}</div>` : `
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${ov.backups.map(b => `
            <div class="kv-row" style="align-items:center;">
              <span class="k mono" style="font-size:11px;">${escapeHtml(b.name)}</span>
              <span class="v" style="display:flex;align-items:center;gap:10px;justify-content:flex-end;">
                <span style="color:#9AA8A2;font-size:11px;">${dbFmtSize(b.size)}</span>
                <button class="btn btn-sm" data-db-backup="${escapeHtml(b.name)}">${t('common.download')}</button>
              </span>
            </div>`).join('')}
        </div>`}
      </div>
    </div>
  `;
}

function paintDbTabs() {
  const box = $('#dbTabs');
  if (!box) return;
  const cols = state.db.overview?.collections || [];
  box.innerHTML = cols.map(c => `
    <button class="db-tab ${c.key === state.db.key ? 'active' : ''}" data-db-key="${c.key}">
      ${escapeHtml(tMsg(c.label))}<span class="cnt">${fmt(c.count)}</span>
    </button>`).join('');
}

function paintDbStorage() {
  const box = $('#dbStorage');
  if (!box) return;
  const ov = state.db.overview || {};
  const d = state.db.data || {};
  const meta = (ov.collections || []).find(c => c.key === state.db.key) || {};
  const countText = d.filtered
    ? `${fmt(meta.count || 0)} <span style="color:#9AA8A2;font-size:12px;">${t('db.filtered', { n: fmt(d.total || 0) })}</span>`
    : fmt(meta.count || 0);
  box.innerHTML = `
    <div class="kv-row"><span class="k">${t('db.dataDir')}</span><span class="v mono" style="font-size:11px;word-break:break-all;">${escapeHtml(ov.dataDir || '')}</span></div>
    <div class="kv-row"><span class="k">${t('db.currentTable')}</span><span class="v">${escapeHtml(tMsg(d.label) || '—')}</span></div>
    <div class="kv-row"><span class="k">${t('db.recordCount')}</span><span class="v mono">${countText}</span></div>
    <div class="kv-row"><span class="k">${t('db.fileSize')}</span><span class="v mono">${dbFmtSize(meta.size || d.size)}</span></div>
    <div class="kv-row"><span class="k">${t('db.lastWrite')}</span><span class="v">${fmtTime(d.updatedAt)}</span></div>
    <div class="kv-row"><span class="k">${t('db.totalSize')}</span><span class="v mono">${dbFmtSize(ov.totalSize)}</span></div>
    <div class="kv-row"><span class="k">${t('db.serverTime')}</span><span class="v">${fmtTime(ov.serverTime)}</span></div>
  `;
}

function paintDbTable() {
  const box = $('#dbTable');
  if (!box) return;
  const d = state.db.data;
  if (!d) { box.innerHTML = `<div style="padding:40px;text-align:center;color:#9AA8A2;">${t('common.loading')}</div>`; return; }
  const cols = d.columns || [];
  const plain = (v) => (v === null || v === undefined) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  // 仅把真正的 JSON 对象/数组当结构值折叠展示；`[2026-...] 日志` 这类文本不能误判
  const isJsonLike = (s) => /^\{\s*"/.test(s) || /^\[\s*[\{\[]/.test(s);
  const cellHtml = (v) => {
    if (v === null || v === undefined || v === '') return '<span style="color:#9AA8A2;">—</span>';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return `<span class="mono" style="color:#718078;">${fmtTime(s)}</span>`;
    if (isJsonLike(s)) return `<span class="mono" style="color:#9AA8A2;">${escapeHtml(s.slice(0, 36))}…</span>`;
    return escapeHtml(s.length > 200 ? s.slice(0, 200) + '…' : s);
  };
  const totalPages = Math.max(1, Math.ceil(d.total / d.pageSize));
  box.innerHTML = `
    <div class="raw-tbl-scroll">
      <table class="raw-tbl ${d.kind === 'lines' ? 'wrap' : ''}">
        <thead><tr>
          <th class="idx">#</th>
          ${cols.map(c => `<th>${escapeHtml(tMsg(c.label))}</th>`).join('')}
          <th class="act"></th>
        </tr></thead>
        <tbody>
          ${d.items.length === 0
            ? `<tr><td colspan="${cols.length + 2}" class="empty">${d.filtered ? t('db.noMatch') : t('db.emptyTable')}</td></tr>`
            : d.items.map((it, i) => `
              <tr>
                <td class="idx mono">${(d.page - 1) * d.pageSize + i + 1}</td>
                ${cols.map(c => {
                  const raw = plain(it[c.key]);
                  const tip = raw.length > 40 ? ` title="${escapeHtml(raw.slice(0, 400))}"` : '';
                  return `<td${tip}>${cellHtml(it[c.key])}</td>`;
                }).join('')}
                <td class="act"><button class="btn btn-sm" data-db-raw="${i}" title="${escapeHtml(t('db.rawJson'))}">JSON</button></td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${d.items.length === 0 ? '' : `
      <div class="pager">
        <span>${t('db.pager', { total: fmt(d.total), filtered: d.filtered ? t('db.filteredMark') : '', size: d.pageSize, page: d.page, pages: totalPages })}</span>
        <div class="spacer"></div>
        <button class="pager-btn" data-db-page="${Math.max(1, d.page - 1)}" ${d.page === 1 ? 'disabled' : ''}>${t('members.prev')}</button>
        ${renderPagerPages(d.page, totalPages)}
        <button class="pager-btn" data-db-page="${Math.min(totalPages, d.page + 1)}" ${d.page === totalPages ? 'disabled' : ''}>${t('members.next')}</button>
      </div>`}
  `;
}

async function selectDbCollection(key, page) {
  state.db.key = key;
  state.db.page = Math.max(1, page || 1);
  const params = new URLSearchParams({ page: state.db.page, pageSize: state.db.pageSize });
  if (state.db.q) params.set('q', state.db.q);
  const data = await GET(`/api/db/collection/${key}?` + params);
  state.db.data = data;
  state.db.page = data.page;
  paintDbTabs();
  paintDbTable();
  paintDbStorage();
}

async function renderDb(root) {
  if (!state.db) state.db = { key: 'members', q: '', page: 1, pageSize: 20, overview: null, data: null };
  root.innerHTML = `<div class="card" style="text-align:center;color:#9AA8A2;padding:40px;">${t('common.readingDb')}</div>`;
  state.db.overview = await GET('/api/db/overview');
  const cols = state.db.overview.collections || [];
  if (!cols.some(c => c.key === state.db.key)) state.db.key = cols[0]?.key || 'members';
  root.innerHTML = renderDbShell();
  bindDbHandlers();
  await selectDbCollection(state.db.key, 1);
}

function openRawRecord(idx) {
  const it = state.db.data?.items?.[idx];
  if (!it) return;
  openModal({
    title: t('db.rawTitle', { label: tMsg(state.db.data.label) }),
    wide: true,
    body: `<pre class="raw-json">${escapeHtml(JSON.stringify(it, null, 2))}</pre>`,
  });
}

function dbDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 事件委托：表格与标签会被局部重绘，监听统一绑在 document 上 */
let dbBound = false;
function bindDbHandlers() {
  if (dbBound) return;
  dbBound = true;

  document.addEventListener('click', async (e) => {
    if (state.screen !== 'db' || !can('db.view')) return;

    const tab = e.target.closest('[data-db-key]');
    if (tab) { await selectDbCollection(tab.dataset.dbKey, 1); return; }

    const pg = e.target.closest('[data-db-page]') || e.target.closest('.pager-btn[data-page]');
    if (pg) {
      const target = Number(pg.dataset.dbPage || pg.dataset.page || 0);
      if (target > 0) { await selectDbCollection(state.db.key, target); return; }
    }

    const raw = e.target.closest('[data-db-raw]');
    if (raw) { openRawRecord(Number(raw.dataset.dbRaw)); return; }

    const bk = e.target.closest('[data-db-backup]');
    if (bk) { dbDownload('/api/db/backup/' + encodeURIComponent(bk.dataset.dbBackup)); return; }

    if (e.target.closest('#dbSearch')) { state.db.q = $('#dbQ')?.value.trim() || ''; await selectDbCollection(state.db.key, 1); return; }
    if (e.target.closest('#dbClearQ')) { state.db.q = ''; const i = $('#dbQ'); if (i) i.value = ''; await selectDbCollection(state.db.key, 1); return; }
    if (e.target.closest('#dbRefresh')) { state.db.overview = await GET('/api/db/overview'); paintDbTabs(); await selectDbCollection(state.db.key, state.db.page); toast(t('db.refreshed'), 'success'); return; }
    if (e.target.closest('#dbExportCsv')) { dbDownload(`/api/db/export?key=${state.db.key}&format=csv`); return; }
    if (e.target.closest('#dbExportJson')) { dbDownload(`/api/db/export?key=${state.db.key}&format=json`); return; }
    if (e.target.closest('#dbExportAll')) { dbDownload('/api/db/export?key=all&format=json'); return; }
  });

  document.addEventListener('keydown', async (e) => {
    if (state.screen !== 'db' || !can('db.view')) return;
    if (e.target.id === 'dbQ' && e.key === 'Enter') {
      state.db.q = e.target.value.trim();
      await selectDbCollection(state.db.key, 1);
    }
  });

  document.addEventListener('change', async (e) => {
    if (state.screen !== 'db' || !can('db.view')) return;
    if (e.target.id === 'dbPageSize') {
      state.db.pageSize = Number(e.target.value) || 20;
      await selectDbCollection(state.db.key, 1);
    }
  });
}

// =================== 账号设置 ===================
// =================== 审计日志（P4，2026-09-22 上线）===================
// 纯只读页面：展示 lib/audit 的 append-only 审计日志，支持关键词筛选与分页。
// 权限沿用既有的 system.audit.view（矩阵里只有 admin 拥有；后端已强制鉴权，
// 前端只是不显示入口）。
//
// 本页**不提供任何写操作** —— 审计日志没有删除/清空/修改入口，
// 也不从这里触发任何业务动作（账号/店长/会员/积分都不在此操作）。
//
// 字段说明：日志是自由文本（`[时间] 一段说明`），除时间戳外**没有结构化字段**
//   （每种事件措辞都不同：`login: x`、`create manager: X for Y by Z`…）。
//   所以这里只把时间单独排版、其余原样展示，筛选走关键词匹配；
//   **不臆造「用户 / 对象 / 结果」列** —— 猜错比不显示更糟。
async function renderAudit(root) {
  if (!state.audit) state.audit = { q: '', page: 1, pageSize: 50 };
  const st = state.audit;
  const data = await GET('/api/audit-log?page=' + st.page + '&pageSize=' + st.pageSize +
    (st.q ? '&q=' + encodeURIComponent(st.q) : ''));
  const items = data.items || [];
  const total = data.total || 0;
  const page = data.page || 1;
  const pages = data.pages || 1;
  const summary = t('audit.summary', { total: fmt(total), page: fmt(page), pages: fmt(pages) });

  root.innerHTML = `
    <div class="page-header">
      <div class="page-header-text">
        <div class="page-title">${t('audit.title')}</div>
        <div class="page-subtitle">${t('audit.subtitle')}</div>
      </div>
      <div class="page-spacer"></div>
      <div class="filter-bar">
        <input class="filter-input" id="auQ" type="search" value="${escapeHtml(st.q)}" placeholder="${escapeHtml(t('audit.searchPh'))}" />
        <button class="btn btn-primary" id="auSearch">${t('common.search')}</button>
        ${st.q ? `<button class="btn" id="auReset">${t('common.reset')}</button>` : ''}
      </div>
    </div>
    <div class="card" style="padding:11px 16px;display:flex;align-items:center;gap:12px;font-size:12.5px;color:#718078;">
      <span>${escapeHtml(summary)}</span>
      <span style="flex:1;"></span>
      <span>${escapeHtml(t('audit.readonly'))}</span>
    </div>
    ${items.length === 0
      ? `<div class="card card-empty">${escapeHtml(t(st.q ? 'audit.emptyFiltered' : 'audit.empty'))}</div>`
      : `<div class="tx-list" style="max-height:none;">
          ${items.map(x => `
            <div class="tx-row" style="grid-template-columns:190px 1fr;">
              <span class="mono tx-time" style="text-align:left;">${x.at ? escapeHtml(new Date(x.at).toLocaleString(locale())) : '—'}</span>
              <span class="tx-reason" style="word-break:break-word;">${escapeHtml(x.message)}</span>
            </div>`).join('')}
        </div>`}
    ${items.length === 0 ? '' : `
      <div class="pager">
        <span>${escapeHtml(summary)}</span>
        <div class="spacer"></div>
        <button class="pager-btn" data-apage="${Math.max(1, page - 1)}" ${page === 1 ? 'disabled' : ''}>${t('members.prev')}</button>
        ${renderPagerPages(page, pages)}
        <button class="pager-btn" data-apage="${Math.min(pages, page + 1)}" ${page === pages ? 'disabled' : ''}>${t('members.next')}</button>
      </div>`}
  `;

  const doSearch = async () => {
    state.audit = { ...st, q: ($('#auQ').value || '').trim(), page: 1 };
    await renderScreen();
  };
  $('#auSearch').addEventListener('click', doSearch);
  $('#auQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  const reset = $('#auReset');
  if (reset) reset.addEventListener('click', async () => { state.audit = { ...st, q: '', page: 1 }; await renderScreen(); });
  // 与数据主库页同一写法：自家 data-apage 优先，兼容 renderPagerPages 产出的 data-page
  $$('.pager-btn', root).forEach(b => b.addEventListener('click', async () => {
    const raw = b.dataset.apage !== undefined ? b.dataset.apage : b.dataset.page;
    if (raw === undefined) return;                    // 省略号那个 span 没有 data-*，忽略即可
    state.audit = { ...st, page: parseInt(raw, 10) || 1 };
    await renderScreen();
  }));
}

// =================== 账号管理（P5 2026-09-22 / P6 2026-09-24） ===================
// 本页做三件事：启用 / 停用 / 删除。不建号、不改用户名 / 角色 / 门店绑定 / 密码。
// 权限沿用既有的 system.user.view（列表）与 system.user.edit（启停 + 删除），本页不新造权限。
//
// 表格列（2026-09-24 按用户要求调整）：门店 ｜ 用户名 ｜ 职位 ｜ 状态 ｜ 操作
//   · 「门店」取代了原来的「姓名」列并移到第一列（按门店归类看）
//   · ★ 门店列的数据来源只在本页可见的门店范围内解析（fail-closed）：
//     后端会按数据范围过滤用户列表、门店表也一样，
//     所以非全局角色即便能看到本页，也只会看到自己范围内的门店名，查不到的一律显示「—」。
//
// ★ 后端才是硬边界：① 已绑定门店的店长 ② 最后一个启用状态的 system.user.edit 持有者
//   ③ 当前登录账号自己 —— 启用/停用/删除这三类被禁的请求一律由后端 400 拒绝。
//   前端这里只是「不渲染必然失败的入口」（自身那行不渲染停用/删除按钮），
//   绝不以隐藏按钮作为安全手段。

async function renderAccounts(root) {
  // 防御：没有 system.user.view 时不要请求接口（403 会抛错），直接给一段说明
  if (!can('system.user.view')) {
    root.innerHTML = `<div class="card card-empty">${escapeHtml(t('common.noPermission'))}</div>`;
    return;
  }
  // 门店名解析要用最新门店表（有 store.view 才刷；没有就沿用已有数据，只影响展示）
  if (can('store.view')) await refreshStores();
  const data = await GET('/api/users');
  const items = data.items || [];
  const canEdit = can('system.user.edit');
  const [regionData, employeeData] = canEdit ? await Promise.all([GET('/api/v2/regions'), GET('/api/v2/employees')]) : [{ items: [] }, { items: [] }];
  const accountRegions = regionData.items || [], accountEmployees = employeeData.items || [];
  const me = state.me || {};
  const enabledCount = items.filter(x => !x.disabled).length;
  const mobile = isMobile();

  // 「谁还绑着门店」与后端判定同源：stores.managerId 指向该账号
  const boundStoreOf = (id) => state.stores.find(s => s.managerId === id) || null;
  // 门店列：优选用账号自己的 storeId，其次用「被哪家门店绑为店长」；查不到一律「—」
  //   ★ 查不到就显示「—」，不回退成 id、也不猜 —— 这样范围外的门店名永远不会漏出来
  const storeNameFor = (a) => {
    const bound = boundStoreOf(a.id);
    const sid = a.storeId || (bound && bound.id) || null;
    if (!sid) return '—';
    const s = state.stores.find(x => x.id === sid);
    return s ? tStore(s.name) : '—';
  };

  const rowHtml = (a) => {
    const isSelf = a.id === me.id;
    const statusPill = a.disabled
      ? `<span class="pill pill-frozen">${escapeHtml(t('accounts.statusDisabled'))}</span>`
      : `<span class="pill pill-active"><span class="d"></span>${escapeHtml(t('accounts.statusActive'))}</span>`;
    // 提示行：当前登录账号 / 停用时间（「已绑定门店」已被门店列取代，不再重复显示）
    const hintList = [];
    if (isSelf) hintList.push(t('accounts.self'));
    if (a.disabledAt) hintList.push(t('accounts.disabledAtHint', { at: new Date(a.disabledAt).toLocaleString(locale()) }));
    const hints = hintList
      .map(x => `<span style="font-size:11px;color:var(--subtle);">${escapeHtml(x)}</span>`).join('');

    // 按钮门禁：写成 canXxx ? 三元，一眼能看到每个按钮的权限/状态条件
    //   · 自身那行不渲染「停用」与「删除」（后端两者都必然 400）
    //   · 「启用」自身也允许（保持与后端一致：启用历史停用账号是正常操作）
    //   · 删除用中性样式（btn），避免与「停用」混淆；确认弹窗里仍是危险色
    const canEnable  = canEdit;
    const canDisable = canEdit && !isSelf;
    const canDelete  = canEdit && !isSelf;
    const canResetPw = canEdit && !isSelf;
    const btnEnable  = canEnable  ? `<button class="btn btn-sm cc-icon-action cc-positive" data-uid="${escapeHtml(a.id)}" data-act="enable" title="${t('accounts.enable')}" aria-label="${t('accounts.enable')}">✓</button>` : '';
    const btnDisable = canDisable ? `<button class="btn btn-sm cc-icon-action cc-warning" data-uid="${escapeHtml(a.id)}" data-act="disable" title="${t('accounts.disable')}" aria-label="${t('accounts.disable')}">⊘</button>` : '';
    const btnDelete  = canDelete  ? `<button class="btn btn-sm cc-icon-action cc-danger" data-uid="${escapeHtml(a.id)}" data-act="delete" title="${t('accounts.delete')}" aria-label="${t('accounts.delete')}">✕</button>` : '';
    const btnResetPw = canResetPw ? `<button class="btn btn-sm cc-icon-action" data-uid="${escapeHtml(a.id)}" data-act="resetPw" title="${t('accounts.resetPw')}" aria-label="${t('accounts.resetPw')}">↻</button>` : '';
    const action = (a.disabled ? btnEnable + btnDelete : btnDisable + btnDelete) + btnResetPw;

    if (mobile) {
      // 手机端：两列（信息堆叠 + 操作按钮），门店放第一行（按门店归类看）
      return `
        <div class="tx-row" style="grid-template-columns:1fr 104px;">
          <span style="display:flex;flex-direction:column;gap:3px;min-width:0;">
            <span style="font-size:13px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;">${escapeHtml(storeNameFor(a))}</span>
            <span class="mono" style="font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;">${escapeHtml(a.username)}</span>
            <span style="font-size:12px;color:var(--muted);">${escapeHtml(roleLabel(a.role))}</span>
            <span style="margin-top:2px;">${statusPill}</span>
            ${hints}
          </span>
          <span style="text-align:right;display:flex;flex-direction:column;gap:6px;align-items:flex-end;">${action}</span>
        </div>`;
    }
    // 桌面端：5 列（门店 / 用户名 / 职位 / 状态 / 操作）
    return `
      <div class="tx-row" style="grid-template-columns:120px 1fr 108px 96px 252px;">
        <span style="font-size:12.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;">${escapeHtml(storeNameFor(a))}</span>
        <span style="display:flex;flex-direction:column;gap:2px;min-width:0;">
          <span class="mono" style="font-size:12.5px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;">${escapeHtml(a.username)}</span>
          ${hints}
        </span>
        <span style="font-size:12px;color:var(--muted);">${escapeHtml(roleLabel(a.role))}</span>
        <span>${statusPill}</span>
        <span style="display:flex;gap:6px;justify-content:flex-end;">${action}</span>
      </div>`;
  };

  // 表头：沿用 .tx-row 的网格（结构与数据行完全一致），不新增 CSS 类名
  const headHtml = mobile ? '' : `
    <div class="tx-row" style="grid-template-columns:120px 1fr 108px 96px 252px;font-size:11.5px;font-weight:600;color:var(--subtle);border-bottom:1px solid var(--line);">
      <span>${escapeHtml(t('accounts.colStore'))}</span>
      <span>${escapeHtml(t('accounts.colUser'))}</span>
      <span>${escapeHtml(t('accounts.colRole'))}</span>
      <span>${escapeHtml(t('accounts.colStatus'))}</span>
      <span style="text-align:right;">${escapeHtml(t('accounts.colActions'))}</span>
    </div>`;

  const summary = t('accounts.summary', { total: fmt(items.length), active: fmt(enabledCount) });
  const storeAccountCount = items.filter(x => x.storeId || boundStoreOf(x.id)).length;
  const accountBadge = $('#navAccountCount');
  if (accountBadge) { accountBadge.hidden = !items.length; accountBadge.textContent = items.length ? String(items.length) : ''; }
  root.innerHTML = `
    <div class="page-header">
      <div class="page-header-text">
        <div class="page-title">${t('accounts.title')}</div>
        <div class="page-subtitle">${t('accounts.subtitle')}</div>
      </div>
      <div class="page-spacer"></div>
    </div>
    <div class="cc-workspace-stats">${uiStat(ccText('Total accounts', '账号总数'), items.length, 'brand')}${uiStat(ccText('Enabled', '启用中'), enabledCount, 'success')}${uiStat(ccText('Disabled', '已停用'), items.length - enabledCount, 'neutral')}${uiStat(ccText('Store linked', '关联门店'), storeAccountCount, 'warning')}</div>
    ${canEdit ? `<section class="card cc-section"><h3>${ccText('Create login account', '创建登录账号')}</h3><p>${ccText('Set a unique username and a temporary password of at least 12 characters. Store and regional roles must be bound to their scope.', '用户名须唯一，初始密码至少 12 位。门店和区域岗位必须绑定对应范围。')}</p><form id="ccAccountForm" class="cc-form-grid"><label class="cc-field"><span>${ccText('Username', '用户名')}</span><input name="username" required minlength="3" maxlength="48" pattern="[A-Za-z0-9_]+"/></label><label class="cc-field"><span>${ccText('Full name', '姓名')}</span><input name="name" required maxlength="120"/></label><label class="cc-field"><span>${ccText('Initial password (12+ characters)', '初始密码（至少 12 位）')}</span><input name="password" type="password" required minlength="12" autocomplete="new-password"/></label><label class="cc-field"><span>${ccText('Role', '角色')}</span><select name="role"><option value="owner">${escapeHtml(roleLabel('owner'))}</option><option value="hq_operator">${escapeHtml(roleLabel('hq_operator'))}</option><option value="philippines_manager">${escapeHtml(roleLabel('philippines_manager'))}</option><option value="regional_manager">${escapeHtml(roleLabel('regional_manager'))}</option><option value="manager">${escapeHtml(roleLabel('store_manager'))}</option><option value="sales">${escapeHtml(roleLabel('sales'))}</option><option value="warehouse">${escapeHtml(roleLabel('warehouse'))}</option><option value="service">${escapeHtml(roleLabel('service'))}</option><option value="admin">${escapeHtml(roleLabel('admin'))}</option></select></label><label class="cc-field"><span>${ccText('Store', '门店')}</span><select name="storeId"><option value="">${ccText('No store', '不绑定门店')}</option>${state.stores.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(tStore(s.name))}</option>`).join('')}</select></label><label class="cc-field"><span>${ccText('Region', '区域')}</span><select name="regionId"><option value="">${ccText('No region', '不绑定区域')}</option>${accountRegions.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('')}</select></label><label class="cc-field"><span>${ccText('Employee profile', '关联员工档案')}</span><select name="employeeId"><option value="">${ccText('No employee link', '不关联员工')}</option>${accountEmployees.filter(x => !x.userId).map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.employeeCode)} · ${escapeHtml(x.name)}</option>`).join('')}</select></label><label class="cc-field"><span>${ccText('Phone', '电话')}</span><input name="phone" maxlength="80"/></label><div class="cc-wide"><button class="btn btn-primary" type="submit">${ccText('Create account', '创建账号')}</button></div></form></section>` : ''}
    <div class="card" style="padding:11px 16px;display:flex;align-items:center;gap:12px;font-size:12.5px;color:var(--muted);">
      <span>${escapeHtml(summary)}</span>
      <span style="flex:1;"></span>
      <span>${escapeHtml(canEdit ? t('accounts.scopeFull') : t('accounts.scopeReadonly'))}</span>
    </div>
    ${items.length === 0
      ? `<div class="card" style="text-align:center;color:var(--muted);padding:44px;">${escapeHtml(t('accounts.empty'))}</div>`
      : `<div class="tx-list" style="max-height:none;">${headHtml}${items.map(rowHtml).join('')}</div>`}
  `;

  $('#ccAccountForm')?.addEventListener('submit', async e => {
    e.preventDefault(); const fd = new FormData(e.currentTarget);
    try { await POST('/api/v2/users', Object.fromEntries(fd.entries())); toast(ccText('Account created', '账号已创建'), 'success'); await renderAccounts(root); }
    catch (err) { toast(err.message, 'error'); }
  });

  // 事件绑定：与按钮条件渲染同时加守卫 —— 按钮没渲染时 $$ 返回空数组，不会抛错
  $$('[data-uid]', root).forEach(b => b.addEventListener('click', () => {
    const target = items.find(x => x.id === b.dataset.uid);
    if (!target) return;
    if (b.dataset.act === 'delete') confirmUserDelete(target);
    else if (b.dataset.act === 'resetPw') resetPasswordDialog(target);
    else confirmUserStatus(target, b.dataset.act === 'disable');
  }));
}

/** 启用 / 停用的二次确认。启用时明确告知会恢复该账号的登录能力。 */
async function confirmUserStatus(account, toDisable) {
  const ok = await confirmDialog({
    title: t(toDisable ? 'accounts.disableTitle' : 'accounts.enableTitle'),
    body: toDisable
      ? t('accounts.disableBody', { username: escapeHtml(account.username), name: escapeHtml(tName(account.name)) })
      : t('accounts.enableBody', { username: escapeHtml(account.username), name: escapeHtml(tName(account.name)) }),
    confirmLabel: t(toDisable ? 'accounts.disable' : 'accounts.enable'),
    danger: toDisable,
  });
  if (!ok) return;
  try {
    await PUT('/api/users/' + encodeURIComponent(account.id) + '/status', { disabled: toDisable });
    toast(t(toDisable ? 'accounts.disabled' : 'accounts.enabled'), 'success');
    await renderScreen();
  } catch (e) {
    // 后端的状态护栏（已绑定门店 / 最后一个账号管理权限持有者 / 停用自己）会把原因原样带回来
    toast(tMsg(e.message || e), 'error');
  }
}

/** 删除账号的二次确认（真删除、不可逆）。后端仍有三条护栏，被拒时原样回显原因。 */
async function confirmUserDelete(account) {
  const ok = await confirmDialog({
    title: t('accounts.deleteTitle'),
    body: t('accounts.deleteBody', { username: escapeHtml(account.username), name: escapeHtml(tName(account.name)) }),
    confirmLabel: t('accounts.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await DELETE('/api/users/' + encodeURIComponent(account.id));
    toast(t('accounts.deleted'), 'success');
    await renderScreen();
  } catch (e) {
    toast(tMsg(e.message || e), 'error');
  }
}

/** 生成一次性随机密码：调用处使用至少 16 位，剔除易混字符 0/O/1/l/I。 */
function suggestPassword(len) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const n = len || 10;
  const buf = new Uint32Array(n);
  (window.crypto || window.msCrypto).getRandomValues(buf);
  let out = '';
  for (let i = 0; i < n; i++) out += chars[buf[i] % chars.length];
  return out;
}

/** 管理员重置密码（2026-09-24 用户授权新增）。
 *  密码是 bcrypt 单向哈希 → 旧的查不到、只能重置。
 *  新密码只在本机输入框里，**不回传服务端以外的任何地方**；后端也不回传密码。 */
function resetPasswordDialog(account) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; closeModal(); resolve(v); };
    const root = openModal({
      title: t('accounts.resetPwTitle'),
      body: `
        <div style="font-size:13.5px;line-height:1.75;color:var(--muted);">${escapeHtml(t('accounts.resetPwBody', { username: account.username, name: tName(account.name) }))}</div>
        <div style="margin-top:14px;display:flex;gap:8px;align-items:flex-end;">
          <label style="flex:1;display:flex;flex-direction:column;gap:6px;">
            <span style="font-size:12px;color:var(--muted);">${escapeHtml(t('accounts.resetPwLabel'))}</span>
            <input type="password" id="rpNew" autocomplete="new-password" minlength="12"
                   style="height:38px;padding:0 12px;border:1px solid var(--line);border-radius:8px;font-size:13px;" />
          </label>
          <button class="btn btn-sm" id="rpGen" type="button" style="height:38px;">${escapeHtml(t('accounts.resetPwGenerate'))}</button>
        </div>
        <div id="rpErr" style="margin-top:8px;font-size:12.5px;color:#DC2626;min-height:18px;"></div>
      `,
      footer: `
        <button class="btn" id="rpCancel">${t('common.cancel')}</button>
        <button class="btn btn-primary" id="rpOk">${escapeHtml(t('accounts.resetPw'))}</button>
      `,
    });
    const input = $('#rpNew', root);
    const err = $('#rpErr', root);
    input.focus();
    $('#rpGen', root).addEventListener('click', () => { input.value = suggestPassword(16); err.textContent = ''; });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') $('#rpOk', root).click(); });
    $('#rpCancel', root).addEventListener('click', () => finish(false));
    root.addEventListener('click', e => { if (e.target === root) finish(false); });
    $('#rpOk', root).addEventListener('click', async () => {
      const pw = input.value || '';
      if (pw.length < 12) { err.textContent = t('accounts.resetPwNeed12'); return; }
      try {
        await POST('/api/users/' + encodeURIComponent(account.id) + '/reset-password', { newPassword: pw });
        finish(true);
        showNewPasswordDialog(account, pw);
      } catch (e) {
        // 后端护栏原因原样回显（例如「不能在这里重置自己的密码」），弹窗不关，方便改完重试
        err.textContent = tMsg(e.message || e);
      }
    });
  });
}

/** 重置成功后的「一次性」展示：只有这里能看到新密码，关闭即不再可见。 */
function showNewPasswordDialog(account, password) {
  const root = openModal({
    title: t('accounts.resetPwDone'),
    body: `
      <div style="font-size:13.5px;line-height:1.75;">${escapeHtml(t('accounts.resetPwDoneBody', { username: account.username }))}</div>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center;">
        <code id="npVal" style="flex:1;background:#EDF1EE;padding:10px 14px;border-radius:8px;font-size:15px;letter-spacing:1px;user-select:all;">${escapeHtml(password)}</code>
        <button class="btn btn-sm" id="npCopy" type="button">${escapeHtml(t('accounts.resetPwCopy'))}</button>
      </div>
      <div style="margin-top:10px;font-size:12.5px;color:var(--warn-ink);">${escapeHtml(t('accounts.resetPwOnce'))}</div>
    `,
    footer: `<button class="btn btn-primary" data-close>${t('common.close')}</button>`,
  });
  const copyBtn = $('#npCopy', root);
  copyBtn.addEventListener('click', async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(password);
      } else {
        const ta = document.createElement('textarea');
        ta.value = password;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      copyBtn.textContent = t('accounts.resetPwCopied');
      setTimeout(() => { copyBtn.textContent = t('accounts.resetPwCopy'); }, 1600);
    } catch (e) { toast(t('accounts.resetPwCopy') + ' ✗', 'error'); }
  });
}

function renderAccount(root) {
  // 本页只有展示，没有写操作 —— 因此不涉及任何权限判断，只做「总部账号 / 门店账号」的文案区分。
  const isStoreAccount = !!state.me.storeId;
  root.innerHTML = `
    <div class="page-header">
      <div class="page-header-text">
        <div class="page-title">${t('account.title')}</div>
        <div class="page-subtitle">${t('account.subtitle')}</div>
      </div>
    </div>
    <div class="row-2-eq">
      <div class="card">
        <div class="card-title">${t('account.profile')}</div>
        <div class="card-subtitle" style="margin-bottom:16px;">${isStoreAccount ? t('account.profileSubMgr') : t('account.profileSubAdmin')}</div>
        <div class="section">
          <div class="kv-row"><span class="k">${t('account.username')}</span><span class="v mono">${escapeHtml(state.me.username)}</span></div>
          <div class="kv-row"><span class="k">${t('account.name')}</span><span class="v">${escapeHtml(tName(state.me.name))}</span></div>
          <div class="kv-row"><span class="k">${t('account.role')}</span><span class="v"><span class="pill ${isStoreAccount ? 'pill-retail' : 'pill-b2b'}">${escapeHtml(roleLabel(state.me.role))}</span></span></div>
          ${state.me.storeId ? `<div class="kv-row"><span class="k">${t('account.store')}</span><span class="v">${escapeHtml(state.stores.find(s => s.id === state.me.storeId)?.name || '—')}</span></div>` : ''}
          <div class="kv-row"><span class="k">${t('account.createdAt')}</span><span class="v mono" style="font-size:11px;">${new Date(state.me.createdAt).toLocaleString(locale())}</span></div>
        </div>
      </div>
      <div class="card">
        <div class="card-title" style="margin-bottom:16px;">${t('account.pwdCard')}</div>
        <form data-form id="pwdForm">
          <div class="modal-form-row">
            <label><span>${t('account.currentPwd')}</span><input type="password" name="currentPassword" required/></label>
          </div>
          <div class="modal-form-row">
            <label><span>${t('account.newPwd')}</span><input type="password" name="newPassword" required minlength="12"/></label>
          </div>
          <div class="modal-form-row">
            <label><span>${t('account.confirmPwd')}</span><input type="password" name="confirmPassword" required minlength="12"/></label>
          </div>
          <div class="modal-form-error" id="pwdError"></div>
          <button class="btn btn-primary" type="submit" style="margin-top:8px;">${t('account.changePwd')}</button>
        </form>
      </div>
    </div>
  `;
  $('#pwdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd);
    if (data.newPassword !== data.confirmPassword) { $('#pwdError').textContent = t('account.pwdMismatch'); return; }
    try {
      await POST('/api/auth/change-password', { currentPassword: data.currentPassword, newPassword: data.newPassword });
      toast(t('account.pwdDone'), 'success');
      e.target.reset(); $('#pwdError').textContent = '';
    } catch (err) { $('#pwdError').textContent = tMsg(err.message); }
  });
}

// =================== 经营报表 ===================
async function renderReports(root) {
  const data = await GET('/api/reports/overview');
  const s = data.summary;
  const a30 = data.activity30;
  // 范围文案由报表权限的数据范围推出（store/region/self 为窄范围）
  const narrowReport = !isWideScope('report.view');
  const storeName = narrowReport ? tStore(state.stores.find(x => x.id === state.me.storeId)?.name || '') : '';
  const tsShort = (data.generatedAt || '').slice(0, 16).replace('T', ' ');
  const subTitle = narrowReport
    ? t('reports.subtitleStore', { store: storeName, ts: tsShort })
    : t('reports.subtitleAll', { n: data.storeRanking.length, ts: tsShort });

  root.innerHTML = `
    <div class="page-header">
      <div class="page-header-text">
        <div class="page-title">${t('reports.title')}</div>
        <div class="page-subtitle">${escapeHtml(subTitle)}</div>
      </div>
      <div class="page-spacer"></div>
      <button class="btn" id="btnReportsRefresh">${t('reports.refresh')}</button>
    </div>

    <div class="kpi-row kpi-row-3">
      <div class="card kpi-card kpi-empty">
        <div class="kpi-label">${t('biz.kpiSales')}</div>
        <div class="kpi-value kpi-empty-val">${t('biz.noSalesData')}</div>
        <div class="kpi-delta-sub">${t('biz.dataPending')}</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">${t('reports.activity.earn')}</div>
        <div class="kpi-value mono">${fmt(a30.earnPoints)}</div>
        <div class="kpi-delta-sub">${t('reports.activity.sub')}</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">${t('reports.activity.redeem')}</div>
        <div class="kpi-value mono">${fmt(a30.redeemPoints)}</div>
        <div class="kpi-delta-sub">${t('reports.activity.sub')}</div>
      </div>
    </div>

    <div class="row-2">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${t('reports.activity.title')}</div>
            <div class="card-subtitle">${t('reports.activity.sub')}</div>
          </div>
        </div>
        ${a30.txCount === 0
          ? `<div class="card-empty">${t('reports.activity.empty')}</div>`
          : `<div class="rep-grid">
              <div class="rep-cell"><div class="rep-cell-k">${t('reports.activity.spend')}</div><div class="rep-cell-v mono">${peso(a30.spendPHP)}</div></div>
              <div class="rep-cell"><div class="rep-cell-k">${t('reports.activity.earn')}</div><div class="rep-cell-v mono">${fmt(a30.earnPoints)}</div></div>
              <div class="rep-cell"><div class="rep-cell-k">${t('reports.activity.redeem')}</div><div class="rep-cell-v mono">${fmt(a30.redeemPoints)}</div></div>
              <div class="rep-cell"><div class="rep-cell-k">${t('reports.activity.tx')}</div><div class="rep-cell-v mono">${fmt(a30.txCount)}</div></div>
              <div class="rep-cell"><div class="rep-cell-k">${t('reports.activity.repeat')}</div><div class="rep-cell-v mono">${fmt(a30.repeatBuyers)}</div></div>
              <div class="rep-cell rep-cell-wide"><div class="rep-cell-k">${t('reports.activity.retention')}</div><div class="rep-cell-v"><span class="retention-pill ${a30.repeatRate >= 0.5 ? 'good' : a30.repeatRate >= 0.25 ? 'mid' : 'low'}">${(a30.repeatRate * 100).toFixed(1)}%</span><span class="rep-cell-sub" style="margin-left:8px;">${a30.repeatBuyers} ${t('reports.activity.repeat')}</span></div></div>
            </div>`}
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${t('reports.trend.title')}</div>
            <div class="card-subtitle">${t('reports.trend.sub')}</div>
          </div>
        </div>
        ${renderReportsTrendSvg(data.monthlyTrend)}
      </div>
    </div>

    <div class="row-2">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${t('reports.stores.title')}</div>
            <div class="card-subtitle">${t('reports.stores.sub')}</div>
          </div>
        </div>
        ${data.storeRanking.length === 0 ? `<div class="card-empty">${t('reports.stores.empty')}</div>` : (isMobile() ? `
          <div class="rep-list">
            ${data.storeRanking.map(r => `
              <div class="rep-row">
                <div class="rep-row-main">
                  <div class="name">${escapeHtml(tStore(r.storeName))}</div>
                  <div class="sub">${escapeHtml(r.city || '—')} · ${fmt(r.memberCount)} ${escapeHtml(t('reports.stores.members'))}</div>
                </div>
                <div class="rep-row-kv">
                  <div class="rep-row-v mono">${fmt(r.earn30)}</div>
                  <div class="rep-row-k">${escapeHtml(t('reports.stores.earn30'))}</div>
                </div>
                <div class="rep-row-kv">
                  <div class="rep-row-v mono">${peso(r.spendTotal)}</div>
                  <div class="rep-row-k">${escapeHtml(t('reports.stores.spendTotal'))}</div>
                </div>
              </div>
            `).join('')}
          </div>` : `
          <div class="tbl-wrap tbl-wrap-fit" style="overflow-x:auto;">
            <div class="tbl-head" style="grid-template-columns: 1.4fr 90px 120px 130px 130px;">
              <div>${t('members.colStore')}</div>
              <div class="mono">${t('reports.stores.members')}</div>
              <div class="mono">${t('reports.stores.earn30')}</div>
              <div class="mono">${t('reports.stores.spendTotal')}</div>
              <div class="mono">${t('reports.stores.pointsTotal')}</div>
            </div>
            ${data.storeRanking.map(r => `
              <div class="tbl-row" style="grid-template-columns: 1.4fr 90px 120px 130px 130px;">
                <div class="tbl-cell"><div class="stack"><div class="name">${escapeHtml(tStore(r.storeName))}</div><div class="sub">${escapeHtml(r.city || '—')}</div></div></div>
                <div class="tbl-cell mono">${fmt(r.memberCount)}</div>
                <div class="tbl-cell mono">${fmt(r.earn30)}</div>
                <div class="tbl-cell mono">${peso(r.spendTotal)}</div>
                <div class="tbl-cell mono">${fmt(r.pointsTotal)}</div>
              </div>
            `).join('')}
          </div>`)}
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${t('reports.sleep.title')}</div>
            <div class="card-subtitle">${escapeHtml(t('reports.sleep.sub', { d: data.thresholds.sleepDays, rd: 30 }))}</div>
          </div>
          <div class="spacer"></div>
          <span class="pill pill-frozen">${fmt(data.sleepCount)}</span>
        </div>
        ${data.sleepList.length === 0 ? `<div class="card-empty">${t('reports.sleep.empty')}</div>` : `
          <div class="sleep-list">
            ${data.sleepList.slice(0, 8).map(m => `
              <div class="sleep-row">
                <div class="avatar sm">${initials(m.name)}</div>
                <div class="stack" style="min-width:0;flex:1;">
                  <div class="name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.name)}</div>
                  <div class="sub">${escapeHtml(memberStoreName(m))} · ${escapeHtml(levelMeta(m.level).label)}</div>
                </div>
                <div class="sleep-pts mono">${fmt(m.points)}</div>
                <div class="sleep-age">${m.kind === 'register' ? t('reports.sleep.regDays', { d: m.lastPurchaseDays }) : t('reports.sleep.lastDays', { d: m.lastPurchaseDays })}</div>
              </div>
            `).join('')}
          </div>`}
      </div>
    </div>

    <div class="row-2">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${t('reports.top.title')}</div>
            <div class="card-subtitle">${t('reports.top.sub')}</div>
          </div>
        </div>
        ${data.topSpenders.length === 0 ? `<div class="card-empty">${t('reports.top.empty')}</div>` : (isMobile() ? `
          <div class="rep-list">
            ${data.topSpenders.map((m, i) => {
              const tm = typeMeta(m.type);
              return `<div class="rep-row">
                <div class="rep-rank mono">${i + 1}</div>
                <div class="avatar sm">${initials(m.name)}</div>
                <div class="rep-row-main">
                  <div class="name">${escapeHtml(m.name)}</div>
                  <div class="sub">${escapeHtml(m.phone || '')} · <span class="pill ${tm.cls}">${tm.label}</span></div>
                </div>
                <div class="rep-row-kv">
                  <div class="rep-row-v mono">${peso(m.spend)}</div>
                  <div class="rep-row-k">${escapeHtml(t('reports.top.spend'))}</div>
                </div>
              </div>`;
            }).join('')}
          </div>` : `
          <div class="tbl-wrap tbl-wrap-fit" style="overflow-x:auto;">
            <div class="tbl-head" style="grid-template-columns: 36px 1.4fr 90px 110px 110px;">
              <div>#</div><div>${t('members.colMember')}</div>
              <div class="mono">${t('reports.top.spend')}</div>
              <div class="mono">${t('reports.top.points')}</div>
              <div>${t('members.colType')}</div>
            </div>
            ${data.topSpenders.map((m, i) => {
              const tm = typeMeta(m.type);
              return `<div class="tbl-row" style="grid-template-columns: 36px 1.4fr 90px 110px 110px;">
                <div class="tbl-cell mono" style="color:#9AA8A2;">${i + 1}</div>
                <div class="tbl-cell member"><div class="avatar">${initials(m.name)}</div><div class="stack"><div class="name">${escapeHtml(m.name)}</div><div class="sub mono">${escapeHtml(m.phone)}</div></div></div>
                <div class="tbl-cell mono">${peso(m.spend)}</div>
                <div class="tbl-cell mono">${fmt(m.points)}</div>
                <div class="tbl-cell"><span class="pill ${tm.cls}">${tm.label}</span></div>
              </div>`;
            }).join('')}
          </div>`)}
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${t('reports.expire.title')}</div>
            <div class="card-subtitle">${escapeHtml(t('reports.expire.sub', { d: data.thresholds.soonDays }))}</div>
          </div>
          <div class="spacer"></div>
          <span class="pill pill-frozen">${fmt(data.expiringSoonCount)}</span>
        </div>
        ${data.expiringSoon.length === 0 ? `<div class="card-empty">${escapeHtml(t('reports.expire.empty', { d: data.thresholds.soonDays }))}</div>` : `
          <div class="sleep-list">
            ${data.expiringSoon.slice(0, 8).map(m => `
              <div class="sleep-row">
                <div class="avatar sm" style="background:var(--warn-bg);color:var(--warn-ink);">${initials(m.name)}</div>
                <div class="stack" style="min-width:0;flex:1;">
                  <div class="name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.name)}</div>
                  <div class="sub mono">${escapeHtml(m.phone || '')}</div>
                </div>
                <div class="sleep-pts mono">${fmt(m.points)}</div>
                <div class="sleep-age" style="color:var(--danger-ink);font-weight:600;">${t('reports.expire.daysLeft', { d: m.daysLeft })}</div>
              </div>
            `).join('')}
            <div style="padding:10px 14px;color:#9AA8A2;font-size:12px;border-top:1px solid #EFF3F1;">${t('reports.expire.call')}</div>
          </div>`}
      </div>
    </div>

    <div class="row-2">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${t('reports.level.title')}</div>
            <div class="card-subtitle">${t('reports.level.sub')}</div>
          </div>
        </div>
        ${renderDistBars(data.levelDist, t, 'level')}
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${t('reports.type.title')}</div>
            <div class="card-subtitle">${t('reports.type.sub')}</div>
          </div>
        </div>
        ${renderDistBars(data.typeDist, t, 'type')}
      </div>
    </div>
  `;
  $('#btnReportsRefresh')?.addEventListener('click', () => renderScreen());
}

// =================== 门店经营 / 会员经营（复用 report.view + /api/reports/overview） ===================

// —— 以下三个渲染片段与「经营报表」共用同一套模板，集中在此避免重复 ——
function reportsStoreRankingHtml(data) {
  if (data.storeRanking.length === 0) return `<div class="card-empty">${t('reports.stores.empty')}</div>`;
  if (isMobile()) {
    return `<div class="rep-list">${data.storeRanking.map(r => `
      <div class="rep-row">
        <div class="rep-row-main">
          <div class="name">${escapeHtml(tStore(r.storeName))}</div>
          <div class="sub">${escapeHtml(r.city || '—')} · ${fmt(r.memberCount)} ${escapeHtml(t('reports.stores.members'))}</div>
        </div>
        <div class="rep-row-kv">
          <div class="rep-row-v mono">${fmt(r.earn30)}</div>
          <div class="rep-row-k">${escapeHtml(t('reports.stores.earn30'))}</div>
        </div>
        <div class="rep-row-kv">
          <div class="rep-row-v mono">${peso(r.spendTotal)}</div>
          <div class="rep-row-k">${escapeHtml(t('reports.stores.spendTotal'))}</div>
        </div>
      </div>`).join('')}</div>`;
  }
  return `<div class="tbl-wrap tbl-wrap-fit" style="overflow-x:auto;">
    <div class="tbl-head" style="grid-template-columns: 1.4fr 90px 120px 130px 130px;">
      <div>${t('members.colStore')}</div>
      <div class="mono">${t('reports.stores.members')}</div>
      <div class="mono">${t('reports.stores.earn30')}</div>
      <div class="mono">${t('reports.stores.spendTotal')}</div>
      <div class="mono">${t('reports.stores.pointsTotal')}</div>
    </div>
    ${data.storeRanking.map(r => `
      <div class="tbl-row" style="grid-template-columns: 1.4fr 90px 120px 130px 130px;">
        <div class="tbl-cell"><div class="stack"><div class="name">${escapeHtml(tStore(r.storeName))}</div><div class="sub">${escapeHtml(r.city || '—')}</div></div></div>
        <div class="tbl-cell mono">${fmt(r.memberCount)}</div>
        <div class="tbl-cell mono">${fmt(r.earn30)}</div>
        <div class="tbl-cell mono">${peso(r.spendTotal)}</div>
        <div class="tbl-cell mono">${fmt(r.pointsTotal)}</div>
      </div>`).join('')}
  </div>`;
}

function reportsSleepListHtml(list) {
  if (list.length === 0) return `<div class="card-empty">${t('reports.sleep.empty')}</div>`;
  return `<div class="sleep-list">${list.slice(0, 8).map(m => `
    <div class="sleep-row">
      <div class="avatar sm">${initials(m.name)}</div>
      <div class="stack" style="min-width:0;flex:1;">
        <div class="name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.name)}</div>
        <div class="sub">${escapeHtml(memberStoreName(m))} · ${escapeHtml(levelMeta(m.level).label)}</div>
      </div>
      <div class="sleep-pts mono">${fmt(m.points)}</div>
      <div class="sleep-age">${m.kind === 'register' ? t('reports.sleep.regDays', { d: m.lastPurchaseDays }) : t('reports.sleep.lastDays', { d: m.lastPurchaseDays })}</div>
    </div>`).join('')}</div>`;
}

function reportsTopSpendersHtml(list) {
  if (list.length === 0) return `<div class="card-empty">${t('reports.top.empty')}</div>`;
  if (isMobile()) {
    return `<div class="rep-list">${list.map((m, i) => {
      const tm = typeMeta(m.type);
      return `<div class="rep-row">
        <div class="rep-rank mono">${i + 1}</div>
        <div class="avatar sm">${initials(m.name)}</div>
        <div class="rep-row-main">
          <div class="name">${escapeHtml(m.name)}</div>
          <div class="sub">${escapeHtml(m.phone || '')} · <span class="pill ${tm.cls}">${tm.label}</span></div>
        </div>
        <div class="rep-row-kv">
          <div class="rep-row-v mono">${peso(m.spend)}</div>
          <div class="rep-row-k">${escapeHtml(t('reports.top.spend'))}</div>
        </div>
      </div>`;
    }).join('')}</div>`;
  }
  return `<div class="tbl-wrap tbl-wrap-fit" style="overflow-x:auto;">
    <div class="tbl-head" style="grid-template-columns: 36px 1.4fr 90px 110px 110px;">
      <div>#</div><div>${t('members.colMember')}</div>
      <div class="mono">${t('reports.top.spend')}</div>
      <div class="mono">${t('reports.top.points')}</div>
      <div>${t('members.colType')}</div>
    </div>
    ${list.map((m, i) => {
      const tm = typeMeta(m.type);
      return `<div class="tbl-row" style="grid-template-columns: 36px 1.4fr 90px 110px 110px;">
        <div class="tbl-cell mono" style="color:#9AA8A2;">${i + 1}</div>
        <div class="tbl-cell member"><div class="avatar">${initials(m.name)}</div><div class="stack"><div class="name">${escapeHtml(m.name)}</div><div class="sub mono">${escapeHtml(m.phone)}</div></div></div>
        <div class="tbl-cell mono">${peso(m.spend)}</div>
        <div class="tbl-cell mono">${fmt(m.points)}</div>
        <div class="tbl-cell"><span class="pill ${tm.cls}">${tm.label}</span></div>
      </div>`;
    }).join('')}
  </div>`;
}

async function renderStoreBiz(root) {
  const data = await GET('/api/reports/overview');
  const s = data.summary;
  const narrow = !isWideScope('report.view');
  const storeName = narrow ? tStore(state.stores.find(x => x.id === state.me.storeId)?.name || '') : '';
  const tsShort = (data.generatedAt || '').slice(0, 16).replace('T', ' ');
  const subTitle = narrow
    ? t('reports.subtitleStore', { store: storeName, ts: tsShort })
    : t('reports.subtitleAll', { n: data.storeRanking.length, ts: tsShort });
  const totalSpend = data.storeRanking.reduce((sum, r) => sum + (r.spendTotal || 0), 0);
  root.innerHTML = `
    <div class="page-header">
      <div class="page-header-text">
        <div class="page-title">${t('biz.store.title')}</div>
        <div class="page-subtitle">${escapeHtml(subTitle)}</div>
      </div>
      <div class="page-spacer"></div>
    </div>
    <div class="kpi-row kpi-row-3">
      <div class="card kpi-card">
        <div class="kpi-label">${t('biz.store.kpiStores')}</div>
        <div class="kpi-value mono">${fmt(data.storeRanking.length)}</div>
        <div class="kpi-delta-sub">${narrow ? storeName : t('dash.allStores')}</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">${t('biz.store.kpiMembers')}</div>
        <div class="kpi-value mono">${fmt(s.membersTotal)}</div>
        <div class="kpi-delta-sub">${escapeHtml(t('reports.frozenOnly.sub', { frozen: fmt(s.membersFrozen) }))}</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">${t('biz.store.kpiSpend')}</div>
        <div class="kpi-value mono">${peso(totalSpend)}</div>
        <div class="kpi-delta-sub">${t('reports.stores.spendTotal')}</div>
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">${t('reports.stores.title')}</div>
          <div class="card-subtitle">${t('reports.stores.sub')}</div>
        </div>
      </div>
      ${reportsStoreRankingHtml(data)}
    </div>
    <div class="card">
      <div class="card-title">${t('biz.store.note')}</div>
    </div>
  `;
}

async function renderMemberBiz(root) {
  const data = await GET('/api/reports/overview');
  const s = data.summary;
  const narrow = !isWideScope('report.view');
  const storeName = narrow ? tStore(state.stores.find(x => x.id === state.me.storeId)?.name || '') : '';
  const tsShort = (data.generatedAt || '').slice(0, 16).replace('T', ' ');
  const subTitle = narrow
    ? t('reports.subtitleStore', { store: storeName, ts: tsShort })
    : t('reports.subtitleAll', { n: data.storeRanking.length, ts: tsShort });
  root.innerHTML = `
    <div class="page-header">
      <div class="page-header-text">
        <div class="page-title">${t('biz.member.title')}</div>
        <div class="page-subtitle">${escapeHtml(subTitle)}</div>
      </div>
      <div class="page-spacer"></div>
    </div>
    <div class="kpi-row kpi-row-3">
      <div class="card kpi-card">
        <div class="kpi-label">${t('biz.member.kpiTotal')}</div>
        <div class="kpi-value mono">${fmt(s.membersTotal)}</div>
        <div class="kpi-delta-sub">${escapeHtml(t('reports.frozenOnly.sub', { frozen: fmt(s.membersFrozen) }))}</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">${t('biz.member.kpiSleep')}</div>
        <div class="kpi-value mono">${fmt(data.sleepCount)}</div>
        <div class="kpi-delta-sub">${t('reports.sleep.title')}</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">${t('biz.member.kpiTop')}</div>
        <div class="kpi-value mono">${fmt(data.topSpenders.length)}</div>
        <div class="kpi-delta-sub">${t('reports.top.title')}</div>
      </div>
    </div>
    <div class="row-2">
      <div class="card">
        <div class="card-header"><div><div class="card-title">${t('biz.member.levelTitle')}</div><div class="card-subtitle">${t('reports.level.sub')}</div></div></div>
        ${renderDistBars(data.levelDist, t, 'level')}
      </div>
      <div class="card">
        <div class="card-header"><div><div class="card-title">${t('biz.member.typeTitle')}</div><div class="card-subtitle">${t('reports.type.sub')}</div></div></div>
        ${renderDistBars(data.typeDist, t, 'type')}
      </div>
    </div>
    <div class="row-2">
      <div class="card">
        <div class="card-header"><div><div class="card-title">${t('biz.member.sleepTitle')}</div><div class="card-subtitle">${escapeHtml(t('reports.sleep.sub', { d: data.thresholds.sleepDays, rd: 30 }))}</div></div><div class="spacer"></div><span class="pill pill-frozen">${fmt(data.sleepCount)}</span></div>
        ${reportsSleepListHtml(data.sleepList)}
      </div>
      <div class="card">
        <div class="card-header"><div><div class="card-title">${t('biz.member.topTitle')}</div><div class="card-subtitle">${t('reports.top.sub')}</div></div></div>
        ${reportsTopSpendersHtml(data.topSpenders)}
      </div>
    </div>
  `;
}

// 把 levelDist / typeDist 渲染成横向条形图（不带外部依赖）
function renderDistBars(dist, tFn, kind) {
  const total = Object.values(dist).reduce((s, n) => s + n, 0);
  if (total === 0) return `<div class="card-empty">—</div>`;
  const colors = kind === 'level'
    ? { silver: '#9CA3AF', gold: '#F4B740', platinum: '#16A34A', partner: '#22C55E', bronze: '#B45309' }
    : { retail: '#9CA3AF', b2b: '#16A34A' };
  // 已知 key 排序，未知 key 按字母
  const entries = Object.entries(dist).sort((a, b) => {
    const order = kind === 'level' ? ['silver', 'gold', 'platinum', 'partner', 'bronze'] : ['retail', 'b2b'];
    const ai = order.indexOf(a[0]); const bi = order.indexOf(b[0]);
    if (ai === -1 && bi === -1) return a[0].localeCompare(b[0]);
    if (ai === -1) return 1; if (bi === -1) return -1;
    return ai - bi;
  });
  const max = Math.max(...Object.values(dist));
  return `<div class="dist-list">
    ${entries.map(([k, n]) => {
      const pct = Math.round(n / total * 100);
      const barPct = max ? Math.round(n / max * 100) : 0;
      const labelKey = kind === 'level' ? `level.${k}` : `type.${k}`;
      return `<div class="dist-row">
        <div class="dist-label">${escapeHtml(tFn(labelKey)) || k} <span class="mono" style="color:#718078;">(${n}, ${pct}%)</span></div>
        <div class="dist-bar"><div class="dist-fill" style="width:${barPct}%;background:${colors[k] || '#718078'};"></div></div>
      </div>`;
    }).join('')}
  </div>`;
}

// 6 个月趋势图：柱（消费）+ 双折线（发放/核销）
function renderReportsTrendSvg(buckets) {
  // 这张图始终落在窄列里（桌面是 380px 的卡片、手机是整宽），viewBox 不能按整页宽度给，
  // 否则等比缩放到卡片宽度后坐标轴字会被压到读不出来。桌机/手机统一用一个窄 viewBox。
  const W = 360, H = 180;
  const PAD_L = 34, PAD_R = 12, PAD_T = 18, PAD_B = 32;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const n = buckets.length;
  const colGap = 8;
  const colW = (plotW - colGap * (n - 1)) / n;
  const maxSpend = Math.max(...buckets.map(b => b.spend), 1);
  const maxPts = Math.max(...buckets.map(b => Math.max(b.earn, b.redeem)), 1);
  // y 轴 3 等分；刻度值压缩成 250k / 1.2M，窄列里才放得下
  const yTicks = 3;
  const fmtAxis = (v) => (v >= 1000000
    ? (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
    : v >= 1000 ? Math.round(v / 1000) + 'k' : String(v));
  const grid = Array.from({ length: yTicks + 1 }, (_, i) => {
    const y = PAD_T + plotH - (i / yTicks) * plotH;
    const val = Math.round((i / yTicks) * maxSpend);
    return { y, val };
  });
  const xFor = (i) => PAD_L + i * (colW + colGap);
  const yForPts = (v) => PAD_T + plotH - (v / maxPts) * plotH * 0.85;   // 折线占 85% 高度，给顶部留白
  const yForBar = (v) => PAD_T + plotH - (v / maxSpend) * plotH;
  // 折线 polyline
  const earnPoints = buckets.map((b, i) => `${xFor(i) + colW / 2},${yForPts(b.earn)}`).join(' ');
  const redeemPoints = buckets.map((b, i) => `${xFor(i) + colW / 2},${yForPts(b.redeem)}`).join(' ');
  const hasData = buckets.some(b => (b.earn || 0) + (b.redeem || 0) + (b.spend || 0) > 0);
  const labelKey = (key) => {
    const [y, m] = key.split('-');
    return `${m}/${y.slice(2)}`;
  };
  return `
    <svg class="trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      ${grid.map(g => `<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${g.y}" y2="${g.y}" stroke="#EFF3F1" stroke-width="1"/>${hasData ? `<text x="${PAD_L - 6}" y="${g.y + 3}" text-anchor="end" font-size="10" fill="#9AA8A2" font-family="ui-monospace">${fmtAxis(g.val)}</text>` : ''}`).join('')}
      ${!hasData ? '' : buckets.map((b, i) => {
        const h = Math.max(0, (b.spend / maxSpend) * plotH);
        const y = PAD_T + plotH - h;
        return `<rect x="${xFor(i)}" y="${y}" width="${colW}" height="${h}" fill="#9AA8A2" opacity="0.20" rx="3"/><rect x="${xFor(i)}" y="${y}" width="${colW}" height="${Math.min(3, h)}" fill="#9AA8A2" opacity="0.45" rx="2"/>`;
      }).join('')}
      ${hasData ? `<polyline points="${earnPoints}" fill="none" stroke="#16A34A" stroke-width="2"/><polyline points="${redeemPoints}" fill="none" stroke="#F59E0B" stroke-width="2"/>` : ''}
      ${buckets.map((b, i) => `<text x="${xFor(i) + colW / 2}" y="${H - PAD_B + 14}" text-anchor="middle" font-size="10" fill="#9AA8A2" font-family="ui-monospace">${labelKey(b.key)}</text>`).join('')}
      ${hasData ? buckets.map((b, i) => `<circle cx="${xFor(i) + colW / 2}" cy="${yForPts(b.earn)}" r="3" fill="#16A34A"/><circle cx="${xFor(i) + colW / 2}" cy="${yForPts(b.redeem)}" r="3" fill="#F59E0B"/>`).join('') : ''}
      ${hasData ? '' : `<text x="${PAD_L + plotW / 2}" y="${PAD_T + plotH / 2}" text-anchor="middle" font-size="12" fill="#9AA8A2" font-family="Inter, sans-serif">${t('reports.trend.empty')}</text>`}
    </svg>
    <div class="trend-legend">
      <span><span class="legend-dot" style="background:#16A34A;"></span>${t('reports.trend.earn')}</span>
      <span><span class="legend-dot" style="background:#F59E0B;"></span>${t('reports.trend.redeem')}</span>
      <span><span class="legend-dot" style="background:#9AA8A2;"></span>${t('reports.trend.spend')}</span>
    </div>
  `;
}

// =================== Start ===================
bootstrap();
