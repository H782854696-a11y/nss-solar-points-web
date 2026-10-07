// ============================================================
// RBAC 守卫（Express 适配层）
// ============================================================
// 为什么单独一个文件：
//   lib/rbac.js 是**已审核通过**的核心权限模型（Role/Permission/Scope 定义 + 判定函数）。
//   本文件只做「把它接到 Express 请求上」的适配，不碰模型本身。
//
// 职责边界（严格遵守 L1 / L2 分离）：
//   L1 = 本文件 + rbac.can()：只回答「这个用户有没有资格」
//   L2 = 业务状态守卫（approvals.canDecide / mall.canFulfill 等）：只回答「资源现在能不能」
//   两者互不越界 —— 本文件**绝不**检查资源当前状态。
//
// Data Scope 是真正的安全边界：列表过滤与单条访问都必须走这里，
// 前端隐藏按钮仅用于体验，绝不能作为安全依据。
// ============================================================
const rbac = require('./rbac');

let resolveUser = null;
let resolveRegionOfStore = null;

/**
 * 注入「从请求取登录用户」的函数（由 server.js 传入 getSessionUser，
 * 避免本模块反向依赖 server.js 造成循环引用）。
 */
function configure(fn) {
  resolveUser = fn;
}

/**
 * 注入「门店区域索引」的提供函数（由 server.js 传入，**返回 Map<storeId, regionId>**）。
 *
 * 为什么需要：region 级范围判定要比较 `item.regionId`，但**会员 / 流水等业务对象
 * 只带 storeId，没有 regionId** —— 它们的区域归属是从所属门店派生的。
 * 若不注入，区域负责人查会员/流水会拿到空列表（区域负责人角色形同不可用）。
 *
 * ⚠️ 提供函数返回 Map 而不是逐条查询：filterList 内部**只在一次调用里构建一次索引**，
 *    避免退化成「每条记录都读一遍门店表」的 O(n×m)。
 */
function configureRegionResolver(fn) {
  resolveRegionOfStore = fn;
}

/** 取一次门店→区域索引（拿不到就返回空 Map，后续判定一律视为不在范围内） */
function storeRegionIndex() {
  if (!resolveRegionOfStore) return null;
  try { return resolveRegionOfStore() || null; } catch (e) { return null; }
}

/**
 * 取某条记录的区域归属：优先自身字段，其次由所属门店派生。
 * 两者都拿不到 → null（判定时视为「不在范围内」，安全一侧）。
 */
function regionOf(item, index) {
  if (!item) return null;
  if (item.regionId) return item.regionId;
  const idx = index || storeRegionIndex();
  if (item.storeId && idx) return idx.get(item.storeId) || null;
  return null;
}

function current(req) {
  return resolveUser ? resolveUser(req) : null;
}

/**
 * 为「只有 storeId、没有 regionId」的资源补上区域归属，供 rbac.can() 的 region 判定使用。
 *
 * 为什么需要：会员 / 流水 / 兑换单 / 待审核 这些业务对象只带 storeId，
 * 而 rbac.inScope() 在 region 分支上要求 resource.regionId 存在，否则一律拒绝。
 * 结果是「列表能看（filterList 会派生区域）、单条却被拒」—— region 范围的角色实际不可用。
 * 这里复用与 filterList 完全相同的派生逻辑（regionOf），让两条路径口径一致。
 *
 * 严格保持 fail-closed（任何一个条件不满足都不补，交由 rbac 判为「不在范围内」）：
 *   · 资源本身已有 regionId  → 原样使用，绝不覆盖
 *   · 资源没有 storeId       → 无法派生，不补
 *   · 门店表里查不到该门店   → 不补
 *   · 该门店自身没有 regionId → 不补
 *
 * 只影响 region 分支：store / self 的判定不看 regionId，
 * philippines 只看 country，global / hq 直接放行 —— 都不会因此扩大访问范围。
 */
function enrichScope(resource) {
  if (!resource || typeof resource !== 'object') return resource;
  if (resource.regionId) return resource;      // 已有归属，原样使用
  if (!resource.storeId) return resource;      // 没有门店，无从派生
  const derived = regionOf(resource);          // 复用既有派生逻辑（内部自建门店索引）
  if (!derived) return resource;               // 门店查不到 / 门店无区域 → 保持原样 → 判定为范围外
  return Object.assign({}, resource, { regionId: derived });
}

/**
 * 权限 + 数据范围校验。
 * 失败时自动响应 401/403，并返回 false —— 调用方写成：
 *   if (!guard.check(req, res, 'member.edit', m)) return;
 *
 * @param {object} [resource] 目标资源（含 storeId / regionId / ownerId 等）。
 *                 不传则只判权限。
 */
function check(req, res, permission, resource) {
  const u = current(req);
  if (!u) { res.status(401).json({ error: '未登录' }); return false; }
  // region 范围的资源需要从门店派生区域；其他范围不看 regionId，
  // 因此不做无谓的门店表读取（store / self / global / hq / philippines 分支一律跳过）。
  const target = (resource && rbac.permScope(u, permission) === 'region')
    ? enrichScope(resource)
    : resource;
  if (!rbac.can(u, permission, target)) {
    res.status(403).json({ error: '无权限执行此操作' });
    return false;
  }
  return true;
}

/** 只判权限（列表 / 创建等没有具体目标资源的场景） */
function checkPerm(req, res, permission) {
  return check(req, res, permission, undefined);
}

/** 取资源族或某一具体权限的数据范围（供列表过滤与创建时绑定） */
function scopeOf(req, resourceName) {
  const user = current(req);
  // Callers may request the scope of one permission (workflow.create) or the
  // broadest scope of a resource family (workflow). Keep the two distinct.
  if (rbac.PERMISSIONS.includes(resourceName)) {
    const ctx = rbac.userContext(user);
    return {
      level: rbac.permScope(user, resourceName) || 'none',
      regionId: ctx?.regionId || null,
      storeId: ctx?.storeId || null,
      employeeId: ctx?.employeeId || ctx?.userId || null,
    };
  }
  return rbac.getDataScope(user, resourceName);
}

/**
 * 按数据范围过滤列表 —— **后端强制**，前端过滤不算数。
 * @returns {Array} 该用户可见的记录
 */
function filterList(list, req, resourceName) {
  const sc = scopeOf(req, resourceName);
  const arr = Array.isArray(list) ? list : [];

  switch (sc.level) {
    case 'global':
    case 'hq':
      return arr;
    case 'philippines':
      // 中菲隔离 fail-closed（2026-10-08 审计 C-1）：缺 country 字段的记录
      // 对菲方不可见，而非默认放行。写入侧已补 country，此处严格比较。
      return arr.filter(x => x.country === 'PH');
    case 'region': {
      // 数据尚无 regionId 时，退化为「按所属门店的区域」判定；
      // 两者都拿不到归属 → 视为不在范围内（安全一侧，宁可不给）
      if (!sc.regionId) return [];
      const idx = storeRegionIndex();   // 一次构建，供本次全部记录复用
      return arr.filter(x => regionOf(x, idx) === sc.regionId);
    }
    case 'store':
      if (!sc.storeId) return [];
      return arr.filter(x => x.storeId === sc.storeId);
    case 'self': {
      const who = sc.employeeId;
      if (!who) return [];
      return arr.filter(x =>
        x.ownerId === who || x.employeeId === who ||
        x.createdBy === who || x.assigneeId === who);
    }
    default:  // 'none' 或未识别
      return [];
  }
}

module.exports = {
  configure, configureRegionResolver, regionOf,
  current, check, checkPerm, scopeOf, filterList,
};
