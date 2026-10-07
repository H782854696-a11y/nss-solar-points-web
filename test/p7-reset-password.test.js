// ============================================================
// P7 针对性测试：管理员重置密码（POST /api/users/:id/reset-password）
// ============================================================
// 背景：密码是 bcrypt 单向哈希，旧的**查不到**，只能重置（用户 2026-09-24 授权新增）。
// 覆盖：
//   · 鉴权 401 / 403（含数据范围）
//   · 404 / 新密码缺失 / 新密码 < 6 位 → 400
//   · 不能在这里重置自己的密码 → 400（自己走「账号设置」）
//   · 成功重置：新密码能登录、**旧密码失效**、目标账号旧会话被作废、
//     dataVersion 变化、审计留痕、**响应体里绝不出现密码或哈希**
//   · ★ 只改 password 和首次登录强制改密标记（其它字段逐字节不变）
//   · ★ `GET /api/users` 仍然剔除 password（回归）
//   · 前端静态：按钮门禁、只走这个接口、输入是 type=password、有一次性展示、i18n key 齐全
//
// 全部走 SP_DATA_DIR 沙箱；绝不触碰真实 data/。
// ============================================================
process.env.PORT = '3194';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-p7-'));
process.env.SP_DATA_DIR = SANDBOX;

const APP = path.join(__dirname, '..');
const store = require(APP + '/lib/store');
const rbac = require(APP + '/lib/rbac');
const bcrypt = require(APP + '/node_modules/bcryptjs');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const PW = 'Test#12345';
const NEW_PW = 'Reset#Pass2026!';

const PROD_ROLES = Object.keys(rbac.ROLE_GRANTS);
const prodMatrixSnapshot = JSON.stringify(rbac.ROLE_GRANTS);
const PERM_COUNT = rbac.PERMISSIONS.length;

const ROLE_STORE = '__probe_p7_store_user_edit__';
rbac.ROLE_GRANTS[ROLE_STORE] = [{ p: 'system.user.view', s: 'store' }, { p: 'system.user.edit', s: 'store' }];

const REAL_LOG = path.join(APP, 'data', 'audit.log');
const realStat = () => { try { return { md5: md5(fs.readFileSync(REAL_LOG, 'utf8')), size: fs.statSync(REAL_LOG).size }; } catch (e) { return { md5: null, size: -1 }; } };
const realBefore = realStat();
const SANDBOX_LOG = path.join(SANDBOX, 'audit.log');
const auditText = () => { try { return fs.readFileSync(SANDBOX_LOG, 'utf8'); } catch (e) { return ''; } };

const COLLS = ['users', 'stores', 'members', 'transactions', 'pending', 'products', 'redemptions', 'rules'];
const fp = (c) => {
  const rows = store.readCollection(c) || [];
  const arr = Array.isArray(rows) ? rows : [rows];
  return md5(arr.map(x => JSON.stringify(x)).join('\n'));
};
const dv = () => store.dataVersion();
const usersNow = () => store.readCollection('users') || [];
const userById = (id) => usersNow().find(x => x.id === id);
/** 去掉允许改变的密码与强制改密字段，检查其它账号资料不变。 */
const shapeOf = (u) => { const { password, mustChangePassword, ...rest } = u; return JSON.stringify(rest); };

