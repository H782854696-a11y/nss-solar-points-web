'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const controlCenter = require('../lib/control-center');
const rbac = require('../lib/rbac');
const guard = require('../lib/rbac-guard');

const validStocktake = (overrides = {}) => ({
  type: 'stocktake',
  form: {
    warehouseName: 'Cebu Warehouse',
    countDate: '2026-10-04',
    reason: 'Quarterly count',
    items: [{ itemCode: 'PV-001', itemName: 'Solar panel', location: 'A-01', systemQuantity: 10, countedQuantity: 8, varianceReason: 'Damaged in transit' }],
    ...overrides,
  },
});

test('only stocktake approval and store remediation can be created', () => {
  assert.deepEqual(Object.keys(controlCenter.WORKFLOW_TYPES).sort(), ['stocktake', 'store_remediation']);
  for (const removedType of ['purchase', 'expense', 'payment', 'transfer', 'stock_adjustment', 'price_adjustment']) {
    assert.equal(controlCenter.validateWorkflow(removedType, {}).ok, false, `${removedType} must remain disabled`);
  }
});

test('stocktake validates rows and computes final count variance', () => {
  const result = controlCenter.validateWorkflow('stocktake', validStocktake().form);
  assert.equal(result.ok, true);
  assert.equal(result.value.items[0].finalQuantity, 8);
  assert.equal(result.value.items[0].differenceQuantity, -2);
  assert.equal(result.value.items[0].varianceReason, 'Damaged in transit');
});

test('stocktake rejects duplicates, unexplained variances, and more than 2,000 rows', () => {
  const base = validStocktake().form;
  const duplicate = { ...base, items: [...base.items, { ...base.items[0], itemCode: 'pv-001', location: 'a-01' }] };
  assert.match(controlCenter.validateWorkflow('stocktake', duplicate).error, /重复/);

  const unexplained = { ...base, items: [{ ...base.items[0], varianceReason: '' }] };
  assert.match(controlCenter.validateWorkflow('stocktake', unexplained).error, /差异原因/);

  const tooMany = { ...base, items: Array.from({ length: 2001 }, (_, i) => ({ itemCode: `SKU-${i}`, countedQuantity: 0 })) };
  assert.match(controlCenter.validateWorkflow('stocktake', tooMany).error, /2,000/);
});

test('workflow dates must be real calendar dates', () => {
  const invalidStocktake = validStocktake({ countDate: '2026-02-30' });
  assert.match(controlCenter.validateWorkflow('stocktake', invalidStocktake.form).error, /日期/);

  const remediation = { storeName: 'Cebu Store', issue: 'Broken signage', dueDate: '2026-10-04' };
  assert.equal(controlCenter.validateWorkflow('store_remediation', remediation).ok, true);
  assert.match(controlCenter.validateWorkflow('store_remediation', { ...remediation, dueDate: '2026-13-01' }).error, /日期/);
});

test('execution requires an external document number for stocktake', () => {
  const stocktake = { type: 'stocktake', status: 'approved' };
  const missingNumber = controlCenter.applyTransition(stocktake, 'execution', { executionStatus: 'completed' });
  assert.equal(missingNumber.ok, false);

  const completed = controlCenter.applyTransition(stocktake, 'execution', { externalDocumentNumber: 'KD-2026-001', executionStatus: 'completed' });
  assert.equal(completed.ok, true);
  assert.equal(stocktake.status, 'completed');
  assert.equal(stocktake.externalDocumentNumber, 'KD-2026-001');
});

test('remediation requires a separate reviewer and returns to execution on review return', () => {
  const remediation = { type: 'store_remediation', status: 'approved', createdBy: 'requester', assigneeId: 'assignee' };
  assert.equal(controlCenter.applyTransition(remediation, 'execution', { actorId: 'assignee', executionStatus: 'completed' }).ok, true);
  assert.equal(remediation.status, 'awaiting_review');
  assert.equal(controlCenter.canTransition(remediation, 'review_pass', { actorId: 'requester' }).ok, false);
  assert.equal(controlCenter.canTransition(remediation, 'review_pass', { actorId: 'assignee' }).ok, false);

  const returned = controlCenter.applyTransition(remediation, 'review_return', { actorId: 'independent-reviewer', note: 'Please attach the corrected photo.' });
  assert.equal(returned.ok, true);
  assert.equal(remediation.status, 'execution_pending');
  assert.equal(remediation.executionStatus, 'in_progress');
});

test('assigned frontline staff can execute their own remediation without accessing another person\'s', () => {
  const request = { type: 'store_remediation', storeId: null, createdBy: 'requester', assigneeId: 'executor', country: 'PH' };
  for (const role of ['store_manager', 'sales', 'warehouse', 'service']) {
    const executor = { id: 'executor', role, storeId: 'store-1' };
    const other = { id: 'other', role, storeId: 'store-1' };
    assert.equal(rbac.hasPermission(executor, 'workflow.view'), true, `${role} needs workflow access`);
    assert.equal(rbac.can(executor, 'workflow.execute', request), true, `${role} must execute its assigned remediation`);
    assert.equal(rbac.can(other, 'workflow.execute', request), false, `${role} must not execute another person's remediation`);
  }
});

test('scope lookup accepts both a resource family and an exact permission', () => {
  const manager = { id: 'manager-1', role: 'manager', storeId: 'store-1' };
  guard.configure(() => manager);
  assert.equal(guard.scopeOf({}, 'workflow').level, 'store');
  assert.equal(guard.scopeOf({}, 'workflow.create').level, 'store');
  assert.equal(guard.scopeOf({}, 'workflow.create').storeId, 'store-1');
  assert.equal(guard.scopeOf({}, 'task.create').level, 'store');
  assert.equal(guard.scopeOf({}, 'workflow.approve').level, 'none');
});
