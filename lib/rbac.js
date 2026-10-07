// ============================================================
// 统一权限抽象层（RBAC）
// ============================================================
// 模型：User → Role → Permission → Data Scope → Action
//
// 设计要点（本次实施严格遵守）：
//   ① 范围挂在「角色 ↔ 权限」的授予关系上，不是挂在角色上。
//      同一个角色的不同权限可以有不同 Data Scope（sales 最典型）。
//   ② L1（本文件）只回答「这个用户有没有资格执行这个 Action」——
//      **纯静态，不看资源当前状态，不查库，可缓存**。
//   ③ L2（业务状态守卫，如 approvals.canDecide / mall.canFulfill）
//      回答「这个资源现在是否允许执行这个 Action」——只看状态，不看角色。
//      **两层互不越界**：RBAC 不查状态，业务守卫不认角色。
//   ④ 表驱动：新增角色只改 ROLE_GRANTS / ASSIGNMENT_RULES，核心代码不动。
//   ④.b 【重要】「全局单例配置」类能力只能授予 global 角色。
//      有些资源没有 id/storeId/regionId，例如 rules.json（全连锁共用一份）。
//      这类接口调用 checkPerm() 时**没有资源对象可比**，因此范围永远不会参与判定 ——
//      一旦把它授予 store / region / philippines 角色，那个角色就获得了「改全局」的实际能力，
//      范围标注会变成一句空话。凡属此类的能力，**只授予 global 角色**。
//      当前属于此类的权限：points.rule.edit、points.expiry.scan、sync.*、system.*、db.*。
//   ⑤ 能力之间**不隐式绑定**。典型例子：
//        points.grant.direct = 可以直接向会员发放积分、不进审批流
//        approval.approve    = 可以审批业务审批单
//      两者互相独立：拥有其一不会自动获得另一个。业务路由里禁止再写
//      「RBAC 权限 + 角色名」这样的第二层判断 —— 角色该不该有某能力，
//      一律通过修改本文件的 ROLE_GRANTS 配置来表达。
//
// ⚠️ 关于 admin（重要，勿误解）：
//   admin 是**系统超级管理员 / 运维角色，不是正常业务运营角色**。
//   为向后兼容，admin 保留现有会员/积分/审核/商城等业务权限，
//   仅供系统运维与故障处理使用。**这不是让其他角色去继承 admin 的业务权限** ——
//   其余角色的权限都在 ROLE_GRANTS 里独立定义。
//   后续正常业务由 owner / hq_operator / philippines_manager / regional_manager /
//   store_manager / sales / warehouse / service 承担。
//   将来若确认 admin 不再需要某些业务权限，应单独做收敛，不属于本次范围。
// ============================================================

// ---------- 数据范围 ----------
// 由宽到窄。用于「取最宽范围」与「范围包含」比较。
const SCOPES = ['global', 'hq', 'philippines', 'region', 'store', 'self'];

/** 范围是否更宽（a 包含 b） */
function scopeRank(s) {
  const i = SCOPES.indexOf(s);
  return i === -1 ? -1 : i;
}