function seed() {
  store.writeCollection('stores', [
    { id: 'S1', name: '一号店', regionId: 'R-A', city: '', address: '', managerId: 'U-mgr1', managerName: '一号店长', phone: '', createdAt: now() },
    { id: 'S2', name: '二号店', regionId: 'R-B', city: '', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
  ]);
  const mk = (id, username, name, role, extra) => Object.assign({
    id, username, password: bcrypt.hashSync(PW, 10), name, role,
    storeId: null, phone: '', createdAt: now(), disabled: false,
  }, extra || {});
  store.writeCollection('users', [
    mk('U-admin', 't_admin', '总部管理员', 'admin'),
    mk('U-mgr1', 't_mgr1', '一号店长', 'manager', { storeId: 'S1' }),
    mk('U-hq', 't_hq', '总部运营', 'hq_operator'),
    mk('U-victim', 't_victim', '被重置的店长', 'manager'),
    mk('U-smprobe', 't_smprobe', '探针门店', ROLE_STORE, { storeId: 'S1' }),
  ]);
  store.writeCollection('members', []);
  store.writeCollection('transactions', []);
  store.writeCollection('pending', []);
  store.writeCollection('products', []);
  store.writeCollection('redemptions', []);
  store.writeCollection('rules', {
    id: 'single', spendPerPoint: 10, expiryMonths: 24, welcomeBonus: 0,
    redeemRatio: '10:1', redeemMaxPercent: 0, redeemMinPoints: 0,
    requireConfirm: false, realtimePush: false,
    levels: [{ key: 'silver', name: 'Silver', threshold: 0, color: '#9CA3AF' }],
    b2bTiers: [], updatedAt: now(), schemaVersion: 4,
  });
  store.writeCollection('sheets', { id: 'single', autoSync: false, syncCount: 0, scriptUrl: null });
  store.writeCollection('expiry-state', { lastRunAt: now(), expiryMonths: 24, expiredMembers: 0, expiredPoints: 0, dryRun: false, nextRunAt: now(), note: '' });
  store.writeCollection('_seeded', { id: 'singleton', at: now() });
}
seed();
require(APP + '/server.js');

const B = 'http://127.0.0.1:3194';

const cookies = {};
async function loginAs(username, password) {
  const r = await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: password || PW }),
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (r.status === 200) cookies[username] = sc.map(c => c.split(';')[0]).join('; ');
  return r.status;
}
async function as(username, method, p, body) {
  const opts = { method, headers: { cookie: cookies[username] || '' } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(B + p, opts);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, data: j };
}
const anon = async (method, p, body) => {
  const opts = { method };
  if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const r = await fetch(B + p, opts);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, data: j };
};
const reset = (who, id, newPassword) => as(who, 'POST', '/api/users/' + id + '/reset-password', { newPassword });

