// ============================================================
// P6 针对性测试：账号删除（DELETE /api/users/:id，2026-09-24 用户授权新增）
// ============================================================
// 用户裁决：**真删除 + 三条护栏**（仍绑定门店的店长 / 最后一个 system.user.edit 持有者 / 自己）
// 覆盖：
//   · 鉴权 401 / 403（含数据范围）
//   · 404
//   · 三条护栏一律 400，且被拒后**零写入**
//   · 成功删除：users 少一条、该记录消失、不能再登录、dataVersion 变化、审计留痕
//   · ★ 其它集合一律不动（stores / transactions / pending / redemptions / members / rules 指纹不变）
//   · ★ 删除后历史记录里的引用**确实会悬空**（这是用户明确接受的行为，用断言固定下来）
//   · 前端静态：5 列（门店｜用户名｜职位｜状态｜操作）、表头、无姓名列、删除按钮门禁、i18n key、无新 CSS 类
//
// 全部走 SP_DATA_DIR 沙箱；绝不触碰真实 data/。
// ⚠ 登录一次、之后复用 cookie（登录本身会写审计行，否则断言失真）。
// ⚠ 被删除/被停用的账号会话会立即失效，执行者要选「全程健在」的账号。
// ============================================================
process.env.PORT = '3197';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-p6-'));
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

// ── 生产矩阵基线（注入探针角色之前记录）──
const PROD_ROLES = Object.keys(rbac.ROLE_GRANTS);
const prodMatrixSnapshot = JSON.stringify(rbac.ROLE_GRANTS);
const PERM_COUNT = rbac.PERMISSIONS.length;

// ── 探针角色（仅本测试进程；证明范围门按矩阵实时生效）──
const ROLE_STORE = '__probe_p6_store_user_edit__';
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
    mk('U-admin2', 't_admin2', '总部管理员二', 'admin'),
    mk('U-mgr1', 't_mgr1', '一号店长', 'manager', { storeId: 'S1' }),   // 被 S1 绑定 → 不可删
    mk('U-mgr2', 't_mgr2', '二号店长', 'manager', { storeId: 'S2' }),   // 未绑定 → 可删
    mk('U-hq', 't_hq', '总部运营', 'hq_operator'),                       // 无权限 → 403
    mk('U-off', 't_off', '已停用店长', 'manager', { disabled: true, disabledAt: now() }),  // 软删除账号 → 可真删
    mk('U-ref', 't_ref', '被引用过的店长', 'manager'),                    // 下面三类记录会引用它
    mk('U-smprobe', 't_smprobe', '探针门店', ROLE_STORE, { storeId: 'S1' }),
  ]);
  store.writeCollection('members', []);
  // ★ 故意在业务记录里引用 U-ref：删除后这些引用会悬空（用户明确接受）
  store.writeCollection('transactions', [
    { id: 'TX1', memberId: 'M1', storeId: 'S1', type: 'spend', points: -10, reason: '测试流水', operatorId: 'U-ref', createdAt: now() },
  ]);
  store.writeCollection('pending', [
    { id: 'PD1', memberId: 'M1', storeId: 'S1', points: 50, requestedBy: 'U-ref', requestedByName: '被引用过的店长', createdAt: now() },
  ]);
  store.writeCollection('redemptions', [
    { id: 'RD1', productId: 'P1', storeId: 'S1', status: 'pending', createdBy: 'U-ref', createdByName: '被引用过的店长', createdAt: now() },
  ]);
  store.writeCollection('products', []);
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

const B = 'http://127.0.0.1:3197';

const cookies = {};
async function loginAs(username) {
  const r = await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PW }),
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  cookies[username] = sc.map(c => c.split(';')[0]).join('; ');
  return r.status;
}
async function as(username, method, p, body) {
  const opts = { method, headers: { cookie: cookies[username] || '' } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(B + p, opts);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, data: j };
}
const anon = async (method, p) => {
  const r = await fetch(B + p, { method });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, data: j };
};
const del = (who, id) => as(who, 'DELETE', '/api/users/' + id);