// ---------- 权限清单 ----------
// 命名规则：resource.action
const PERMISSIONS = [
  // 经营
  'dashboard.view',
  // NSS Solar V2 管理域与独立业务审批引擎
  'org.view', 'org.manage', 'warehouse.view', 'warehouse.manage',
  'workflow.view', 'workflow.create', 'workflow.approve', 'workflow.configure', 'workflow.execute',
  'announcement.manage',
  // 门店
  'store.view', 'store.create', 'store.edit', 'store.delete',
  // 员工（Employee 档案，Step 3 建表后启用）
  'staff.view', 'staff.create', 'staff.edit', 'staff.delete', 'staff.assign', 'staff.appraise',
  // 会员
  'member.view', 'member.create', 'member.edit', 'member.delete',
  'member.manage',   // 字段级完全控制：type / spend / storeId / status / level
  // 积分
  'points.view', 'points.grant', 'points.deduct', 'points.adjust',
  // 直接发放积分（不进审批流）。
  // ⚠ 与 approval.approve 是两个独立能力，互不继承、互不隐式绑定：
  //   · 有 points.grant.direct → 可以直发积分
  //   · 有 approval.approve    → 只表示能审批业务审批单
  //   两者可以同时拥有，也可以只拥有其一，由 ROLE_GRANTS 显式配置。
  'points.grant.direct',
  'points.rule.edit', 'points.expiry.scan',
  // 积分审核
  'approval.view', 'approval.create', 'approval.approve', 'approval.reject',
  // 积分商城
  'mall.view', 'mall.create', 'mall.edit', 'mall.delete',
  'mall.redeem', 'mall.fulfill', 'mall.cancel',
  // CRM（Step 4）
  'crm.view', 'crm.create', 'crm.edit', 'crm.delete',
  // 运营任务
  'task.view', 'task.create', 'task.edit', 'task.assign', 'task.close',
  // 采购跟单（2026-10-07新增）。
  // 采购批次是集团级单据，不挂门店/区域，故范围一律 global（见下方 purchaser 角色说明）。
  'purchase.view', 'purchase.create', 'purchase.edit',
  // 运营异常
  'alert.view', 'alert.create', 'alert.assign', 'alert.escalate', 'alert.close',
  // 报表
  'report.view', 'report.export',
  // 售后（二阶段启用）
  'aftersales.view', 'aftersales.create', 'aftersales.edit', 'aftersales.close',
  // SOP / 培训（二阶段启用）
  'training.view', 'training.create', 'training.edit',
  // 金蝶数据（只读消费，绝不回写）
  'kingdee.view', 'kingdee.edit',
  // 系统管理（仅 admin）
  'system.user.view', 'system.user.edit', 'system.role.manage',
  'system.config.edit', 'system.audit.view',
  // 云同步
  'sync.view', 'sync.config', 'sync.run',
  // 数据主库
  'db.view', 'db.export',
];

