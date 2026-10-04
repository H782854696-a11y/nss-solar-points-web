// 积分商城：商品与兑换单。
//
// 设计约定：
// 1. 兑换是**扣分**（走 ledger 的 deductPoints），所以兑换那一刻积分就真的没了；
//    之后的「已发放」只是履约状态，不影响账目。取消兑换才会把积分退回去。
// 2. 商品不做库存（2026-09-19 用户决定），只做展示；下架用 active=false 软删除，
//    避免历史兑换单找不到商品名。
// 3. 本模块是纯函数，落盘由 server.js 负责。

const MAX_NAME = 60;
const MAX_DESC = 300;
const MAX_POINTS = 10000000;

const REDEEM_STATUS = { PENDING: 'pending', FULFILLED: 'fulfilled', CANCELLED: 'cancelled' };

function validateProduct(input = {}) {
  const name = String(input.name == null ? '' : input.name).trim();
  if (!name) return { ok: false, error: '请填写商品名称' };
  if (name.length > MAX_NAME) return { ok: false, error: `商品名称过长（最多 ${MAX_NAME} 字）` };

  const description = String(input.description == null ? '' : input.description).trim();
  if (description.length > MAX_DESC) return { ok: false, error: `商品描述过长（最多 ${MAX_DESC} 字）` };

  const pts = Number(input.points);
  if (!(pts > 0)) return { ok: false, error: '请填写正确的所需积分' };
  if (!Number.isInteger(pts)) return { ok: false, error: '所需积分必须是整数' };
  if (pts > MAX_POINTS) return { ok: false, error: '所需积分过大，请核对' };

  return { ok: true, value: { name, description, points: pts } };
}

function buildProduct(input, id, nowIso) {
  const v = validateProduct(input);
  if (!v.ok) return v;
  const sort = Number(input.sort);
  return {
    ok: true,
    value: {
      id,
      name: v.value.name,
      description: v.value.description,
      points: v.value.points,
      image: input.image || null,
      active: input.active !== false,
      sort: Number.isFinite(sort) ? sort : 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  };
}

/** 局部更新：只覆盖传进来的字段，未传的保持原值 */
function patchProduct(existing, input, nowIso) {
  const v = validateProduct({ ...existing, ...input });
  if (!v.ok) return v;
  const sort = Number(input.sort);
  return {
    ok: true,
    value: {
      ...existing,
      name: v.value.name,
      description: v.value.description,
      points: v.value.points,
      image: input.image === undefined ? existing.image : (input.image || null),
      active: input.active === undefined ? existing.active !== false : input.active !== false,
      sort: input.sort === undefined ? existing.sort : (Number.isFinite(sort) ? sort : 0),
      updatedAt: nowIso,
    },
  };
}

/** 会员能不能用积分换这个商品 */
function validateRedeem(member, product) {
  if (!member) return { ok: false, error: '会员不存在' };
  if (!product) return { ok: false, error: '商品不存在或已下架' };
  if (product.active === false) return { ok: false, error: '该商品已下架' };
  if (member.status === 'frozen') return { ok: false, error: '该会员已冻结，无法兑换' };

  const need = Number(product.points) || 0;
  const balance = Number(member.points) || 0;
  if (balance < need) {
    return { ok: false, error: `积分不足（当前 ${balance} 分，需要 ${need} 分）`, short: need - balance };
  }
  return { ok: true, value: { points: need } };
}

function buildRedemption(member, product, user, id, nowIso, transactionId) {
  return {
    id,
    productId: product.id,
    productName: product.name,
    productImage: product.image || null,
    points: Number(product.points) || 0,
    memberId: member.id,
    memberName: member.name,
    memberPhone: member.phone || '',
    storeId: member.storeId,
    storeName: member.storeName,
    status: REDEEM_STATUS.PENDING,
    transactionId: transactionId || null,
    createdBy: user.id,
    createdByName: user.name || user.username,
    createdAt: nowIso,
    fulfilledBy: null,
    fulfilledByName: null,
    fulfilledAt: null,
    cancelledBy: null,
    cancelledByName: null,
    cancelledAt: null,
    refundTransactionId: null,
  };
}

function canFulfill(rec) {
  if (!rec) return { ok: false, error: '兑换单不存在' };
  if (rec.status === REDEEM_STATUS.FULFILLED) return { ok: false, error: '该兑换单已发放' };
  if (rec.status === REDEEM_STATUS.CANCELLED) return { ok: false, error: '该兑换单已取消' };
  return { ok: true };
}

/** 取消会把积分退回去，所以只有未发放的单能取消 */
function canCancel(rec) {
  const c = canFulfill(rec);
  if (!c.ok) return c;
  return { ok: true };
}

/** 列表可见范围：管理员看全部，店长只看自己门店 */
function visibleFor(list, user) {
  const all = Array.isArray(list) ? list : [];
  if (!user) return [];
  if (user.role === 'admin') return all;
  return all.filter(r => r.storeId === user.storeId);
}

/** 商品卡片展示用：管理员能看见下架的，店长只看见上架的 */
function visibleProducts(list, user) {
  const all = Array.isArray(list) ? list : [];
  if (user && user.role === 'admin') return all;
  return all.filter(p => p.active !== false);
}

function sortProducts(list) {
  return (Array.isArray(list) ? list : [])
    .slice()
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0)
      || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

module.exports = {
  REDEEM_STATUS, MAX_NAME, MAX_DESC,
  validateProduct, buildProduct, patchProduct,
  validateRedeem, buildRedemption, canFulfill, canCancel,
  visibleFor, visibleProducts, sortProducts,
};