(async () => {
  await sleep(800);
  console.log('\n══════ P6 账号删除 针对性测试 ══════\n');

  await loginAs('t_admin');
  await loginAs('t_admin2');
  await loginAs('t_hq');
  await loginAs('t_mgr1');
  await loginAs('t_ref');
  await loginAs('t_smprobe');

  console.log('【0】前置：矩阵基线与种子');
  ok('生产矩阵 9 个角色定义逐字节未被本测试改动',
    PROD_ROLES.every(r => JSON.stringify(rbac.ROLE_GRANTS[r]) === JSON.stringify(JSON.parse(prodMatrixSnapshot)[r])));
  ok('权限总数仍为 ' + PERM_COUNT + '（删除不新增权限）', rbac.PERMISSIONS.length === PERM_COUNT);
  ok('沙箱账号 8 个、流水/待审/兑换各 1 条（含对 U-ref 的引用）',
    usersNow().length === 8 && (store.readCollection('transactions') || []).length === 1 &&
    (store.readCollection('pending') || []).length === 1 && (store.readCollection('redemptions') || []).length === 1);

  // ─────────────────────────────────────────
  console.log('\n【A】鉴权与范围');
  ok('未登录 → 401', (await anon('DELETE', '/api/users/U-mgr2')).status === 401);
  const hq = await del('t_hq', 'U-mgr2');
  ok('hq_operator（无 system.user.edit）→ 403', hq.status === 403, hq.status);
  ok('403 响应体不泄露账号数据', JSON.stringify(hq.data).indexOf('t_mgr2') === -1, hq.data);
  ok('store_manager 执行者 → 403', (await del('t_mgr1', 'U-mgr2')).status === 403);
  ok('★ 无权限者无法通过 id 探测账号是否存在（一律 403，不是 404）',
    (await del('t_hq', 'U-does-not-exist')).status === 403);
  // 数据范围：门店范围探针只能删本店账号
  ok('★ 门店范围持有者删除「别店」账号 → 403（范围门生效）',
    (await del('t_smprobe', 'U-mgr2')).status === 403);           // U-mgr2 属 S2，探针属 S1
  ok('★ 门店范围持有者删除「无门店」账号 → 403（fail-closed）',
    (await del('t_smprobe', 'U-off')).status === 403);
  ok('账号不存在（有权限者）→ 404', (await del('t_admin', 'U-nope')).status === 404);

  // ─────────────────────────────────────────
  console.log('\n【B】三条护栏（一律 400，且零写入）');
  const dv0 = dv();
  // ① 自己
  const selfDel = await del('t_admin', 'U-admin');
  ok('删除自己 → 400', selfDel.status === 400, selfDel.status);
  ok('文案是「不能删除当前登录账号。」', selfDel.data.error === '不能删除当前登录账号。', selfDel.data);
  ok('★ 自己仍在用户表里（没被删掉）', !!userById('U-admin'));
  ok('★ 自己的会话仍然有效', (await as('t_admin', 'GET', '/api/users')).status === 200);
  // ③ 仍被门店绑定的店长
  const boundDel = await del('t_admin', 'U-mgr1');
  ok('删除被 S1.managerId 绑定的店长 → 400', boundDel.status === 400, boundDel.status);
  ok('文案提示先解除门店绑定',
    /仍绑定门店/.test(boundDel.data.error) && /解除门店绑定/.test(boundDel.data.error), boundDel.data);
  ok('★ stores 绑定原样未动（没有自动解绑）',
    (store.readCollection('stores') || []).find(s => s.id === 'S1').managerId === 'U-mgr1');
  ok('★ 三条护栏被拒后 dataVersion 未变、users 数量未变',
    dv() === dv0 && usersNow().length === 8, { dv: dv(), n: usersNow().length });

  console.log('\n【B-2】护栏语义（代码级断言，防将来被改坏）');
  const SRV = fs.readFileSync(APP + '/server.js', 'utf8');
  const epBody = (() => {
    const i = SRV.indexOf("app.delete('/api/users/:id'");
    if (i < 0) return '';
    const rest = SRV.slice(i);
    const m = rest.slice(1).search(/\napp\.(get|post|put|delete|patch)\(/);
    return m < 0 ? rest : rest.slice(0, m + 1);
  })();
  const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('DELETE 接口已定义', epBody.length > 0);
  ok('权限门用既有 system.user.edit（不新增权限）', /checkPerm\(req, res, 'system\.user\.edit'\)/.test(epBody));
  ok('范围门对目标资源判定（防越权）', /check\(req, res, 'system\.user\.edit', target\)/.test(epBody));
  ok('★ 三条护栏齐全：自己 / 最后一个持有者 / 绑定门店',
    /user\.delete rejected \(self\)/.test(epBody) &&
    /user\.delete rejected \(last system\.user\.edit holder\)/.test(epBody) &&
    /user\.delete rejected \(store-bound manager\)/.test(epBody));
  ok('★ 「最后一个持有者」用 rbac.hasPermission 实时判定（剔注释后不含 role === \'admin\'）',
    /rbac\.hasPermission\(/.test(noComments(epBody)) && !/role\s*===\s*'admin'/.test(noComments(epBody)));
  ok('★ 只从 users 集合移除记录，绝不写 stores',
    /users\.splice\(/.test(epBody) && !/writeAll\('stores'/.test(epBody));
  ok('写入走 writeAll(\'users\')', /writeAll\('users', users\)/.test(epBody));
  ok('成功路径必须写审计行', /auditLog\(`user\.delete: /.test(epBody));
  ok('★ 可达性说明：调用者必然持有 system.user.edit 且 ≠ 目标 → last-holder 分支当前不可达（防御保留）',
    (() => {
      const exec = usersNow().filter(x => !x.disabled && rbac.hasPermission(x, 'system.user.edit'));
      return exec.every(a => usersNow().filter(x => !x.disabled && x.id !== a.id && rbac.hasPermission(x, 'system.user.edit')).length > 0);
    })());

  // ─────────────────────────────────────────
  console.log('\n【C】成功删除（未绑定、非持有者、非自己）');
  const fpBefore = Object.fromEntries(COLLS.map(c => [c, fp(c)]));
  const dvBefore = dv();
  const okDel = await del('t_admin', 'U-ref');
  ok('删除 U-ref（未绑定、非权限持有者）→ 200', okDel.status === 200, { status: okDel.status, data: okDel.data });
  ok('返回体 { ok:true, id, deleted:true }',
    okDel.data.ok === true && okDel.data.id === 'U-ref' && okDel.data.deleted === true, okDel.data);
  ok('★ users 从 8 → 7', usersNow().length === 7, usersNow().length);
  ok('★ 该记录已从 users 集合消失（真删除）', !userById('U-ref'));
  ok('★ dataVersion 发生变化', dv() !== dvBefore, { before: dvBefore, after: dv() });
  ok('★ 审计行 user.delete 已写入', /user\.delete: t_ref \(manager\) by t_admin/.test(auditText()));
  ok('★ 被删除的账号无法再登录', (await loginAs('t_ref')) === 401, '（期望 401：账号已不存在）');

  console.log('\n【C-2】★ 其它集合一律不动（删除不做引用清理 —— 用户明确接受）');
  COLLS.filter(c => c !== 'users').forEach(c =>
    ok(c.padEnd(13) + ' 指纹未变', fp(c) === fpBefore[c]));
  ok('★ transactions 里那条流水仍引用已删除的 operatorId',
    (store.readCollection('transactions') || [])[0].operatorId === 'U-ref');
  ok('★ pending.requestedBy 仍指向已删除的 id',
    (store.readCollection('pending') || [])[0].requestedBy === 'U-ref');
  ok('★ redemptions.createdBy 仍指向已删除的 id',
    (store.readCollection('redemptions') || [])[0].createdBy === 'U-ref');
  ok('★ stores 集合指纹未变（S1 仍绑 U-mgr1）', fp('stores') === fpBefore.stores);

  console.log('\n【C-3】删除「已停用」的账号也允许（软删除 → 硬删除）');
  const dvOff = dv();
  ok('删除已停用账号 U-off → 200', (await del('t_admin', 'U-off')).status === 200);
  ok('★ users 从 7 → 6', usersNow().length === 6, usersNow().length);
  ok('★ dataVersion 再次变化', dv() !== dvOff);

  console.log('\n【C-4】删除非持有者不会影响权限持有者数量');
  const holders = usersNow().filter(x => !x.disabled && rbac.hasPermission(x, 'system.user.edit')).map(x => x.username).sort();
  ok('★ 启用状态的 system.user.edit 持有者仍是 3 个（2 admin + 1 探针门店），删两个非持有者没影响它们',
    holders.join(',') === 't_admin,t_admin2,t_smprobe', holders);

  // ─────────────────────────────────────────
  console.log('\n【D】前端静态断言（新表格：门店｜用户名｜职位｜状态｜操作 + 删除按钮）');
  const APPJS = fs.readFileSync(path.join(APP, 'public', 'app.js'), 'utf8');
  const IDX = fs.readFileSync(path.join(APP, 'public', 'index.html'), 'utf8');
  const I18N = fs.readFileSync(path.join(APP, 'public', 'i18n.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(APP, 'public', 'styles.css'), 'utf8');
  const fnBody = (name) => {
    const i = APPJS.indexOf('function ' + name + '(');
    const i2 = i < 0 ? APPJS.indexOf('async function ' + name + '(') : i;
    if (i2 < 0) return '';
    const rest = APPJS.slice(i2);
    const m = rest.slice(1).search(/\nfunction |\nasync function /);
    return m < 0 ? rest : rest.slice(0, m + 1);
  };
  const accFn = fnBody('renderAccounts');
  const delFn = fnBody('confirmUserDelete');
  ok('renderAccounts / confirmUserDelete 均已定义', accFn.length > 0 && delFn.length > 0);
  // 只断言「桌面 5 列 + 手机 2 列」，不绑死像素宽度（列宽会随按钮数量调整）
  // ⚠ 正则匹配顺序是「手机端行 → 表头 → 桌面端行」，所以不能只取第一个匹配
  ok('★ 网格：桌面 5 列（门店/用户名/职位/状态/操作）+ 手机 2 列', (() => {
    const counts = (accFn.match(/grid-template-columns:[^";]+/g) || [])
      .map(g => g.split(':')[1].trim().split(/\s+/).length);
    return counts.includes(5) && counts.includes(2);
  })(), (accFn.match(/grid-template-columns:[^";]+/g) || []));
  ok('★ 表头 5 个标签按 门店→用户名→职位→状态→操作 顺序出现',
    (() => { const seq = ['colStore', 'colUser', 'colRole', 'colStatus', 'colActions'];
      const idx = seq.map(k => accFn.indexOf('accounts.' + k));
      return idx.every(x => x > -1) && idx.every((x, i) => i === 0 || x > idx[i - 1]); })(),
    ['colStore', 'colUser', 'colRole', 'colStatus', 'colActions'].map(k => accFn.indexOf('accounts.' + k)));
  // ⚠ 不绑死像素列宽：只校验「数据行第一格 = 门店名」，这样以后调列宽不会误报
  ok('★ 门店列排在数据行第一格（grid 第一列就是 storeNameFor）',
    /<div class="tx-row" style="grid-template-columns:[^"]+;">\s*<span[^>]*>\$\{escapeHtml\(storeNameFor\(a\)\)\}/.test(accFn));
  ok('★ 数据行已不再渲染「姓名」列', !/tName\(a\.name\)/.test(accFn));
  ok('★ 门店名解析 fail-closed：不在可见门店表里就显示「—」，不回退成 id',
    /const storeNameFor = \(a\) => \{/.test(accFn) && /return s \? tStore\(s\.name\) : '—';/.test(accFn));
  ok('★ 删除按钮只在 canDelete ? 三元里出现（门禁与按钮同一处）',
    /const btnDelete\s*= canDelete\s*\?/.test(accFn) && /const canDelete\s*= canEdit && !isSelf;/.test(accFn));
  ok('★ 删除动作走 DELETE，且只在 confirmUserDelete 里',
    /\bDELETE\(/.test(delFn) && !/\bDELETE\(/.test(accFn));
  ok('★ 删除确认弹窗是危险色（danger: true）', /danger: true/.test(delFn));
  ok('★ V2 创建账号 POST 与旧账号删除 DELETE 分离，删除流程不走 POST/PATCH',
    /POST\('\/api\/v2\/users'/.test(accFn) &&
    !/\bPATCH\(/.test(accFn + delFn) && !/\bPOST\(/.test(delFn));
  ok('★ index.html 版本号已递增：app.js>=37、i18n.js>=17',
    Number((IDX.match(/app\.js\?v=(\d+)/) || [])[1]) >= 37 &&
    Number((IDX.match(/i18n\.js\?v=(\d+)/) || [])[1]) >= 17,
    { app: (IDX.match(/app\.js\?v=(\d+)/) || [])[1], i18n: (IDX.match(/i18n\.js\?v=(\d+)/) || [])[1] });
  ok('★ styles.css 使用版本化资源地址', Number((IDX.match(/styles\.css\?v=(\d+)/) || [])[1]) >= 26);

  const i18nKeys = new Set((I18N.match(/^\s*'([a-zA-Z][a-zA-Z0-9_.]*)':\s*\[/gm) || [])
    .map(s => s.trim().replace(/^'/, '').replace(/':\s*\[$/, '')));
  const usedKeys = Array.from(new Set(Array.from((accFn + delFn).matchAll(/(?:^|[^A-Za-z0-9_$])t\('([a-zA-Z][a-zA-Z0-9_.]*)'/g)).map(m => m[1])));
  const missingKeys = usedKeys.filter(k => !i18nKeys.has(k));
  ok('★ renderAccounts/confirmUserDelete 用到的 ' + usedKeys.length + ' 个 i18n key 全部存在',
    missingKeys.length === 0, missingKeys);
  ok('★ 新增的列头与删除相关 key 都已登记（中英双语）',
    ['accounts.colStore', 'accounts.colUser', 'accounts.colRole', 'accounts.colStatus', 'accounts.colActions',
      'accounts.delete', 'accounts.deleteTitle', 'accounts.deleteBody', 'accounts.deleted'].every(k => i18nKeys.has(k)),
    ['accounts.colStore', 'accounts.colUser', 'accounts.colRole', 'accounts.colStatus', 'accounts.colActions',
      'accounts.delete', 'accounts.deleteTitle', 'accounts.deleteBody', 'accounts.deleted'].filter(k => !i18nKeys.has(k)));
  ok('★ 副标题与右上角说明已同步（不再写「只提供启用与停用」）',
    !/只提供启用与停用/.test(I18N) && !/only enables or disables/.test(I18N) &&
    /账号启用 \/ 停用 \/ 删除/.test(I18N) && /本页提供启用 \/ 停用 \/ 删除/.test(I18N));

  // 没有新增 CSS 类名
  const usedClasses = Array.from(new Set(
    ((accFn + delFn).match(/class="([^"]*)"/g) || [])
      .flatMap(s => s.replace(/class="|"/g, '').split(/\s+/)).filter(Boolean)));
  const missingCss = usedClasses.filter(c => !(new RegExp('\\.' + c + '(?![\\w-])')).test(CSS));
  ok('★ 未新增 CSS 类名：用到的 ' + usedClasses.length + ' 个类名全在 styles.css 里',
    missingCss.length === 0, { used: usedClasses, missing: missingCss });
  const deps = ['state', 'GET', 'PUT', 'DELETE', 'fmt', 'escapeHtml', 't', 'tMsg', 'locale', 'can',
    'isMobile', 'refreshStores', 'tStore', 'tName', 'roleLabel', 'confirmDialog', 'toast', 'renderScreen'];
  const i18nImport = (APPJS.match(/const \{([^}]*)\} = I18N;/) || [])[1] || '';
  const i18nProvided = new Set(i18nImport.split(',').map(s => s.trim()).filter(Boolean));
  const missingDeps = deps.filter(d =>
    !new RegExp('(function |const |let |var )' + d + '\\b').test(APPJS) && !i18nProvided.has(d));
  ok('依赖符号都已定义', missingDeps.length === 0, { missing: missingDeps });

  // ─────────────────────────────────────────
  console.log('\n【E】权限矩阵未被改动');
  ok('★ 生产 9 个角色的 ROLE_GRANTS 与测试开始时逐字节一致',
    PROD_ROLES.every(r => JSON.stringify(rbac.ROLE_GRANTS[r]) === JSON.stringify(JSON.parse(prodMatrixSnapshot)[r])));
  ok('★ server.js 里作为权限参数出现的名字，全部是既有 ' + PERM_COUNT + ' 项之一', (() => {
    const args = Array.from(SRV.matchAll(/guard\.(?:checkPerm|check)\(req,\s*res,\s*'([^']+)'/g)).map(m => m[1]);
    const names = Array.from(new Set(args));
    return names.length > 0 && names.every(n => rbac.PERMISSIONS.indexOf(n) !== -1);
  })());

  console.log('\n【F】真实 data/audit.log 未被污染');
  const realAfter = realStat();
  ok('★ 真实 audit.log 逐字节未变', realAfter.md5 === realBefore.md5 && realAfter.size === realBefore.size,
    { before: realBefore, after: realAfter });

  console.log(`\n══════ P6 测试 ${pass} passed, ${fail} failed ══════`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.stack); try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e2) {} process.exit(2); });