// ---------- 角色 → 权限授予（含各自的 Data Scope）----------
// 每一项 { p: 权限, s: 数据范围 }
const ROLE_GRANTS = {
  // ── admin：系统/运维。保留全部业务权限仅用于故障处理，其他角色不继承它。
  //    唯一例外：kingdee.edit 不授予 —— 金蝶是主系统，新系统只读消费、绝不回写，
  //    这条对**所有角色**成立，admin 也不例外。
  admin: PERMISSIONS
    .filter(p => p !== 'kingdee.edit')
    .map(p => ({ p, s: 'global' })),

  // ── purchaser：采购跟单（2026-10-07 新增）。
  //    职责：跟进国内订单与海运进度，需要「实时更新」，故有 purchase.edit。
  //    ⚠ 范围一律 global：采购批次是集团级单据，不绑定门店 / 区域，
  //      checkPerm 时没有 storeId / regionId 资源对象可比 —— 若授予
  //      philippines / region / store 等范围，范围标注会变成一句空话
  //      （与下方system.* / rules.json 同理，见文件头 ④.b 条）。
  //    能看到全部在途批次（业务上就需要看全港），但不能改审批、
  //      不能改积分、不能碰系统与数据主库。
  purchaser: [
    { p: 'dashboard.view', s: 'global' },
    { p: 'purchase.view', s: 'global' },
    { p: 'purchase.create', s: 'global' },
    { p: 'purchase.edit', s: 'global' },
    { p: 'announcement.view', s: 'global' },
    { p: 'org.view', s: 'global' },
    { p: 'store.view', s: 'philippines' },
    { p: 'task.view', s: 'global' },
    { p: 'workflow.view', s: 'global' },
    { p: 'alert.view', s: 'global' },
    { p: 'report.view', s: 'global' },
  ],

  // ── owner：经营决策与经营查看。无 system / db / sync。
  owner: [
    { p: 'announcement.manage', s: 'global' },
    { p: 'dashboard.view', s: 'global' },
    { p: 'org.view', s: 'global' }, { p: 'warehouse.view', s: 'global' },
    { p: 'workflow.view', s: 'global' }, { p: 'workflow.approve', s: 'global' },
    { p: 'store.view', s: 'global' },
    { p: 'staff.view', s: 'global' },
    { p: 'member.view', s: 'global' },
    { p: 'points.view', s: 'global' },
    { p: 'crm.view', s: 'global' },
    { p: 'report.view', s: 'global' },
    { p: 'report.export', s: 'global' },
    { p: 'aftersales.view', s: 'global' },
    { p: 'kingdee.view', s: 'global' },
    { p: 'task.create', s: 'global' },
    { p: 'alert.view', s: 'global' },
    { p: 'alert.create', s: 'global' },
    { p: 'alert.escalate', s: 'global' },
    { p: 'approval.view', s: 'global' },
    // 采购进度对经营决策可见，但 owner 不改采购单（由采购员维护）
    { p: 'purchase.view', s: 'global' },
  ],

  // ── hq_operator：看数据、定标准、发现问题、发起任务、跟踪结果。
  //    不能改员工 / 不能审批 / 不能关异常（边界控制点，见下方注释）。
  hq_operator: [
    { p: 'announcement.manage', s: 'global' },
    { p: 'dashboard.view', s: 'philippines' },
    { p: 'org.view', s: 'philippines' }, { p: 'warehouse.view', s: 'philippines' },
    { p: 'workflow.view', s: 'philippines' },
    { p: 'store.view', s: 'philippines' },
    { p: 'staff.view', s: 'philippines' },          // 可看
    // staff.edit / assign / appraise 刻意不授予 —— 总部不直接管一线人员
    { p: 'member.view', s: 'philippines' },
    { p: 'points.view', s: 'philippines' },
    // points.adjust 刻意不授予 —— 改积分余额是纠偏，收在菲律宾负责人
    { p: 'crm.view', s: 'philippines' },
    { p: 'report.view', s: 'philippines' },
    { p: 'report.export', s: 'philippines' },
    { p: 'aftersales.view', s: 'philippines' },
    { p: 'kingdee.view', s: 'philippines' },
    { p: 'approval.view', s: 'philippines' },
    // 采购进度只读可见：知道在途批次与预计到货，便于安排到货后的工作
    { p: 'purchase.view', s: 'global' },
    // approve / reject 刻意不授予 —— 总部不直接裁决一线业务
    { p: 'task.view', s: 'philippines' },
    { p: 'task.create', s: 'philippines' },
    { p: 'task.edit', s: 'philippines' },
    { p: 'task.assign', s: 'philippines' },
    // task.close 刻意不授予
    { p: 'alert.view', s: 'philippines' },
    { p: 'alert.create', s: 'philippines' },
    { p: 'alert.assign', s: 'philippines' },
    { p: 'alert.escalate', s: 'philippines' },
    // alert.close 刻意不授予 —— 总部只能升级与跟踪
  ],

  // ── philippines_manager：菲律宾业务运营负责人。
  //    管业务，不管系统（无 system / db / sync），范围固定 PH。
  philippines_manager: [
    { p: 'announcement.manage', s: 'global' },
    { p: 'dashboard.view', s: 'philippines' },
    { p: 'org.view', s: 'philippines' }, { p: 'warehouse.view', s: 'philippines' },
    { p: 'warehouse.manage', s: 'philippines' },
    { p: 'workflow.view', s: 'philippines' }, { p: 'workflow.create', s: 'philippines' },
    { p: 'workflow.approve', s: 'philippines' }, { p: 'workflow.execute', s: 'philippines' },
    { p: 'store.view', s: 'philippines' },
    { p: 'store.create', s: 'philippines' },
    { p: 'store.edit', s: 'philippines' },
    { p: 'store.delete', s: 'philippines' },
    { p: 'staff.view', s: 'philippines' },
    { p: 'staff.create', s: 'philippines' },
    { p: 'staff.edit', s: 'philippines' },
    { p: 'staff.delete', s: 'philippines' },
    { p: 'staff.assign', s: 'philippines' },
    { p: 'staff.appraise', s: 'philippines' },
    { p: 'member.view', s: 'philippines' },
    { p: 'member.create', s: 'philippines' },
    { p: 'member.edit', s: 'philippines' },
    { p: 'member.delete', s: 'philippines' },
    { p: 'member.manage', s: 'philippines' },
    { p: 'points.view', s: 'philippines' },
    { p: 'points.grant', s: 'philippines' },
    { p: 'points.deduct', s: 'philippines' },
    { p: 'points.adjust', s: 'philippines' },
    // 菲律宾负责人是审批人，直发积分不需要再提交给自己审批
    { p: 'points.grant.direct', s: 'philippines' },
    // ⚠ points.rule.edit / points.expiry.scan **刻意不授予 philippines_manager**：
    //   它们操作的是 data/rules.json —— 全连锁共用的**全局单例配置**，
    //   没有 store / region / philippines 资源对象可供范围比较，
    //   因此 checkPerm 只会判「有没有权限」，不会判范围。
    //   若授予任何一个非 global 角色，就等于让它改全连锁积分规则（例如把
    //   每 ₱10 得 1 分改成每 ₱1 得 1 分，返利直接放大 10 倍）。
    //   这两个能力**只属于 admin（global）**。
    { p: 'approval.view', s: 'philippines' },
    { p: 'approval.create', s: 'philippines' },
    { p: 'approval.approve', s: 'philippines' },
    { p: 'approval.reject', s: 'philippines' },
    { p: 'mall.view', s: 'philippines' },
    { p: 'mall.create', s: 'philippines' },
    { p: 'mall.edit', s: 'philippines' },
    { p: 'mall.delete', s: 'philippines' },
    { p: 'mall.redeem', s: 'philippines' },
    { p: 'mall.fulfill', s: 'philippines' },
    { p: 'mall.cancel', s: 'philippines' },
    { p: 'crm.view', s: 'philippines' },
    { p: 'crm.create', s: 'philippines' },
    { p: 'crm.edit', s: 'philippines' },
    { p: 'crm.delete', s: 'philippines' },
    { p: 'task.view', s: 'philippines' },
    { p: 'task.create', s: 'philippines' },
    { p: 'task.edit', s: 'philippines' },
    { p: 'task.assign', s: 'philippines' },
    { p: 'task.close', s: 'philippines' },
    { p: 'alert.view', s: 'philippines' },
    { p: 'alert.create', s: 'philippines' },
    { p: 'alert.assign', s: 'philippines' },
    { p: 'alert.escalate', s: 'philippines' },
    { p: 'alert.close', s: 'philippines' },
    { p: 'report.view', s: 'philippines' },
    { p: 'report.export', s: 'philippines' },
    { p: 'aftersales.view', s: 'philippines' },
    { p: 'aftersales.create', s: 'philippines' },
    { p: 'aftersales.edit', s: 'philippines' },
    { p: 'aftersales.close', s: 'philippines' },
    { p: 'training.view', s: 'philippines' },
    { p: 'training.create', s: 'philippines' },
    { p: 'training.edit', s: 'philippines' },
    { p: 'kingdee.view', s: 'philippines' },   // kingdee.edit 对所有角色都不开放
    // 采购进度只读：掌握在途批次与预计到港，便于安排收货与验收
    { p: 'purchase.view', s: 'global' },
  ],

  // ── regional_manager：全国区域负责人（此角色现为「全国唯一」）。
  //    2026-09-22 组织架构调整：数据范围由 region 提升为 philippines
  //    —— 全国只保留 1 名负责人，需管辖全部区域/门店。
  //    历史范围调整不赋予旧积分审批或系统管理能力；V2 流程权限单独列出。
  //    依旧没有 approval.approve / points.rule.edit /
  //      points.grant.direct / mall.cancel，也没有任何 system.* / db.* / sync.*）。
  //    仍不能审批、不能改积分余额、不能删会员/门店。
  regional_manager: [
    { p: 'dashboard.view', s: 'philippines' },
    { p: 'org.view', s: 'philippines' }, { p: 'warehouse.view', s: 'philippines' },
    { p: 'workflow.view', s: 'philippines' }, { p: 'workflow.create', s: 'philippines' },
    { p: 'workflow.execute', s: 'philippines' },
    { p: 'store.view', s: 'philippines' },
    { p: 'store.edit', s: 'philippines' },
    { p: 'staff.view', s: 'philippines' },
    { p: 'staff.edit', s: 'philippines' },
    { p: 'staff.assign', s: 'philippines' },
    { p: 'staff.appraise', s: 'philippines' },
    { p: 'member.view', s: 'philippines' },
    { p: 'member.create', s: 'philippines' },
    { p: 'member.edit', s: 'philippines' },
    { p: 'points.view', s: 'philippines' },
    { p: 'points.grant', s: 'philippines' },
    { p: 'points.deduct', s: 'philippines' },
    { p: 'approval.view', s: 'philippines' },
    { p: 'approval.create', s: 'philippines' },
    { p: 'mall.view', s: 'philippines' },
    { p: 'mall.redeem', s: 'philippines' },
    { p: 'mall.fulfill', s: 'philippines' },
    { p: 'crm.view', s: 'philippines' },
    { p: 'crm.create', s: 'philippines' },
    { p: 'crm.edit', s: 'philippines' },
    { p: 'task.view', s: 'philippines' },
    { p: 'task.create', s: 'philippines' },
    { p: 'task.edit', s: 'philippines' },
    { p: 'task.assign', s: 'philippines' },
    { p: 'task.close', s: 'philippines' },
    { p: 'alert.view', s: 'philippines' },
    { p: 'alert.create', s: 'philippines' },
    { p: 'alert.assign', s: 'philippines' },
    { p: 'alert.escalate', s: 'philippines' },
    { p: 'alert.close', s: 'philippines' },
    { p: 'report.view', s: 'philippines' },
    { p: 'aftersales.view', s: 'philippines' },
    { p: 'aftersales.create', s: 'philippines' },
    { p: 'aftersales.edit', s: 'philippines' },
    { p: 'aftersales.close', s: 'philippines' },
    { p: 'training.view', s: 'philippines' },
    { p: 'kingdee.view', s: 'philippines' },
  ],

  // ── store_manager：只管本店。不能改门店配置、不能改员工档案、不能审批、不能删会员。
  store_manager: [
    { p: 'dashboard.view', s: 'store' },
    { p: 'org.view', s: 'store' }, { p: 'warehouse.view', s: 'store' },
    { p: 'workflow.view', s: 'store' }, { p: 'workflow.create', s: 'store' },
    { p: 'workflow.execute', s: 'self' },
    { p: 'store.view', s: 'store' },
    { p: 'staff.view', s: 'store' },
    { p: 'staff.assign', s: 'store' },
    { p: 'staff.appraise', s: 'store' },
    { p: 'member.view', s: 'store' },
    { p: 'member.create', s: 'store' },
    { p: 'member.edit', s: 'store' },
    { p: 'points.view', s: 'store' },
    { p: 'points.grant', s: 'store' },
    { p: 'points.deduct', s: 'store' },
    { p: 'approval.view', s: 'store' },
    { p: 'approval.create', s: 'store' },
    { p: 'mall.view', s: 'store' },
    { p: 'mall.redeem', s: 'store' },
    { p: 'mall.fulfill', s: 'store' },
    { p: 'mall.cancel', s: 'store' },
    { p: 'crm.view', s: 'store' },
    { p: 'crm.create', s: 'store' },
    { p: 'crm.edit', s: 'store' },
    { p: 'task.view', s: 'store' },
    { p: 'task.create', s: 'store' },
    { p: 'task.edit', s: 'store' },
    { p: 'task.assign', s: 'store' },
    { p: 'task.close', s: 'store' },
    { p: 'alert.view', s: 'store' },
    { p: 'alert.create', s: 'store' },
    { p: 'alert.assign', s: 'store' },
    { p: 'alert.escalate', s: 'store' },
    { p: 'alert.close', s: 'store' },
    { p: 'report.view', s: 'store' },
    { p: 'aftersales.view', s: 'store' },
    { p: 'aftersales.create', s: 'store' },
    { p: 'aftersales.edit', s: 'store' },
    { p: 'aftersales.close', s: 'store' },
    { p: 'training.view', s: 'store' },
    { p: 'kingdee.view', s: 'store' },
  ],

  // ── sales：本店数据只读，自己的客户/任务 self（混合范围，见上）。
  sales: [
    { p: 'dashboard.view', s: 'self' },
    { p: 'workflow.view', s: 'self' }, { p: 'workflow.execute', s: 'self' },
    { p: 'member.view', s: 'store' },
    { p: 'points.view', s: 'store' },
    { p: 'mall.view', s: 'store' },
    { p: 'crm.view', s: 'self' },
    { p: 'crm.create', s: 'self' },
    { p: 'crm.edit', s: 'self' },
    { p: 'task.view', s: 'self' },
    { p: 'task.edit', s: 'self' },
    { p: 'task.close', s: 'self' },
    { p: 'report.view', s: 'self' },
  ],

  // ── warehouse：库存（金蝶）只读 + 自己的任务。
  warehouse: [
    { p: 'dashboard.view', s: 'store' },
    { p: 'workflow.view', s: 'self' }, { p: 'workflow.execute', s: 'self' },
    { p: 'member.view', s: 'store' },
    { p: 'points.view', s: 'store' },
    { p: 'mall.view', s: 'store' },
    { p: 'task.view', s: 'self' },
    { p: 'task.edit', s: 'self' },
    { p: 'task.close', s: 'self' },
    { p: 'alert.view', s: 'store' },
    { p: 'report.view', s: 'store' },
    { p: 'kingdee.view', s: 'store' },
  ],

  // ── service：售后工单（自己的）+ 只读会员。
  service: [
    { p: 'dashboard.view', s: 'store' },
    { p: 'workflow.view', s: 'self' }, { p: 'workflow.execute', s: 'self' },
    { p: 'member.view', s: 'store' },
    { p: 'points.view', s: 'store' },
    { p: 'aftersales.view', s: 'store' },
    { p: 'aftersales.create', s: 'self' },
    { p: 'aftersales.edit', s: 'self' },
    { p: 'aftersales.close', s: 'self' },
    { p: 'task.view', s: 'self' },
    { p: 'task.edit', s: 'self' },
    { p: 'task.close', s: 'self' },
    { p: 'alert.view', s: 'store' },
    { p: 'report.view', s: 'store' },
  ],
};

