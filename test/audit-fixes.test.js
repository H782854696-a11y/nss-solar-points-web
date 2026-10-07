'use strict';

// 2026-10-08 技术审计修复回归测试
// 覆盖：
//   C-1 菲律宾范围 fail-closed（rbac.inScope / rbac-guard.filterList）
//   H-4 工作流 cancel 状态机收严（approved 后不可撤回 + 撤回清执行字段）
//   （H-3 会签去重在 server.js 路由层，由 purchase-tracking / v2-remediation 的端到端覆盖）

const test = require('node:test');
const assert = require('node:assert/strict');
const rbac = require('../lib/rbac');
const controlCenter = require('../lib/control-center');

// ── C-1：philippines 范围 fail-closed ──
test('C-1 philippines scope is fail-closed', () => {
  const phUser = { id: 'ph1', role: 'philippines_manager', storeId: null };
  // 缺 country 字段 → 拒绝（旧行为是放行，这是审计 C-1 的核心）
  assert.equal(rbac.can(phUser, 'member.view', { id: 'm1', storeId: 'S1' }), false, 'missing country must be denied');
  // country = PH → 放行
  assert.equal(rbac.can(phUser, 'member.view', { id: 'm1', storeId: 'S1', country: 'PH' }), true, 'PH record visible');
  // country = CN → 拒绝（中菲隔离）
  assert.equal(rbac.can(phUser, 'member.view', { id: 'm1', storeId: 'S1', country: 'CN' }), false, 'CN record hidden from PH manager');
  // admin（global）不受 country 影响
  const admin = { id: 'a1', role: 'admin', storeId: null };
  assert.equal(rbac.can(admin, 'member.view', { id: 'm1', storeId: 'S1' }), true, 'global admin sees everything');
  // store_manager 走 store 范围，不受 country 影响
  const mgr = { id: 's1', role: 'store_manager', storeId: 'S1' };
  assert.equal(rbac.can(mgr, 'member.edit', { id: 'm1', storeId: 'S1' }), true, 'store scope unaffected by country');
});

// ── C-1：countryOf 回填推导（通过 seed.js 的纯函数验证）──
test('C-1 countryOf derives from region/store/org chain', () => {
  const seed = require('../lib/seed');
  const regionIndex = new Map([['r1', 'PH']]);
  const storeIndex = new Map([['s1', 'r1']]);
  const orgIndex = new Map([['o1', 'CN']]);
  // 有 regionId → 直接取 region
  assert.equal(seed.countryOf({ regionId: 'r1' }, regionIndex, storeIndex, orgIndex), 'PH');
  // 有 storeId → 沿 store → region
  assert.equal(seed.countryOf({ storeId: 's1' }, regionIndex, storeIndex, orgIndex), 'PH');
  // 有 organizationId → 取 org
  assert.equal(seed.countryOf({ organizationId: 'o1' }, regionIndex, storeIndex, orgIndex), 'CN');
  // 已有 country → 原样返回，不被覆盖
  assert.equal(seed.countryOf({ country: 'CN', storeId: 's1' }, regionIndex, storeIndex, orgIndex), 'CN');
  // 都拿不到 → null
  assert.equal(seed.countryOf({}, regionIndex, storeIndex, orgIndex), null);
});

// ── H-4：cancel 状态机收严 ──
test('H-4 cancel is restricted to pre-approval states', () => {
  const base = { type: 'stocktake', currentStep: 0, approvalSteps: [{ mode: 'any', approvers: [] }] };
  // pending_approval 可撤回
  const pending = controlCenter.applyTransition({ ...base, status: 'pending_approval' }, 'cancel', { actorId: 'u1' });
  assert.equal(pending.ok, true);
  assert.equal(pending.value.status, 'cancelled');
  // approved 不可撤回（旧行为允许，审计 H-4 收严）
  const approved = controlCenter.applyTransition({ ...base, status: 'approved', assigneeId: 'exec', assigneeName: '执行人', executionStatus: 'in_progress' }, 'cancel', { actorId: 'u1' });
  assert.equal(approved.ok, false, 'approved workflow must not be cancellable');
  assert.match(approved.error, /不可撤回/);
  // execution_pending 不可撤回
  const executing = controlCenter.applyTransition({ ...base, status: 'execution_pending' }, 'cancel', { actorId: 'u1' });
  assert.equal(executing.ok, false);
  // completed 不可撤回
  const completed = controlCenter.applyTransition({ ...base, status: 'completed' }, 'cancel', { actorId: 'u1' });
  assert.equal(completed.ok, false);
});

test('H-4 cancel clears execution fields', () => {
  const dirty = {
    type: 'store_remediation', status: 'pending_approval', currentStep: 0,
    approvalSteps: [{ mode: 'any', approvers: [] }],
    assigneeId: 'exec', assigneeName: '执行人', executionStatus: 'in_progress',
    executedBy: 'x', executedAt: '2026-01-01T00:00:00Z', externalDocumentNumber: 'DOC-1',
    executionRound: 3,
  };
  const result = controlCenter.applyTransition(dirty, 'cancel', { actorId: 'u1' });
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'cancelled');
  // 执行侧字段全部清空，避免残留脏状态
  assert.equal(result.value.assigneeId, null);
  assert.equal(result.value.assigneeName, null);
  assert.equal(result.value.executionStatus, null);
  assert.equal(result.value.executedBy, null);
  assert.equal(result.value.executedAt, null);
  assert.equal(result.value.externalDocumentNumber, null);
  assert.equal(result.value.executionRound, 1);
});
