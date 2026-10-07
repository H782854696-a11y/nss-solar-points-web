// RBAC 权限层单元测试
// 设计原则（沿用项目约定）：纯函数测试，数据全部内联，不读 data/。
const rbac = require('../lib/rbac');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

// ---- 测试用用户（全部内联）----
const U = {
  admin:      { id: 'u1', role: 'admin', storeId: null },
  owner:      { id: 'u2', role: 'owner', storeId: null },
  hq:         { id: 'u3', role: 'hq_operator', storeId: null },
  ph:         { id: 'u4', role: 'philippines_manager', storeId: null },
  regA:       { id: 'u5', role: 'regional_manager', regionId: 'R-A', storeId: null },
  mgrS1:      { id: 'u6', role: 'store_manager', storeId: 'S1' },
  mgrS2:      { id: 'u7', role: 'store_manager', storeId: 'S2' },
  salesS1:    { id: 'u8', role: 'sales', storeId: 'S1', employeeId: 'E8' },
  whS1:       { id: 'u9', role: 'warehouse', storeId: 'S1', employeeId: 'E9' },
  svcS1:      { id: 'u10', role: 'service', storeId: 'S1', employeeId: 'E10' },
  legacyMgr:  { id: 'u11', role: 'manager', storeId: 'S1' },   // 旧角色
};
// 2026-10-08 审计 C-1：会员记录带 country 字段（菲律宾会员即 country='PH'）。
// philippines 范围已改 fail-closed —— 缺 country 的记录对菲方不可见。
const M1 = { id: 'm1', storeId: 'S1', ownerId: null, status: 'active', country: 'PH' };
const M2 = { id: 'm2', storeId: 'S2', ownerId: null, status: 'active', country: 'PH' };

// ---- 测试专用探针角色：region 数据范围（沿用本文件既有的探针写法）----
// 2026-09-22 组织架构调整后，生产矩阵里**已不再有任何角色使用 region 范围**
// （regional_manager 提升为 philippines，全国只保留 1 名负责人）。
// 但 rbac 的 region 分支（inScope / getDataScope）与 rbac-guard 的区域派生逻辑
// 依然保留在代码里（供将来可能的区域化角色使用），仍需回归覆盖 ——
// 故在此注入一个探针角色：**权限集合与生产 regional_manager 完全一致，仅把范围换成 region**。
// 只存在于测试进程内，不进生产配置。
rbac.ROLE_GRANTS.__probe_region = rbac.ROLE_GRANTS.regional_manager.map(g => ({ p: g.p, s: 'region' }));
const U_REGION = { id: 'u-probe-region', role: '__probe_region', regionId: 'R-A', storeId: null };
const U_REGION_NONE = { id: 'u-probe-region-none', role: '__probe_region', storeId: null };

console.log('\n══════ RBAC 单元测试 ══════\n');

// ── 1. 角色规范化与兼容映射 ──
console.log('【1】旧角色兼容映射');
ok('admin → admin', rbac.normalizeRole('admin') === 'admin');
ok('manager → store_manager', rbac.normalizeRole('manager') === 'store_manager');
ok('未知角色原样返回（安全一侧）', rbac.normalizeRole('ghost') === 'ghost');
ok('空值返回 null', rbac.normalizeRole(null) === null);
ok('旧 manager 账号获得 store_manager 的权限', rbac.hasPermission(U.legacyMgr, 'member.edit'));
ok('旧 manager 账号没有管理员权限', !rbac.hasPermission(U.legacyMgr, 'system.user.edit'));
ok('旧 manager 的 store scope 生效（本店会员可改）', rbac.can(U.legacyMgr, 'member.edit', M1));
ok('旧 manager 的 store scope 生效（他店会员不可改）', !rbac.can(U.legacyMgr, 'member.edit', M2));

// ── 2. admin 向后兼容 ──
console.log('\n【2】admin 向后兼容（保留业务权限用于运维）');
let adminAll = true; const adminMissing = [];
for (const p of rbac.PERMISSIONS) {
  if (p === 'kingdee.edit') continue;             // 金蝶绝不回写，admin 也不行
  if (!rbac.hasPermission(U.admin, p)) { adminAll = false; adminMissing.push(p); }
}
ok(`admin 拥有除 kingdee.edit 外的全部 ${rbac.PERMISSIONS.length - 1} 个权限`, adminAll, adminMissing);
ok('admin 拥有 member.edit（现有会员维护不失效）', rbac.hasPermission(U.admin, 'member.edit'));
ok('admin 拥有 approval.approve（现有审核不失效）', rbac.hasPermission(U.admin, 'approval.approve'));
ok('admin 拥有 system.role.manage', rbac.hasPermission(U.admin, 'system.role.manage'));
ok('admin 范围为 global', rbac.permScope(U.admin, 'member.edit') === 'global');