// ---------- 指派规则（表驱动，新增角色只改这张表）----------
// 指派者角色 → 允许被指派的目标角色
const ASSIGNMENT_RULES = {
  hq_operator: ['philippines_manager', 'regional_manager'],   // 总部不直接派给店员
  philippines_manager: ['regional_manager', 'store_manager', 'sales', 'warehouse', 'service'],
  regional_manager: ['store_manager', 'sales', 'warehouse', 'service'],
  store_manager: ['sales', 'warehouse', 'service'],
  owner: ['philippines_manager'],
  admin: [],                                                   // 系统角色不参与业务指派
  sales: [], warehouse: [], service: [], purchaser: [],
};

// ---------- 旧角色兼容映射 ----------
// 现有 users.role 只有 admin / manager。不改密码、不改用户名、不破坏数据。
const LEGACY_ROLE_MAP = {
  admin: 'admin',
  manager: 'store_manager',
};

const ROLES = Object.keys(ROLE_GRANTS);

/**
 * 把旧角色名规范化成新角色名。
 * 未识别的值原样返回（这样 hasPermission 会返回 false，安全一侧）。
 */
function normalizeRole(role) {
  if (!role) return null;
  return LEGACY_ROLE_MAP[role] || role;
}

/** 用户上下文：把登录用户整理成判定所需的字段 */
function userContext(user) {
  if (!user) return null;
  const role = normalizeRole(user.role);
  return {
    role,
    storeId: user.storeId || null,
    regionId: user.regionId || null,
    employeeId: user.employeeId || null,
    userId: user.id || null,
  };
}