(async () => {
  await sleep(800);
  console.log('\n══════ P7 管理员重置密码 针对性测试 ══════\n');

  await loginAs('t_admin');
  await loginAs('t_hq');
  await loginAs('t_mgr1');
  await loginAs('t_victim');     // 受害者账号先登录，稍后验证它的会话被作废
  const victimOldCookie = cookies['t_victim'];   // ★ 必须先留一份：后面 loginAs 会覆盖这个 cookie
  await loginAs('t_smprobe');

  console.log('【0】前置');
  ok('沙箱账号 5 个', usersNow().length === 5, usersNow().length);
  ok('受害者账号可用旧密码登录 → 200', (await loginAs('t_victim')) === 200);
  ok('生产矩阵 9 个角色定义未被本测试改动',
    PROD_ROLES.every(r => JSON.stringify(rbac.ROLE_GRANTS[r]) === JSON.stringify(JSON.parse(prodMatrixSnapshot)[r])));

  // ─────────────────────────────────────────
  console.log('\n【A】鉴权与范围');
  ok('未登录 → 401', (await anon('POST', '/api/users/U-victim/reset-password', { newPassword: NEW_PW })).status === 401);
  const hq = await reset('t_hq', 'U-victim', NEW_PW);
  ok('hq_operator（无 system.user.edit）→ 403', hq.status === 403, hq.status);
  ok('403 响应体不泄露账号数据', JSON.stringify(hq.data).indexOf('t_victim') === -1, hq.data);
  ok('store_manager 执行者 → 403', (await reset('t_mgr1', 'U-victim', NEW_PW)).status === 403);
  ok('★ 无权限者无法通过 id 探测账号是否存在（一律 403）',
    (await reset('t_hq', 'U-does-not-exist', NEW_PW)).status === 403);
  ok('★ 门店范围持有者重置「别店」账号 → 403（范围门生效）',
    (await reset('t_smprobe', 'U-victim', NEW_PW)).status === 403);
  ok('账号不存在（有权限者）→ 404', (await reset('t_admin', 'U-nope', NEW_PW)).status === 404);

  // ─────────────────────────────────────────
  console.log('\n【B】入参校验与自我护栏（一律 400，且零写入）');
  const dv0 = dv();
  const before = JSON.stringify(userById('U-victim'));
  ok('缺 newPassword → 400', (await as('t_admin', 'POST', '/api/users/U-victim/reset-password', {})).status === 400);
  ok('newPassword 非字符串 → 400', (await as('t_admin', 'POST', '/api/users/U-victim/reset-password', { newPassword: 123456 })).status === 400);
  const short = await reset('t_admin', 'U-victim', '12345');
  ok('新密码 5 位 → 400', short.status === 400, short.status);
  ok('文案是「新密码至少 6 位」', short.data.error === '新密码至少 6 位', short.data);
  const self = await reset('t_admin', 'U-admin', NEW_PW);
  ok('重置自己 → 400', self.status === 400, self.status);
  ok('文案引导用「账号设置」', /账号设置/.test(self.data.error), self.data);
  ok('★ 被拒后：账号密码未变、dataVersion 未变',
    JSON.stringify(userById('U-victim')) === before && dv() === dv0, { dv: dv() });
  ok('★ 被拒后按旧密码仍能登录', (await loginAs('t_victim')) === 200);

  // ─────────────────────────────────────────
  console.log('\n【C】成功重置');
  const dvBefore = dv();
  const shapeBefore = shapeOf(userById('U-victim'));
  const fpBefore = Object.fromEntries(COLLS.map(c => [c, fp(c)]));
  const hashBefore = userById('U-victim').password;

  const r = await reset('t_admin', 'U-victim', NEW_PW);
  ok('重置成功 → 200', r.status === 200, { status: r.status, data: r.data });
  ok('返回体 { ok:true, id, sessionsInvalidated }',
    r.data.ok === true && r.data.id === 'U-victim' && typeof r.data.sessionsInvalidated === 'number', r.data);
  ok('★ 响应体里绝不出现密码、也不出现任何 bcrypt 哈希（$2a$/$2b$）',
    JSON.stringify(r.data).indexOf(NEW_PW) === -1 && !/\$2[aby]\$/.test(JSON.stringify(r.data)), r.data);
  ok('★ 库里的 password 已变（是新的 bcrypt 哈希）',
    userById('U-victim').password !== hashBefore && /^\$2[aby]\$/.test(userById('U-victim').password));
  ok('★ 新哈希能校验新密码、校验不了旧密码',
    bcrypt.compareSync(NEW_PW, userById('U-victim').password) &&
    !bcrypt.compareSync(PW, userById('U-victim').password));
  ok('★ 只改了 password 与强制改密标记：其余字段逐字节未变', shapeOf(userById('U-victim')) === shapeBefore);
  ok('★ 重置后首次登录必须改密', userById('U-victim').mustChangePassword === true);
  ok('★ dataVersion 发生变化', dv() !== dvBefore, { before: dvBefore, after: dv() });
  ok('★ 审计行已写入（且不含密码）',
    new RegExp('reset-password: t_victim \\(manager\\) by t_admin').test(auditText()) &&
    auditText().indexOf(NEW_PW) === -1);
  ok('★ 其它集合指纹全未变', COLLS.filter(c => c !== 'users').every(c => fp(c) === fpBefore[c]));

  console.log('\n【C-2】登录与会话行为');
  ok('★ 新密码可以登录 → 200', (await loginAs('t_victim', NEW_PW)) === 200);
  ok('★ 新会话在改密前不能访问业务接口', (await as('t_victim', 'GET', '/api/users')).status === 401);
  ok('★ 旧密码已失效 → 401', (await loginAs('t_victim', PW)) === 401);
  ok('★ 重置前拿到的旧会话已被作废 → 401（无需等 TTL）', (await (async () => {
    // ⚠ 必须用「重置之前」那一份 cookie 去试：loginAs 会覆盖 cookies 变量，
    //   若直接用 as('t_victim', …) 拿到的其实是新会话，会假绿。
    const r = await fetch(B + '/api/auth/me', { headers: { cookie: victimOldCookie } });
    return { status: r.status };
  })()).status === 401);
  ok('管理员自己的会话不受影响 → 200', (await as('t_admin', 'GET', '/api/users')).status === 200);

  console.log('\n【C-3】读接口不泄露哈希（回归）');
  const list = await as('t_admin', 'GET', '/api/users');
  ok('GET /api/users 返回成功', list.status === 200);
  ok('★ 列表里没有任何 password 字段', (list.data.items || []).every(x => x.password === undefined));
  ok('★ 列表整体不含 bcrypt 哈希', !/\$2[aby]\$/.test(JSON.stringify(list.data)));

  // ─────────────────────────────────────────
  console.log('\n【D】护栏语义（代码级断言）');
  const SRV = fs.readFileSync(APP + '/server.js', 'utf8');
  const epBody = (() => {
    const i = SRV.indexOf("app.post('/api/users/:id/reset-password'");
    if (i < 0) return '';
    const rest = SRV.slice(i);
    const m = rest.slice(1).search(/\napp\.(get|post|put|delete|patch)\(/);
    return m < 0 ? rest : rest.slice(0, m + 1);
  })();
  const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('接口已定义', epBody.length > 0);
  ok('权限门用既有 system.user.edit（不新增权限）', /checkPerm\(req, res, 'system\.user\.edit'\)/.test(epBody));
  ok('范围门对目标资源判定', /check\(req, res, 'system\.user\.edit', target\)/.test(epBody));
  ok('禁止重置自己（自我护栏）', /reset-password rejected \(self\)/.test(epBody));
  ok('长度校验 ≥ 6', /newPassword\.length < 6/.test(epBody));
  ok('用 bcrypt 12 轮写入新哈希', /bcrypt\.hashSync\(newPassword, 12\)/.test(epBody));
  ok('重置后作废该账号全部旧会话', /sessions\.delete\(sid\)/.test(epBody));
  ok('写入走 writeAll(\'users\')、并写审计', /writeAll\('users', users\)/.test(epBody) && /auditLog\(`reset-password: /.test(epBody));
  ok('★ 响应体不含 password / password_hash 字段',
    !/res\.json\([^)]*password/i.test(noComments(epBody)), noComments(epBody).match(/res\.json\([^)]*\)/));

  // ─────────────────────────────────────────
  console.log('\n【E】前端静态断言');
  const APPJS = fs.readFileSync(path.join(APP, 'public', 'app.js'), 'utf8');
  const IDX = fs.readFileSync(path.join(APP, 'public', 'index.html'), 'utf8');
  const I18N = fs.readFileSync(path.join(APP, 'public', 'i18n.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(APP, 'public', 'styles.css'), 'utf8');
  const fnBody = (name) => {
    const i = APPJS.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const rest = APPJS.slice(i);
    const m = rest.slice(1).search(/\nfunction |\nasync function /);
    return m < 0 ? rest : rest.slice(0, m + 1);
  };
  const accFn = fnBody('renderAccounts');
  const rpdFn = fnBody('resetPasswordDialog');
  const npdFn = fnBody('showNewPasswordDialog');
  ok('resetPasswordDialog / showNewPasswordDialog / suggestPassword 均已定义',
    rpdFn.length > 0 && npdFn.length > 0 && fnBody('suggestPassword').length > 0);
  ok('★ 按钮门禁：canResetPw ? 三元（自己那行不渲染）',
    /const canResetPw = canEdit && !isSelf;/.test(accFn) && /const btnResetPw = canResetPw \?/.test(accFn));
  ok('★ 重置密码只请求 /api/users/:id/reset-password，且只在这个函数里 POST',
    (rpdFn.match(/\/api\/users\//g) || []).length === 1 &&
    /reset-password/.test(rpdFn) &&
    !/POST\('\/api\/users\/.*reset-password/.test(accFn) && !/\bPOST\(/.test(npdFn));
  ok('★ 新密码输入框是 type="password"（不明文显示）', /type="password" id="rpNew"/.test(rpdFn));
  ok('★ 输入框带 minlength=6 与 autocomplete=new-password',
    /minlength="6"/.test(rpdFn) && /autocomplete="new-password"/.test(rpdFn));
  ok('★ 前端自己先校验 <6 位并提示（不靠后端兜底）',
    /pw\.length < 6/.test(rpdFn) && /accounts\.resetPwNeed6/.test(rpdFn));
  ok('★ 成功后走「一次性展示」弹窗', /showNewPasswordDialog\(account, pw\)/.test(rpdFn));
  ok('★ 一次性展示里有复制按钮与「不再显示」提醒',
    /accounts\.resetPwCopy/.test(npdFn) && /clipboard|execCommand\('copy'\)/.test(npdFn) && /accounts\.resetPwOnce/.test(npdFn));
  ok('★ 前端没有把新密码写进 localStorage / 日志', !/localStorage/.test(rpdFn + npdFn) && !/console\.log/.test(rpdFn + npdFn));
  ok('★ 事件分发里把 resetPw 路由到 resetPasswordDialog', /dataset\.act === 'resetPw'\)\s*resetPasswordDialog\(target\)/.test(accFn));
  ok('★ index.html 版本号已递增：app.js>=38、i18n.js>=18',
    Number((IDX.match(/app\.js\?v=(\d+)/) || [])[1]) >= 38 &&
    Number((IDX.match(/i18n\.js\?v=(\d+)/) || [])[1]) >= 18,
    { app: (IDX.match(/app\.js\?v=(\d+)/) || [])[1], i18n: (IDX.match(/i18n\.js\?v=(\d+)/) || [])[1] });
  ok('★ styles.css 使用版本化资源地址', Number((IDX.match(/styles\.css\?v=(\d+)/) || [])[1]) >= 26);

  const i18nKeys = new Set((I18N.match(/^\s*'([a-zA-Z][a-zA-Z0-9_.]*)':\s*\[/gm) || [])
    .map(s => s.trim().replace(/^'/, '').replace(/':\s*\[$/, '')));
  // ⚠ 提取 t('key') 要排除「前一字符是标识符」的情况：
  //   document.createElement('textarea') 里的 `t('textarea'` 会被裸正则误当成 t() 调用。
  // 用 matchAll 取捕获组（别用 .match + 手工 replace，否则会把边界字符带进 key）
  const usedKeys = Array.from(new Set(
    Array.from((accFn + rpdFn + npdFn).matchAll(/(?:^|[^A-Za-z0-9_$])t\('([a-zA-Z][a-zA-Z0-9_.]*)'/g)).map(m => m[1])
  ));
  const missingKeys = usedKeys.filter(k => !i18nKeys.has(k));
  ok('★ 用到的 ' + usedKeys.length + ' 个 i18n key 全部存在', missingKeys.length === 0, missingKeys);
  const needKeys = ['accounts.resetPw', 'accounts.resetPwTitle', 'accounts.resetPwBody', 'accounts.resetPwLabel',
    'accounts.resetPwGenerate', 'accounts.resetPwNeed6', 'accounts.resetPwDone', 'accounts.resetPwDoneBody',
    'accounts.resetPwCopy', 'accounts.resetPwCopied', 'accounts.resetPwOnce'];
  ok('★ 重置密码相关 ' + needKeys.length + ' 个 key 都已登记（中英双语）',
    needKeys.every(k => i18nKeys.has(k)), needKeys.filter(k => !i18nKeys.has(k)));

  const usedClasses = Array.from(new Set(
    ((accFn + rpdFn + npdFn).match(/class="([^"]*)"/g) || [])
      .flatMap(s => s.replace(/class="|"/g, '').split(/\s+/)).filter(Boolean)));
  const missingCss = usedClasses.filter(c => !(new RegExp('\\.' + c + '(?![\\w-])')).test(CSS));
  ok('★ 未新增 CSS 类名：用到的 ' + usedClasses.length + ' 个类名全在 styles.css 里',
    missingCss.length === 0, { used: usedClasses, missing: missingCss });
  const deps = ['state', 'GET', 'POST', 'DELETE', 'PUT', 'fmt', 'escapeHtml', 't', 'tMsg', 'locale', 'can',
    'isMobile', 'refreshStores', 'tStore', 'tName', 'roleLabel', 'confirmDialog', 'toast', 'renderScreen',
    'openModal', 'closeModal', '$', '$$', 'toast'];
  const i18nImport = (APPJS.match(/const \{([^}]*)\} = I18N;/) || [])[1] || '';
  const i18nProvided = new Set(i18nImport.split(',').map(s => s.trim()).filter(Boolean));
  // ⚠ 依赖名可能是 $ / $$ 这类符号：\b 在 $ 之后不成立，必须改用「后跟空白或 ( =」的判断
  const depRe = (d) => new RegExp('(function |const |let |var )' + d.replace(/\$/g, '\\$') + '(?=[\\s(=])');
  const missingDeps = deps.filter(d => !depRe(d).test(APPJS) && !i18nProvided.has(d));
  ok('依赖符号都已定义', missingDeps.length === 0, { missing: missingDeps });

  // ─────────────────────────────────────────
  console.log('\n【F】权限矩阵与真实日志');
  ok('★ 生产 9 个角色的 ROLE_GRANTS 与测试开始时逐字节一致',
    PROD_ROLES.every(r => JSON.stringify(rbac.ROLE_GRANTS[r]) === JSON.stringify(JSON.parse(prodMatrixSnapshot)[r])));
  ok('★ server.js 里作为权限参数出现的名字，全部是既有 ' + PERM_COUNT + ' 项之一', (() => {
    const args = Array.from(SRV.matchAll(/guard\.(?:checkPerm|check)\(req,\s*res,\s*'([^']+)'/g)).map(m => m[1]);
    const names = Array.from(new Set(args));
    return names.length > 0 && names.every(n => rbac.PERMISSIONS.indexOf(n) !== -1);
  })());
  const realAfter = realStat();
  ok('★ 真实 audit.log 逐字节未变', realAfter.md5 === realBefore.md5 && realAfter.size === realBefore.size);

  console.log(`\n══════ P7 测试 ${pass} passed, ${fail} failed ══════`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.stack); try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e2) {} process.exit(2); });