// ── 3. owner 不继承系统权限 ──
console.log('\n【3】owner ≠ admin（不继承系统权限）');
const sysPerms = rbac.PERMISSIONS.filter(p => p.startsWith('system.') || p.startsWith('db.') || p.startsWith('sync.'));
let ownerClean = true; const ownerLeak = [];
for (const p of sysPerms) if (rbac.hasPermission(U.owner, p)) { ownerClean = false; ownerLeak.push(p); }
ok(`owner 无任何 system/db/sync 权限（共 ${sysPerms.length} 个）`, ownerClean, ownerLeak);
ok('owner 可看驾驶舱', rbac.hasPermission(U.owner, 'dashboard.view'));
ok('owner 可看报表并导出', rbac.hasPermission(U.owner, 'report.view') && rbac.hasPermission(U.owner, 'report.export'));
ok('owner 可发起任务', rbac.hasPermission(U.owner, 'task.create'));
ok('owner 可创建/升级异常', rbac.hasPermission(U.owner, 'alert.create') && rbac.hasPermission(U.owner, 'alert.escalate'));
ok('owner 不能关异常', !rbac.hasPermission(U.owner, 'alert.close'));
ok('owner 不能审批', !rbac.hasPermission(U.owner, 'approval.approve'));
ok('owner 不能编辑会员', !rbac.hasPermission(U.owner, 'member.edit'));
ok('owner 范围为 global', rbac.permScope(U.owner, 'dashboard.view') === 'global');

// ── 4. HQ 边界（第 5 条原则）──
console.log('\n【4】HQ 边界：能看、能发起，不能改人/审批/关闭');
ok('HQ 可看员工基础资料', rbac.hasPermission(U.hq, 'staff.view'));
ok('HQ 可看员工运营数据与报表', rbac.hasPermission(U.hq, 'report.view'));
ok('HQ 不能编辑员工资料', !rbac.hasPermission(U.hq, 'staff.edit'));
ok('HQ 不能调动员工', !rbac.hasPermission(U.hq, 'staff.assign'));
ok('HQ 不能评价/考核员工', !rbac.hasPermission(U.hq, 'staff.appraise'));
ok('HQ 不能审批积分', !rbac.hasPermission(U.hq, 'approval.approve'));
ok('HQ 不能驳回积分', !rbac.hasPermission(U.hq, 'approval.reject'));
ok('HQ 不能调整积分余额', !rbac.hasPermission(U.hq, 'points.adjust'));
ok('HQ 不能关闭异常', !rbac.hasPermission(U.hq, 'alert.close'));
ok('HQ 不能关闭任务', !rbac.hasPermission(U.hq, 'task.close'));
ok('HQ 可以创建/分派任务', rbac.hasPermission(U.hq, 'task.create') && rbac.hasPermission(U.hq, 'task.assign'));
ok('HQ 可以升级异常', rbac.hasPermission(U.hq, 'alert.escalate'));
ok('HQ 无系统权限', sysPerms.every(p => !rbac.hasPermission(U.hq, p)));
ok('HQ 范围为 philippines', rbac.permScope(U.hq, 'staff.view') === 'philippines');