/** 某角色的全部授予 */
function grantsFor(role) {
  return ROLE_GRANTS[normalizeRole(role)] || [];
}

/**
 * 是否拥有某权限（**不判定数据范围**，只看有没有这个权限）
 */
function hasPermission(user, permission) {
  const ctx = userContext(user);
  if (!ctx || !ctx.role) return false;
  return grantsFor(ctx.role).some(g => g.p === permission);
}

/**
 * 某权限在该角色下的 Data Scope；没有该权限返回 null。
 */
function permScope(user, permission) {
  const ctx = userContext(user);
  if (!ctx || !ctx.role) return null;
  const hits = grantsFor(ctx.role).filter(g => g.p === permission);
  if (!hits.length) return null;
  // 同一权限若在多个范围被授予，取最宽的
  return hits.map(g => g.s).sort((a, b) => scopeRank(a) - scopeRank(b))[0];
}

/**
 * 资源是否落在指定范围内（**纯函数，不查库**）
 *
 * 说明：region 级判定依赖数据上的 regionId。当前数据（会员/门店）还没有该字段
 * ——Step 3 建 regions 表并给门店加上 regionId 后才会真正生效。在此之前，
 * region 级判定无法核实，一律返回 false（安全一侧，宁可拒绝）。
 */
function inScope(ctx, scopeName, resource) {
  if (!scopeName || !resource) return false;
  switch (scopeName) {
    case 'global':
    case 'hq':
      return true;
    case 'philippines':
      // 当前所有门店都在菲律宾；将来按 resource.country 判定
      if (resource.country) return resource.country === 'PH';
      return true;
    case 'region':
      if (!ctx.regionId) return false;
      if (!resource.regionId) return false;   // 数据尚无 regionId → 无法核实，拒绝
      return resource.regionId === ctx.regionId;
    case 'store':
      if (!ctx.storeId) return false;
      return !!resource.storeId && resource.storeId === ctx.storeId;
    case 'self': {
      const owners = [resource.ownerId, resource.employeeId, resource.createdBy, resource.assigneeId].filter(Boolean);
      if (!owners.length) return false;
      return owners.some(owner => owner === ctx.employeeId || owner === ctx.userId);
    }
    default:
      return false;
  }
}

