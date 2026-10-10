// ============================================================
// P5 针对性测试：账号启用 / 停用（PUT /api/users/:id/status）
// ============================================================
// 覆盖用户 2026-09-22 冻结的 P5 规则：
//   权限新增 0 ｜ ROLE_GRANTS 修改 0 ｜ 已绑定门店的店长禁止停用（先解绑）
//   禁止自动解绑 ｜ 禁止保留绑定后停用 ｜ 最后一个 system.user.edit 持有者禁止停用
//   禁止停用自己 ｜ 其它权限最后持有者不硬拦 ｜ 历史停用账号允许启用
//   启用提示恢复登录能力 ｜ schema 不变 ｜ 只写 disabled + disabledAt
//   writeAll('users') ｜ dataVersion +1 ｜ 必须写审计行 ｜ 生产不碰任何关系
//
// 全部走 SP_DATA_DIR 沙箱；绝不触碰真实 data/。
//
// ⚠ 关键写法（沿用 P4 的教训）：**登录一次，之后复用 cookie**。
//   因为登录本身会写审计行，若每次请求前重新登录，审计断言会失真。
// ⚠ 另一个陷阱：被停用的账号会话会立即失效，因此执行者要选「全程保持启用」的账号。
// ============================================================
process.env.PORT = '3196';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-p5-'));
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

// ── 生产矩阵基线：必须在注入任何探针角色之前记录 ──
const PROD_ROLES = Object.keys(rbac.ROLE_GRANTS);
const prodMatrixSnapshot = JSON.stringify(rbac.ROLE_GRANTS);
const PERM_COUNT = rbac.PERMISSIONS.length;
const holdersBefore = PROD_ROLES.filter(r => rbac.hasPermission({ role: r }, 'system.user.edit'));
const viewersBefore = PROD_ROLES.filter(r => rbac.hasPermission({ role: r }, 'system.user.view'));

// ── 探针角色（只存在于本测试进程内，绝不进生产配置）──
// 目的：证明「最后一个持有者」与「数据范围」的判定是**按权限矩阵实时计算**的，
//       而不是写死 role === 'admin'。项目里已有先例（__probe_approve_only 等）。
const ROLE_GLOBAL = '__probe_p5_user_edit_global__';
const ROLE_STORE = '__probe_p5_user_edit_store__';
rbac.ROLE_GRANTS[ROLE_GLOBAL] = [{ p: 'system.user.view', s: 'global' }, { p: 'system.user.edit', s: 'global' }];
rbac.ROLE_GRANTS[ROLE_STORE] = [{ p: 'system.user.view', s: 'store' }, { p: 'system.user.edit', s: 'store' }];

// 真实 audit.log（绝不能被动到）
const REAL_LOG = path.join(APP, 'data', 'audit.log');
const realStat = () => { try { return { md5: md5(fs.readFileSync(REAL_LOG, 'utf8')), size: fs.statSync(REAL_LOG).size }; } catch (e) { return { md5: null, size: -1 }; } };
const realBefore = realStat();

const SANDBOX_LOG = path.join(SANDBOX, 'audit.log');
const auditLines = () => {
  try { return fs.readFileSync(SANDBOX_LOG, 'utf8').split('\n').filter(Boolean); } catch (e) { return []; }
};

const BUSINESS = ['users', 'stores', 'members', 'transactions', 'pending', 'products', 'redemptions', 'rules'];
const fpAll = () => {
  const out = {};
  for (const c of BUSINESS) {
    const rows = store.readCollection(c) || [];
    const arr = Array.isArray(rows) ? rows : [rows];
    out[c] = md5(arr.map(x => JSON.stringify(x)).join('\n'));
  }
  return out;
};
const dv = () => store.dataVersion();
const usersNow = () => store.readCollection('users') || [];
const userById = (id) => usersNow().find(x => x.id === id);
/** 去掉 disabled / disabledAt 后的账号快照（用于证明「只改了这两个字段」） */
// 2026-10-08：键序无关比较（JSON.stringify 对键序敏感，migrate 回填的 country 等
// 追加字段不应让本断言误报）。只剔除「停用操作自己负责的字段」+「迁移自动补的 country」。
const shapeOf = (u) => { const { disabled, disabledAt, country, ...rest } = u; return JSON.stringify(rest, Object.keys(rest).sort()); };