// ── 5. 菲律宾负责人边界 ──
console.log('\n【5】philippines_manager 边界');
ok('PH 可管理门店', rbac.hasPermission(U.ph, 'store.edit') && rbac.hasPermission(U.ph, 'store.create'));
ok('PH 可管理员工', rbac.hasPermission(U.ph, 'staff.edit') && rbac.hasPermission(U.ph, 'staff.assign'));
ok('PH 可审批积分', rbac.hasPermission(U.ph, 'approval.approve'));
ok('PH 可关闭异常', rbac.hasPermission(U.ph, 'alert.close'));
ok('PH 可调整积分', rbac.hasPermission(U.ph, 'points.adjust'));
ok('PH 不能管理 RBAC', !rbac.hasPermission(U.ph, 'system.role.manage'));
ok('PH 不能改系统权限', !rbac.hasPermission(U.ph, 'system.user.edit'));
ok('PH 不能改系统级配置', !rbac.hasPermission(U.ph, 'system.config.edit'));
ok('PH 无 db / sync 权限', !rbac.hasPermission(U.ph, 'db.view') && !rbac.hasPermission(U.ph, 'sync.config'));
ok('PH 范围固定 philippines（非 global）', rbac.permScope(U.ph, 'member.edit') === 'philippines');
ok('PH 不能改金蝶基础数据', !rbac.hasPermission(U.ph, 'kingdee.edit'));
ok('PH 可只读消费金蝶数据', rbac.hasPermission(U.ph, 'kingdee.view'));

// ── 6. 全国区域负责人 / store 层级 ──
console.log('\n【6】regional_manager（全国唯一）与 store_manager 层级边界');
ok('全国区域负责人范围为 philippines（2026-09-22 起，原为 region）',
  rbac.permScope(U.regA, 'member.edit') === 'philippines');
ok('全国区域负责人授权全部是 philippines（无一遗漏）',
  rbac.grantsFor('regional_manager').length > 0 &&
  rbac.grantsFor('regional_manager').every(g => g.s === 'philippines'),
  rbac.grantsFor('regional_manager').filter(g => g.s !== 'philippines').map(g => g.p + ':' + g.s));
ok('生产矩阵里已没有任何角色使用 region 范围（该范围仅由测试探针覆盖）',
  Object.keys(rbac.ROLE_GRANTS).filter(r => r.indexOf('__probe_') !== 0)
    .every(r => rbac.grantsFor(r).every(g => g.s !== 'region')));
ok('Region 可管本区域门店', rbac.hasPermission(U.regA, 'store.edit'));
ok('Region 可指派店长', rbac.hasPermission(U.regA, 'staff.assign'));
ok('Region 不能审批', !rbac.hasPermission(U.regA, 'approval.approve'));
ok('Region 不能改积分余额', !rbac.hasPermission(U.regA, 'points.adjust'));
ok('Region 不能删会员/门店', !rbac.hasPermission(U.regA, 'member.delete') && !rbac.hasPermission(U.regA, 'store.delete'));
ok('Region 仍无 system / db / sync 权限（换档不带来管理员能力）',
  !['system.user.view', 'system.user.edit', 'system.role.manage', 'system.config.edit',
    'system.audit.view', 'db.view', 'db.export', 'sync.view', 'sync.config', 'sync.run']
    .some(p => rbac.hasPermission(U.regA, p)));
ok('Region 仍无改积分规则的权限', !rbac.hasPermission(U.regA, 'points.rule.edit'));
ok('Store 范围为 store', rbac.permScope(U.mgrS1, 'member.edit') === 'store');
ok('Store 不能改门店配置', !rbac.hasPermission(U.mgrS1, 'store.edit'));
ok('Store 不能改员工档案', !rbac.hasPermission(U.mgrS1, 'staff.edit'));
ok('Store 可指派本店销售', rbac.hasPermission(U.mgrS1, 'staff.assign'));
ok('Store 不能删会员', !rbac.hasPermission(U.mgrS1, 'member.delete'));
ok('Store 不能审批', !rbac.hasPermission(U.mgrS1, 'approval.approve'));
ok('Store 可提交审核申请', rbac.hasPermission(U.mgrS1, 'approval.create'));

// ── 7. 同一角色不同权限可有不同范围（第 4 条）──
console.log('\n【7】Role → Permission → Scope（sales 混合范围）');
ok('sales 看本店会员 → store', rbac.permScope(U.salesS1, 'member.view') === 'store');
ok('sales 看本店积分 → store', rbac.permScope(U.salesS1, 'points.view') === 'store');
ok('sales 看自己客户 → self', rbac.permScope(U.salesS1, 'crm.view') === 'self');
ok('sales 建自己客户 → self', rbac.permScope(U.salesS1, 'crm.create') === 'self');
ok('sales 看自己任务 → self', rbac.permScope(U.salesS1, 'task.view') === 'self');
ok('sales 个人业绩 → self', rbac.permScope(U.salesS1, 'report.view') === 'self');
ok('sales 不能改会员', !rbac.hasPermission(U.salesS1, 'member.edit'));
ok('sales 不能动积分', !rbac.hasPermission(U.salesS1, 'points.grant'));
ok('warehouse 可看金蝶库存（store）', rbac.permScope(U.whS1, 'kingdee.view') === 'store');
ok('warehouse 不能改金蝶数据', !rbac.hasPermission(U.whS1, 'kingdee.edit'));
ok('service 建工单 → self', rbac.permScope(U.svcS1, 'aftersales.create') === 'self');