/**
 * 核心判定：这个用户有没有资格执行这个 Action？
 *
 * L1：只看角色与权限表 + 数据范围，
 *     **不看资源当前状态**（那是 L2 业务守卫的事，如 approvals.canDecide）。
 *
 * @param {object} user      登录用户
 * @param {string} permission 如 'member.edit'
 * @param {object} [resource] 目标资源（可选）。不传则只做权限判定。
 *   资源可含 { storeId, regionId, ownerId, employeeId, createdBy, assigneeId, country }
 */
function can(user, permission, resource) {
  const ctx = userContext(user);
  if (!ctx || !ctx.role) return false;
  const scopeName = permScope(user, permission);
  if (!scopeName) return false;                 // 无此权限
  if (resource === undefined || resource === null) return true;  // 仅判权限
  return inScope(ctx, scopeName, resource);
}

/**
 * 取用户在某资源上的数据范围（用于列表查询的过滤条件）
 *
 * 后端列表接口**必须**使用它 —— 前端隐藏绝不能作为安全边界。
 * @returns {{level:string, regionId?:string|null, storeId?:string|null, employeeId?:string|null}}
 */
function getDataScope(user, resourceName) {
  const ctx = userContext(user);
  if (!ctx || !ctx.role) return { level: 'self', storeId: null, regionId: null, employeeId: null };
  const prefix = resourceName + '.';
  const hits = grantsFor(ctx.role).filter(g => g.p.indexOf(prefix) === 0);
  if (!hits.length) {
    return { level: 'none', regionId: null, storeId: null, employeeId: null };
  }
  // 同一资源上若有多档范围，取最宽的
  const level = hits.map(g => g.s).sort((a, b) => scopeRank(a) - scopeRank(b))[0];
  return {
    level,
    regionId: ctx.regionId,
    storeId: ctx.storeId,
    employeeId: ctx.employeeId || ctx.userId,
  };
}