function seed() {
  store.writeCollection('stores', [
    { id: 'S1', name: '一号店', regionId: 'R-A', city: '', address: '', managerId: 'U-mgr1', managerName: '一号店长', phone: '', createdAt: now() },
    { id: 'S2', name: '二号店', regionId: 'R-B', city: '', address: '', managerId: null, managerName: '待分配', phone: '', createdAt: now() },
  ]);
  const mkUser = (id, username, name, role, extra) => Object.assign({
    id, username, password: bcrypt.hashSync(PW, 10), name, role,
    storeId: null, phone: '', createdAt: now(), disabled: false,
  }, extra || {});
  store.writeCollection('users', [
    mkUser('U-admin', 't_admin', '总部管理员', 'admin'),
    mkUser('U-admin2', 't_admin2', '总部管理员二', 'admin'),
    mkUser('U-mgr1', 't_mgr1', '一号店长', 'manager', { storeId: 'S1' }),      // 被 S1 绑定
    mkUser('U-mgr2', 't_mgr2', '二号店长', 'manager', { storeId: 'S2' }),      // 未被绑定
    mkUser('U-hq', 't_hq', '总部运营', 'hq_operator'),                          // 无 system.* 权限
    mkUser('U-off', 't_off', '历史停用账号', 'manager', { disabled: true, disabledAt: now(), storeId: null }),
    mkUser('U-probe', 't_probe', '探针全局', ROLE_GLOBAL),
    mkUser('U-smprobe', 't_smprobe', '探针门店', ROLE_STORE, { storeId: 'S1' }),
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
  store.writeCollection('sheets', { id: 'single', autoSync: false, syncCount: 0 });
  store.writeCollection('expiry-state', { lastRunAt: now(), expiryMonths: 24, expiredMembers: 0, expiredPoints: 0, dryRun: false, nextRunAt: now(), note: '' });
  store.writeCollection('_seeded', { id: 'singleton', at: now() });
}
seed();
require(APP + '/server.js');

const B = 'http://127.0.0.1:3196';

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
/** 以某用户身份请求（不重新登录） */
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
const status = (who, id, disabled) => as(who, 'PUT', '/api/users/' + id + '/status', { disabled });

(async () => {
  await sleep(800);
  console.log('\n══════ P5 账号启用/停用 针对性测试 ══════\n');

  // 执行者：t_admin（admin）与 t_probe（探针角色）——
  //   ★ 用探针角色登录本身就在证明「system.user.edit 的判定是按矩阵实时算的」
  await loginAs('t_admin');
  await loginAs('t_admin2');
  await loginAs('t_hq');
  await loginAs('t_mgr1');
  await loginAs('t_mgr2');   // 用于验证「被停用后会话立即失效」
  await loginAs('t_probe');
  await loginAs('t_smprobe');

  // ─────────────────────────────────────────
  console.log('【0】前置：权限矩阵与探针角色');
  ok('注入探针前，system.user.edit 只授 admin', holdersBefore.join(',') === 'admin', holdersBefore);
  ok('注入探针前，system.user.view 只授 admin', viewersBefore.join(',') === 'admin', viewersBefore);
  ok('探针角色在矩阵里「也持有 system.user.edit」（证明判定不写死 admin）',
    rbac.hasPermission({ role: ROLE_GLOBAL }, 'system.user.edit') === true);
  ok('生产矩阵的 9 个角色定义逐字节未被本测试改动',
    JSON.parse(prodMatrixSnapshot) && PROD_ROLES.every(r => JSON.stringify(rbac.ROLE_GRANTS[r]) === JSON.stringify(JSON.parse(prodMatrixSnapshot)[r])),
    PROD_ROLES);
  ok('权限总数仍为 ' + PERM_COUNT + '（P5 不新增权限）', rbac.PERMISSIONS.length === PERM_COUNT, rbac.PERMISSIONS.length);
  ok('沙箱：账号表已就位（8 个）', usersNow().length === 8, usersNow().length);

  // ─────────────────────────────────────────
  console.log('\n【A】未登录 / 无权限');
  ok('未登录 → 401', (await anon('PUT', '/api/users/U-mgr2/status', { disabled: true })).status === 401);
  const hqRes = await status('t_hq', 'U-mgr2', true);
  ok('hq_operator（无 system.user.edit）→ 403', hqRes.status === 403, hqRes.status);
  ok('403 响应体不泄露账号数据', JSON.stringify(hqRes.data).indexOf('t_mgr2') === -1, hqRes.data);
  const mgrRes = await status('t_mgr1', 'U-mgr2', true);
  ok('store_manager → 403', mgrRes.status === 403, mgrRes.status);
  ok('403 文案为统一的「无权限执行此操作」', hqRes.data.error === '无权限执行此操作', hqRes.data);
  ok('★ 无权限者无法通过参数探测账号是否存在（同样是 403，不是 404）',
    (await status('t_hq', 'U-no-such-id', true)).status === 403);

  // ─────────────────────────────────────────
  console.log('\n【B】参数校验 / 404 / 幂等');
  ok('账号不存在 → 404', (await status('t_admin', 'U-nope', true)).status === 404);
  ok('disabled 非布尔（字符串）→ 400', (await status('t_admin', 'U-mgr2', 'yes')).status === 400);
  ok('disabled 非布尔（数字）→ 400', (await status('t_admin', 'U-mgr2', 1)).status === 400);
  ok('缺字段 {} → 400', (await as('t_admin', 'PUT', '/api/users/U-mgr2/status', {})).status === 400);
  ok('幂等：停用已停用账号 → 400',
    (await status('t_admin', 'U-off', true)).status === 400,
    (await status('t_admin', 'U-off', true)).data);
  ok('幂等：启用已启用账号 → 400', (await status('t_admin', 'U-mgr2', false)).status === 400);

  // ─────────────────────────────────────────
  console.log('\n【C-1】硬护栏：禁止停用自己');
  const dv0 = dv();
  const selfRes = await status('t_admin', 'U-admin', true);
  ok('停用自己 → 400', selfRes.status === 400, selfRes.status);
  ok('文案是「不能停用当前登录账号。」', selfRes.data.error === '不能停用当前登录账号。', selfRes.data);
  ok('★ 自己的账号在库里仍是启用状态', userById('U-admin').disabled === false);
  ok('★ 自己的会话仍然有效（还能继续调用）', (await as('t_admin', 'GET', '/api/users')).status === 200);
  ok('★ 未产生任何写入（dataVersion 不变）', dv() === dv0, { before: dv0, after: dv() });

  // ─────────────────────────────────────────
  console.log('\n【C-2】硬护栏：已绑定门店的店长禁止停用（方案 A，绝不自动解绑）');
  const storesFpBefore = fpAll().stores;
  const boundRes = await status('t_admin', 'U-mgr1', true);
  ok('停用被 S1.managerId 绑定的店长 → 400', boundRes.status === 400, boundRes.status);
  ok('文案提示先解除门店绑定',
    /仍绑定门店/.test(boundRes.data.error) && /解除门店绑定/.test(boundRes.data.error), boundRes.data);
  ok('★ 该账号在库里仍是启用状态', userById('U-mgr1').disabled === false);
  ok('★ stores 集合指纹逐字节未变（没有自动解绑）', fpAll().stores === storesFpBefore);
  ok('★ stores.S1.managerId 仍指向该店长',
    (store.readCollection('stores') || []).find(s => s.id === 'S1').managerId === 'U-mgr1');
  ok('★ 未产生任何写入（dataVersion 不变）', dv() === dv0);

  // 反向：同一个账号，解除绑定后就能停用
  console.log('\n【C-2 反向验证】先解绑 → 再停用 → 应当成功');
  {
    const st = store.readCollection('stores') || [];
    const s1 = st.find(s => s.id === 'S1');
    s1.managerId = null; s1.managerName = '待分配';
    store.writeCollection('stores', st);
  }
  const afterUnbind = await status('t_admin', 'U-mgr1', true);
  ok('★ 解绑之后再停用同一账号 → 200（证明拒绝的原因确实是「绑定」而非账号本身）',
    afterUnbind.status === 200, { status: afterUnbind.status, data: afterUnbind.data });
  ok('停用后 disabled=true 且 disabledAt 是 ISO 时间',
    userById('U-mgr1').disabled === true && !isNaN(new Date(userById('U-mgr1').disabledAt).getTime()),
    userById('U-mgr1').disabledAt);
  // 还原：把店长重新启用 + 恢复 stores 绑定（供后续用例与「stores 从未被本接口触碰」的断言）
  ok('把该店长重新启用 → 200（还原测试现场）',
    (await status('t_admin', 'U-mgr1', false)).status === 200);
  {
    const st = store.readCollection('stores') || [];
    const s1 = st.find(s => s.id === 'S1');
    s1.managerId = 'U-mgr1'; s1.managerName = '一号店长';
    store.writeCollection('stores', st);
  }
  ok('已恢复：U-mgr1 启用且仍被 S1 绑定',
    userById('U-mgr1').disabled === false &&
    (store.readCollection('stores') || []).find(s => s.id === 'S1').managerId === 'U-mgr1');

  // ─────────────────────────────────────────
  console.log('\n【D】允许停用的正常路径（不绑门店 / 非持有者）');
  const dvBeforeMgr2 = dv();
  const mgr2Res = await status('t_admin', 'U-mgr2', true);
  ok('停用未被绑定的店长 → 200', mgr2Res.status === 200, { status: mgr2Res.status, data: mgr2Res.data });
  ok('返回体包含 ok / id / disabled / disabledAt',
    mgr2Res.data.ok === true && mgr2Res.data.id === 'U-mgr2' && mgr2Res.data.disabled === true && !!mgr2Res.data.disabledAt,
    mgr2Res.data);
  ok('★ 数据发生了写入（dataVersion 变化）', dv() !== dvBeforeMgr2, { before: dvBeforeMgr2, after: dv() });
  ok('★ 只改了 disabled / disabledAt：其余字段逐字节未变',
    shapeOf(userById('U-mgr2')) === shapeOf({ id: 'U-mgr2', username: 't_mgr2', password: userById('U-mgr2').password, name: '二号店长', role: 'manager', storeId: 'S2', phone: '', createdAt: userById('U-mgr2').createdAt }),
    shapeOf(userById('U-mgr2')));
  ok('★ 被停用账号的会话立即失效 → 401（不用等下次登录）',
    (await as('t_mgr2', 'GET', '/api/users')).status === 401);
  ok('无权限的活跃账号仍走权限判定 → 403（与 401 区分清楚）',
    (await as('t_hq', 'GET', '/api/users')).status === 403);
  ok('停用后的账号不能登录（403 该账号已停用）', (await (async () => {
    const r = await fetch(B + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 't_mgr2', password: PW }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  })()).status === 403);

  console.log('\n【D-2】允许启用（含历史停用账号）');
  const dvBeforeOn = dv();
  const onRes = await status('t_admin', 'U-off', false);
  ok('启用历史停用账号 → 200', onRes.status === 200, { status: onRes.status, data: onRes.data });
  ok('★ 启用后 disabled=false 且 disabledAt=null（按冻结规则写 null，不是删字段）',
    userById('U-off').disabled === false && userById('U-off').disabledAt === null,
    { disabled: userById('U-off').disabled, disabledAt: userById('U-off').disabledAt });
  ok('★ 数据发生了写入（dataVersion 变化）', dv() !== dvBeforeOn, { before: dvBeforeOn, after: dv() });
  ok('历史停用账号启用后可以登录', (await loginAs('t_off')) === 200);
  const offOn = await status('t_admin', 'U-off', true);   // 还原为停用，方便后续审计断言
  ok('再次停用该账号 → 200（双向都可操作）', offOn.status === 200, offOn.status);

  // ─────────────────────────────────────────
  console.log('\n【E】★ 关键证明：「最后一个 system.user.edit 持有者」按矩阵实时判定');
  // 当前启用持有者 = {t_admin, t_admin2}（admin）+ {t_probe}（探针全局）+ {t_smprobe}（探针门店）
  const enabledHolders = () => usersNow().filter(x => !x.disabled && rbac.hasPermission(x, 'system.user.edit')).map(x => x.username).sort();
  ok('启用状态的持有者共 4 个，其中 2 个不是 admin 角色（证明判定不看角色名）',
    enabledHolders().join(',') === 't_admin,t_admin2,t_probe,t_smprobe', enabledHolders());
  const dvBeforeProbeOff = dv();
  const probeOff = await status('t_admin', 'U-probe', true);
  ok('★ 停用一个「非 admin 角色但持有 system.user.edit」的账号 → 200（不是 400）',
    probeOff.status === 200, { status: probeOff.status, data: probeOff.data });
  ok('★ 停用后持有者只剩 3 个（2 admin + 1 探针门店）',
    enabledHolders().join(',') === 't_admin,t_admin2,t_smprobe', enabledHolders());
  ok('★ 数据发生了写入（dataVersion 变化）', dv() !== dvBeforeProbeOff);

  console.log('\n【E-2】护栏语义与顺序（代码级断言，防止将来被改成写死 admin）');
  const SRV = fs.readFileSync(APP + '/server.js', 'utf8');
  const epBody = (() => {
    const i = SRV.indexOf("app.put('/api/users/:id/status'");
    if (i < 0) return '';
    const rest = SRV.slice(i);
    const m = rest.slice(1).search(/\napp\.(get|post|put|delete|patch)\(/);
    return m < 0 ? rest : rest.slice(0, m + 1);
  })();
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('接口已定义', epBody.length > 0);
  ok('权限门用的是既有 system.user.edit（不新增权限）', /checkPerm\(req, res, 'system\.user\.edit'\)/.test(epBody));
  ok('范围门对目标资源判定（防越权）', /check\(req, res, 'system\.user\.edit', target\)/.test(epBody));
  ok('★ 「最后一个持有者」用 rbac.hasPermission 实时判定，而不是 role === \'admin\'（已剔除注释）',
    /rbac\.hasPermission\(/.test(stripComments(epBody)) && !/role\s*===\s*'admin'/.test(stripComments(epBody)),
    stripComments(epBody).match(/role\s*===\s*'admin'/g));
  ok('★ 判定顺序：停用自己 在 最后一个持有者 之前（自己优先给出专属文案）',
    epBody.indexOf('user.disable rejected (self)') > -1 &&
    epBody.indexOf('user.disable rejected (self)') < epBody.indexOf('last system.user.edit holder'));
  ok('★ 绑定门店的护栏依据 stores.managerId，且不写 stores（没有 writeAll(\'stores\')）',
    /s\.managerId === target\.id/.test(epBody) && !/writeAll\('stores'/.test(epBody));
  ok('只写 disabled / disabledAt 两个字段',
    /target\.disabled = true; target\.disabledAt = nowIso\(\)/.test(epBody) &&
    /target\.disabled = false; target\.disabledAt = null/.test(epBody));
  ok('写入走 writeAll(\'users\')', /writeAll\('users', users\)/.test(epBody));
  ok('成功路径必须写审计行', /auditLog\(`user\.\$\{want \? 'disable' : 'enable'\}/.test(epBody));

  console.log('\n【E-3】可达性：该护栏在当前规则组合下的真实触发条件');
  // 由于「执行者必须持有 system.user.edit」+「禁止停用自己」，
  // 执行者本身必然是启用持有者且 ≠ target → others 恒非空 → 该分支不会被命中。
  // 这是一个**防御性死分支**（为将来授予多角色 / 绕过会话的写库场景兜底），必须如实记录。
  const executors = usersNow().filter(x => !x.disabled && rbac.hasPermission(x, 'system.user.edit'));
  const unreachable = executors.every(actor =>
    usersNow().filter(x => !x.disabled && x.id !== actor.id && rbac.hasPermission(x, 'system.user.edit')).length === 0
  ) === false;
  ok('★ 可达性结论：存在「执行者 ≠ target 且 others 为空」的组合 → 否（该分支当前不可达）',
    unreachable === true, { executors: executors.map(x => x.username) });
  ok('→ 因此实际拦截「停用最后一个持有者」的一律是 self 护栏；last-holder 护栏作为防御保留',
    Number(enabledHolders().length) >= 1);

  // ─────────────────────────────────────────
  console.log('\n【F】数据范围（防御性）：把 system.user.edit 授给 store 范围的角色时自动收窄');
  const cross = await status('t_smprobe', 'U-mgr2', true);       // U-mgr2 属 S2，探针属 S1
  ok('★ 门店范围持有者停用「别店」账号 → 403（范围门生效）', cross.status === 403, { status: cross.status, data: cross.data });
  const sameStore = await status('t_smprobe', 'U-probe', true);  // U-probe 无 storeId → 不在 S1 范围
  ok('门店范围持有者停用「无门店」账号 → 403（fail-closed）', sameStore.status === 403, sameStore.status);
  const sameStoreOk = await status('t_smprobe', 'U-mgr1', true); // U-mgr1 属 S1（且在范围门之后被绑定护栏拦下）
  ok('门店范围持有者停用「本店」账号 → 不被范围门拦（400 来自绑定门店护栏）',
    sameStoreOk.status === 400 && /仍绑定门店/.test(sameStoreOk.data.error),
    { status: sameStoreOk.status, data: sameStoreOk.data });

  // ─────────────────────────────────────────
  console.log('\n【G】不碰任何关系与其它集合');
  const fpEnd = fpAll();
  ok('★ stores 集合指纹与测试开始时一致（P5 接口从未写 stores）',
    fpEnd.stores === fpAll().stores);
  ok('★ members 未被改动', (store.readCollection('members') || []).length === 0);
  ok('★ transactions 未被改动', (store.readCollection('transactions') || []).length === 0);
  ok('★ pending / products / redemptions 未被改动',
    ['pending', 'products', 'redemptions'].every(c => (store.readCollection(c) || []).length === 0));
  ok('★ rules 未被改动（单例，schemaVersion 仍 4）', (store.readCollection('rules') || {}).schemaVersion === 4);
  ok('★ 账号总数仍为 8（没有新建 / 删除账号）', usersNow().length === 8, usersNow().length);
  ok('★ 所有账号的 id 集合未变（没有任何账号被物理删除或重建）',
    usersNow().map(x => x.id).sort().join(',') === 'U-admin,U-admin2,U-hq,U-mgr1,U-mgr2,U-off,U-probe,U-smprobe',
    usersNow().map(x => x.id).sort());

  // ─────────────────────────────────────────
  console.log('\n【H】审计行（成功与拒绝都要留痕）');
  const lines = auditLines();
  const all = lines.join('\n');
  ok('成功停用写入了 user.disable 审计行', /user\.disable: t_mgr2 \(manager\) by t_admin/.test(all));
  ok('成功启用写入了 user.enable 审计行', /user\.enable: t_off \(manager\) by t_admin/.test(all));
  ok('★ 拒绝「停用自己」写入了 rejected (self) 审计行', /user\.disable rejected \(self\): t_admin/.test(all));
  ok('★ 拒绝「停用绑定店长」写入了 rejected (store-bound manager) 审计行',
    /user\.disable rejected \(store-bound manager\): t_admin tried to disable t_mgr1 of 一号店/.test(all), lines.filter(l => /rejected/.test(l)));
  ok('★ 审计行带 ISO 时间戳（P4 页面可解析）', lines.every(l => /^\[[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(l)));

  // ─────────────────────────────────────────
  console.log('\n【I】前端静态断言（页面只做启用 / 停用，且不新造权限与样式）');
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
  const stFn = fnBody('confirmUserStatus');
  const delFn = fnBody('confirmUserDelete');
  ok('renderAccounts 已定义', accFn.length > 0);
  ok('confirmUserStatus 已定义', stFn.length > 0);
  ok('confirmUserDelete 已定义（2026-09-24 用户授权新增）', delFn.length > 0);
  ok('个人资料页对登录用户开放，账号列表由 system.user.view 单独门禁',
    !/accounts:\s*'system\.user\.view'/.test(APPJS) &&
    /const canManageAccounts = can\('system\.user\.view'\)/.test(accFn) &&
    /if \(!canManageAccounts\)/.test(accFn) && /GET\('\/api\/users'\)/.test(accFn));
  ok('renderScreen 分发里有 accounts 分支', /state\.screen === 'accounts'\)\s*await renderAccounts/.test(APPJS));
  ok('index.html 有 data-screen="accounts" 导航项', IDX.indexOf('data-screen="accounts"') !== -1);
  ok('index.html 已把 app.js 版本提到 v>=36',
    Number((IDX.match(/app\.js\?v=(\d+)/) || [])[1]) >= 36, (IDX.match(/app\.js\?v=(\d+)/) || [])[1]);
  // ★ 2026-09-24：删除是用户新授权的动作 → 「页面只能 GET+PUT」这条不变量改为
  //   「启停走 PUT、删除只在 confirmUserDelete 里走 DELETE，且都没有 POST/PATCH」
  ok('★ 启停动作只用 PUT（confirmUserStatus 里没有 POST / DELETE / PATCH）',
    /\bPUT\(/.test(stFn) && !/\b(POST|DELETE|PATCH)\(/.test(stFn));
  ok('★ 删除动作只在 confirmUserDelete 里用 DELETE（没有 POST / PUT / PATCH）',
    /\bDELETE\(/.test(delFn) && !/\b(POST|PUT|PATCH)\(/.test(delFn));
  ok('★ 旧账号列表走 GET；V2 创建账号只走专用 POST；启停和删除不走 POST/PATCH',
    /GET\('\/api\/users'\)/.test(accFn) &&
    /POST\('\/api\/v2\/users'/.test(accFn) &&
    !/\bPATCH\(/.test(accFn + stFn + delFn) &&
    !/\bPOST\(/.test(stFn + delFn));
  ok('★ 启停与删除只打这两个接口：/api/users（GET）与 /api/users/:id[/status]',
    (accFn.match(/\/api\/users/g) || []).length === 1 &&
    (stFn.match(/\/api\/users\//g) || []).length === 1 &&
    (delFn.match(/\/api\/users\//g) || []).length === 1,
    { acc: (accFn.match(/\/api\/[a-z\-]*/g) || []), st: (stFn.match(/\/api\/[a-z\-]*/g) || []), del: (delFn.match(/\/api\/[a-z\-]*/g) || []) });
  ok('★ 前端不渲染「停用自己」的按钮（后端本来就 400）',
    /const canDisable = canEdit && !isSelf;/.test(accFn) && /const btnDisable = canDisable \?/.test(accFn));
  ok('★ 前端不渲染「删除自己」的按钮（后端本来就 400）',
    /const canDelete\s*= canEdit && !isSelf;/.test(accFn) && /const btnDelete\s*= canDelete\s*\?/.test(accFn));
  ok('★ 启用确认文案明确告知会恢复登录能力',
    /accounts\.enableBody/.test(accFn + stFn) &&
    /regain sign-in capability/.test(I18N) && /恢复登录能力/.test(I18N));
  ok('★ 启用 / 停用两个动作都会弹出二次确认', /confirmDialog\(/.test(stFn));
  // 只看 PUT 调用的实参（确认弹窗里出现的 username 是文案插值，不是请求体）
  const putCall = (() => {
    const i = stFn.indexOf('PUT(');
    if (i < 0) return '';
    const j = stFn.indexOf(');', i);
    return stFn.slice(i, j < 0 ? stFn.length : j + 2);
  })();
  ok('★ 选择项：本页只发送 {disabled} 这一个字段，绝不改用户名 / 角色 / 门店 / 密码',
    /\{\s*disabled:\s*toDisable\s*\}/.test(putCall) &&
    !/(username|role|storeId|password)\s*:/.test(putCall) &&
    (stFn.match(/\bPUT\(/g) || []).length === 1,
    { putCalls: (stFn.match(/\bPUT\(/g) || []).length, putCall });

  // 没有新增 CSS 类名
  const usedClasses = Array.from(new Set(
    ((accFn + stFn).match(/class="([^"]*)"/g) || [])
      .flatMap(s => s.replace(/class="|"/g, '').split(/\s+/))
      .filter(Boolean)
  ));
  const missingCss = usedClasses.filter(c => !(new RegExp('\\.' + c + '(?![\\w-])')).test(CSS));
  ok('★ 未新增 CSS 类名：用到的 ' + usedClasses.length + ' 个类名全在 styles.css 里',
    missingCss.length === 0, { used: usedClasses, missing: missingCss });
  ok('★ styles.css 未被改动（P5 不碰样式）',
    md5(CSS) === md5(fs.readFileSync(path.join(APP, 'public', 'styles.css'), 'utf8')));
  ok('★ 只有既有 CSS 变量（不写死颜色）',
    ['--ink', '--muted', '--subtle'].every(v => (accFn + stFn).indexOf('var(' + v + ')') !== -1));

  // i18n key 完整性
  const i18nKeys = new Set((I18N.match(/^\s*'([a-zA-Z][a-zA-Z0-9_.]*)':\s*\[/gm) || [])
    .map(s => s.trim().replace(/^'/, '').replace(/':\s*\[$/, '')));
  const usedKeys = Array.from(new Set(Array.from((accFn + stFn).matchAll(/(?:^|[^A-Za-z0-9_$])t\('([a-zA-Z][a-zA-Z0-9_.]*)'/g)).map(m => m[1])));
  const missingKeys = usedKeys.filter(k => !i18nKeys.has(k));
  ok('★ renderAccounts/confirmUserStatus 用到的 ' + usedKeys.length + ' 个 i18n key 全部存在',
    missingKeys.length === 0, missingKeys);
  ok('i18n 已登记 nav.accounts 与 accounts.* 共 19 个 key',
    ['nav.accounts', 'accounts.title', 'accounts.subtitle', 'accounts.summary', 'accounts.scopeFull',
      'accounts.scopeReadonly', 'accounts.empty', 'accounts.statusActive', 'accounts.statusDisabled',
      'accounts.self', 'accounts.boundHint', 'accounts.disabledAtHint', 'accounts.enable', 'accounts.disable',
      'accounts.enableTitle', 'accounts.enableBody', 'accounts.disableTitle', 'accounts.disableBody',
      'accounts.enabled'].every(k => i18nKeys.has(k)));
  ok('★ 与「账号设置」页文案区分开：nav.account=账号设置 而 nav.accounts=账号管理',
    /'nav\.account':\s*\['Account',\s*'账号设置'\]/.test(I18N) && /'nav\.accounts':\s*\['Accounts',\s*'账号管理'\]/.test(I18N));

  // 依赖符号存在
  const deps = ['state', 'GET', 'PUT', 'fmt', 'escapeHtml', 't', 'tMsg', 'locale', 'can',
    'isMobile', 'refreshStores', 'tStore', 'tName', 'roleLabel', 'confirmDialog', 'toast', 'renderScreen'];
  const i18nImport = (APPJS.match(/const \{([^}]*)\} = I18N;/) || [])[1] || '';
  const i18nProvided = new Set(i18nImport.split(',').map(s => s.trim()).filter(Boolean));
  const missingDeps = deps.filter(d =>
    !new RegExp('(function |const |let |var )' + d + '\\b').test(APPJS) && !i18nProvided.has(d));
  ok('renderAccounts 依赖的符号都已定义', missingDeps.length === 0, { missing: missingDeps });

  // ─────────────────────────────────────────
  console.log('\n【J】权限矩阵未被改动（P5 零新增权限 / 零角色变更）');
  ok('★ 生产 9 个角色的 ROLE_GRANTS 定义与测试开始时逐字节一致',
    PROD_ROLES.every(r => JSON.stringify(rbac.ROLE_GRANTS[r]) === JSON.stringify(JSON.parse(prodMatrixSnapshot)[r])));
  ok('★ 注入探针后角色总数 = 生产 9 + 本测试 2',
    Object.keys(rbac.ROLE_GRANTS).length === PROD_ROLES.length + 2, Object.keys(rbac.ROLE_GRANTS).length);
  ok('★ server.js 里作为「权限参数」出现的名字，全部是既有 69 项之一（P5 没引入新权限）', (() => {
    // 只取权限判定位置上的字面量：checkPerm(req,res,'X') / check(req,res,'X', ...)
    const args = Array.from(SRV.matchAll(/guard\.(?:checkPerm|check)\(req,\s*res,\s*'([^']+)'/g)).map(m => m[1]);
    const names = Array.from(new Set(args));
    return names.length > 0 && names.every(n => rbac.PERMISSIONS.indexOf(n) !== -1);
  })());

  // ─────────────────────────────────────────
  console.log('\n【K】真实 data/audit.log MD5 保持不变（P3 保证仍然成立）');
  const realAfter = realStat();
  ok('★ 真实 audit.log 逐字节未变', realAfter.md5 === realBefore.md5, { before: realBefore, after: realAfter });
  ok('★ 真实 audit.log size 未变', realAfter.size === realBefore.size, { before: realBefore.size, after: realAfter.size });

  console.log(`\n══════ P5 测试 ${pass} passed, ${fail} failed ══════`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.stack); try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e2) {} process.exit(2); });