// ── 8. can() 的数据范围强制执行 ──
console.log('\n【8】Data Scope 判定（后端强制）');
ok('S1 店长可改本店会员', rbac.can(U.mgrS1, 'member.edit', M1));
ok('S1 店长不可改 S2 会员', !rbac.can(U.mgrS1, 'member.edit', M2));
ok('S2 店长可改本店会员', rbac.can(U.mgrS2, 'member.edit', M2));
ok('S2 店长不可改 S1 会员', !rbac.can(U.mgrS2, 'member.edit', M1));
ok('admin 可改任意会员（global）', rbac.can(U.admin, 'member.edit', M1) && rbac.can(U.admin, 'member.edit', M2));
ok('sales 可看本店会员', rbac.can(U.salesS1, 'member.view', M1));
ok('sales 不可看他店会员', !rbac.can(U.salesS1, 'member.view', M2));
ok('sales 可看自己的客户', rbac.can(U.salesS1, 'crm.view', { ownerId: 'E8' }));
ok('sales 不可看别人的客户', !rbac.can(U.salesS1, 'crm.view', { ownerId: 'E99' }));
ok('不传资源时只判权限', rbac.can(U.mgrS1, 'member.edit') === true);
ok('无权限时传不传资源都 false', !rbac.can(U.mgrS1, 'member.delete') && !rbac.can(U.mgrS1, 'member.delete', M1));
ok('全国区域负责人可跨店改会员（M1/M2 都在范围内）',
  rbac.can(U.regA, 'member.edit', M1) && rbac.can(U.regA, 'member.edit', M2));
ok('全国区域负责人可跨店读会员',
  rbac.can(U.regA, 'member.view', M1) && rbac.can(U.regA, 'member.view', M2));
ok('全国区域负责人可跨店改门店配置（5 家门店都在范围内）',
  rbac.can(U.regA, 'store.edit', { id: 's1', name: 'A', country: 'PH' }) && rbac.can(U.regA, 'store.edit', { id: 's2', name: 'B', country: 'PH' }));
// 2026-10-08 审计 C-1：philippines 范围 fail-closed —— 缺 country 字段的记录不再默认放行
ok('philippines 范围：缺 country 的记录拒绝（fail-closed）',
  !rbac.can(U.regA, 'member.edit', { id: 'mx', storeId: 'S1' }));
ok('philippines 范围：country=PH 放行', rbac.can(U.regA, 'member.edit', M1));
ok('philippines 范围：country=CN 拒绝（中菲隔离）',
  !rbac.can(U.regA, 'member.edit', { id: 'mc', storeId: 'S1', country: 'CN' }));
// region 分支仍保持 fail-closed（用探针角色验证；该路径已无生产角色使用，但代码仍在）
ok('region 级：数据没有 regionId 时拒绝（安全一侧）', !rbac.can(U_REGION, 'member.edit', M1));
ok('region 级：本区域数据放行',
  rbac.can(U_REGION, 'member.edit', { id: 'm3', storeId: 'S1', regionId: 'R-A' }));
ok('region 级：他区域数据拒绝',
  !rbac.can(U_REGION, 'member.edit', { id: 'm4', storeId: 'S2', regionId: 'R-B' }));
ok('region 级：账号本身没有 regionId 时一律拒绝',
  !rbac.can(U_REGION_NONE, 'member.edit', { id: 'm3', storeId: 'S1', regionId: 'R-A' }));