// ---------- 字段级权限 ----------
// 替代手写 isAdmin 白名单（上一轮安全修复留下的 5 处判断）
const RESOURCE_FIELDS = {
  member: {
    base: ['name', 'phone', 'notes'],
    // 需要 member.manage 才能改的字段
    privileged: ['type', 'level', 'spend', 'storeId', 'status', 'points'],
  },
};

/**
 * 该用户在这个资源上允许写入哪些字段。
 * 业务层应只接受这些字段，避免「有 edit 权限就能改敏感字段」。
 */
function allowedFields(user, resourceName) {
  const def = RESOURCE_FIELDS[resourceName];
  if (!def) return null;             // 未定义 → 不做字段过滤
  const out = def.base.slice();
  if (hasPermission(user, resourceName + '.manage')) out.push(...def.privileged);
  return out;
}

// ---------- 指派规则判定（表驱动，无 if/else 链）----------

/** 范围 a 是否包含范围 b（用于「目标是否在我管辖内」） */
function containsScope(scopeA, scopeB) {
  return scopeRank(scopeA) <= scopeRank(scopeB);
}

/**
 * 能否把任务/异常指派给某个人？
 * ① 目标角色是否在允许清单里（查表）
 * ② 目标是否落在指派者的管辖范围内
 *
 * @returns {{ok:boolean, reason?:string}}
 */