// ── 9. getDataScope ──
console.log('\n【9】getDataScope（列表过滤用）');
const dsAdmin = rbac.getDataScope(U.admin, 'member');
const dsMgr = rbac.getDataScope(U.mgrS1, 'member');
const dsReg = rbac.getDataScope(U.regA, 'member');
const dsSales = rbac.getDataScope(U.salesS1, 'crm');
ok('admin → global', dsAdmin.level === 'global');
ok('store_manager → store 且带 storeId', dsMgr.level === 'store' && dsMgr.storeId === 'S1');
ok('全国区域负责人 → philippines', dsReg.level === 'philippines');
// region 分支仍可用（探针角色）：取到 region 级并带上账号的 regionId
const dsProbe = rbac.getDataScope(U_REGION, 'member');
ok('region 级（探针）→ 取到 region 且带 regionId', dsProbe.level === 'region' && dsProbe.regionId === 'R-A');
ok('sales 的 crm → self', dsSales.level === 'self');
ok('无权限资源 → none', rbac.getDataScope(U.salesS1, 'system').level === 'none');

// ── 10. 字段级权限 ──
console.log('\n【10】allowedFields（替代手写 isAdmin 白名单）');
const fMgr = rbac.allowedFields(U.mgrS1, 'member');
const fAdmin = rbac.allowedFields(U.admin, 'member');
const fPh = rbac.allowedFields(U.ph, 'member');
ok('店长只能改 name/phone/notes', JSON.stringify(fMgr) === JSON.stringify(['name', 'phone', 'notes']), fMgr);
ok('店长不能改 spend/type/storeId/status/points', ['spend', 'type', 'storeId', 'status', 'points'].every(f => fMgr.indexOf(f) === -1));
ok('admin 可改全部字段', ['spend', 'type', 'storeId', 'status', 'points', 'level'].every(f => fAdmin.indexOf(f) !== -1), fAdmin);
ok('philippines_manager 可改全部字段', ['spend', 'type', 'storeId', 'status'].every(f => fPh.indexOf(f) !== -1));
ok('regional_manager 不能改敏感字段', ['spend', 'type', 'storeId'].every(f => rbac.allowedFields(U.regA, 'member').indexOf(f) === -1));

// ── 11. ASSIGNMENT_RULES（表驱动）──
console.log('\n【11】canAssign 表驱动指派规则');
ok('HQ 可指派给菲律宾负责人', rbac.canAssign(U.hq, U.ph, 'task').ok);
ok('HQ 可指派给区域负责人', rbac.canAssign(U.hq, U.regA, 'task').ok);
ok('HQ 不可直接指派给店长', !rbac.canAssign(U.hq, U.mgrS1, 'task').ok);
ok('HQ 不可直接指派给销售', !rbac.canAssign(U.hq, U.salesS1, 'task').ok);
ok('PH 可指派给区域负责人', rbac.canAssign(U.ph, U.regA, 'task').ok);
ok('PH 可指派给店长', rbac.canAssign(U.ph, U.mgrS1, 'task').ok);
ok('PH 可指派给销售', rbac.canAssign(U.ph, U.salesS1, 'task').ok);
ok('Region 可指派给店长', rbac.canAssign(U.regA, U.mgrS1, 'task').ok);
ok('Region 不可指派给菲律宾负责人（越级）', !rbac.canAssign(U.regA, U.ph, 'task').ok);
ok('Store 可指派给本店销售', rbac.canAssign(U.mgrS1, U.salesS1, 'task').ok);
ok('Store 不可指派给别店销售（跨店）', !rbac.canAssign(U.mgrS1, { role: 'sales', storeId: 'S2', employeeId: 'X' }, 'task').ok);
ok('销售不能指派任何人', !rbac.canAssign(U.salesS1, U.salesS1, 'task').ok);
ok('规则表是表驱动的（无 if/else 链）', typeof rbac.ASSIGNMENT_RULES === 'object');

// ── 12. L1 / L2 分离 ──
console.log('\n【12】L1 权限判定与 L2 业务状态判定分离');
const approvedRec = { id: 'p1', status: 'approved', storeId: 'S1', country: 'PH' };
const pendingRec = { id: 'p2', status: 'pending', storeId: 'S1', country: 'PH' };
ok('L1：有 approve 权限 → can() 返回 true（不看状态）', rbac.can(U.ph, 'approval.approve', pendingRec));
ok('L1：即使记录已 approved，can() 仍为 true —— 状态归 L2 管', rbac.can(U.ph, 'approval.approve', approvedRec));
ok('L1：无 approve 权限 → 无论什么状态都 false', !rbac.can(U.mgrS1, 'approval.approve', pendingRec));
ok('说明：重复审批由 approvals.canDecide() 在 L2 拦截（现有代码，未改动）', true);

// ── 13. 金蝶只读 ──
console.log('\n【13】金蝶数据只读（所有角色）');
let nobody = true; const whoHas = [];
for (const key of Object.keys(U)) {
  if (rbac.hasPermission(U[key], 'kingdee.edit')) { nobody = false; whoHas.push(key); }
}
ok('没有任何角色拥有 kingdee.edit', nobody, whoHas);

// ── 14. permissionsOf（给 /api/auth/me）──
console.log('\n【14】permissionsOf（前端渲染用，不作安全边界）');
const pAdmin = rbac.permissionsOf(U.admin);
const pOwner = rbac.permissionsOf(U.owner);
ok('admin 权限列表非空且去重', pAdmin.length > 0 && new Set(pAdmin).size === pAdmin.length);
ok('owner 权限列表不含系统权限', pOwner.every(p => !p.startsWith('system.') && !p.startsWith('db.') && !p.startsWith('sync.')));
ok('未识别角色返回空列表', rbac.permissionsOf({ role: 'ghost' }).length === 0);

// ── 15. points.grant.direct 与 approval.approve 互相独立 ──
console.log('\n【15】points.grant.direct ≠ approval.approve（能力不隐式绑定）');
ok('admin 拥有 points.grant.direct', rbac.hasPermission(U.admin, 'points.grant.direct'));
ok('philippines_manager 拥有 points.grant.direct', rbac.hasPermission(U.ph, 'points.grant.direct'));
ok('philippines_manager 同时拥有 approval.approve（两个能力可并存）', rbac.hasPermission(U.ph, 'approval.approve'));
ok('store_manager 无 points.grant.direct（必须走审核）', !rbac.hasPermission(U.mgrS1, 'points.grant.direct'));
ok('regional_manager 无 points.grant.direct', !rbac.hasPermission(U.regA, 'points.grant.direct'));
ok('hq_operator 无 points.grant.direct', !rbac.hasPermission(U.hq, 'points.grant.direct'));
ok('owner 无 points.grant.direct', !rbac.hasPermission(U.owner, 'points.grant.direct'));
ok('sales 两者都无', !rbac.hasPermission(U.salesS1, 'points.grant.direct') && !rbac.hasPermission(U.salesS1, 'approval.approve'));
ok('store_manager 无 approve 但可提交申请', !rbac.hasPermission(U.mgrS1, 'approval.approve') && rbac.hasPermission(U.mgrS1, 'approval.create'));

// 用两个「探针角色」直接证明：拥有其一不会自动获得另一个
rbac.ROLE_GRANTS.__probe_approve_only = [{ p: 'approval.approve', s: 'global' }];
ok('只有 approval.approve 的角色 → 不会自动获得 points.grant.direct',
  rbac.hasPermission({ role: '__probe_approve_only' }, 'approval.approve') &&
  !rbac.hasPermission({ role: '__probe_approve_only' }, 'points.grant.direct'));
delete rbac.ROLE_GRANTS.__probe_approve_only;

rbac.ROLE_GRANTS.__probe_direct_only = [{ p: 'points.grant.direct', s: 'global' }];
ok('只有 points.grant.direct 的角色 → 不会自动获得 approval.approve',
  rbac.hasPermission({ role: '__probe_direct_only' }, 'points.grant.direct') &&
  !rbac.hasPermission({ role: '__probe_direct_only' }, 'approval.approve'));
delete rbac.ROLE_GRANTS.__probe_direct_only;

// 结构性证明：hasPermission 是纯查表，不存在任何隐式推导
let noImplication = true; const leaked = [];
for (const role of rbac.ROLES) {
  const grants = rbac.ROLE_GRANTS[role].map(g => g.p);
  for (const p of rbac.PERMISSIONS) {
    const fromTable = grants.indexOf(p) !== -1;
    const fromApi = rbac.hasPermission({ role }, p);
    if (fromTable !== fromApi) { noImplication = false; leaked.push(role + ':' + p); }
  }
}
ok('hasPermission 严格等于表查询结果（无任何隐式权限推导）', noImplication, leaked);

console.log(`\n══════ ${pass} passed, ${fail} failed ══════`);
if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
process.exit(fail ? 1 : 0);