function canAssign(actor, target, resource) {
  const a = userContext(actor);
  const t = userContext(target);
  if (!a || !a.role) return { ok: false, reason: '指派者无效' };
  if (!t || !t.role) return { ok: false, reason: '目标无效' };

  const allowed = ASSIGNMENT_RULES[a.role] || [];
  if (allowed.indexOf(t.role) === -1) {
    return { ok: false, reason: `不能指派给 ${t.role}` };
  }

  // 目标是否在我的管辖范围内（用同一个资源做范围比较）
  const actorScope = getDataScope(actor, resource || 'task');
  const targetScope = getDataScope(target, resource || 'task');
  if (!containsScope(actorScope.level, targetScope.level)) {
    return { ok: false, reason: '目标不在你的管理范围内' };
  }
  // 同为 store 级时必须同店
  if (actorScope.level === 'store' && actorScope.storeId && targetScope.storeId
      && actorScope.storeId !== targetScope.storeId) {
    return { ok: false, reason: '目标不在本店' };
  }
  return { ok: true };
}

/** 供 /api/auth/me 返回（前端据此渲染，但不作安全边界） */
function permissionsOf(user) {
  const ctx = userContext(user);
  if (!ctx || !ctx.role) return [];
  return grantsFor(ctx.role).map(g => g.p).filter((v, i, a) => a.indexOf(v) === i);
}

module.exports = {
  SCOPES, PERMISSIONS, ROLE_GRANTS, ASSIGNMENT_RULES, LEGACY_ROLE_MAP, ROLES,
  normalizeRole, userContext, grantsFor,
  hasPermission, permScope, can, getDataScope, inScope,
  allowedFields, canAssign, containsScope, permissionsOf,
};
