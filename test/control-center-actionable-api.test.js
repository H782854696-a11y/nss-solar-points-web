'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalApp, photo } = require('./helpers/local-app');

const managerPassword = 'ManagerFixtureOnly2026!';
const managerChangedPassword = 'ManagerFixtureChanged2026!';

const stocktake = (storeId, title) => ({
  type: 'stocktake', title, images: [photo],
  form: { storeId, warehouseName: 'Fixture warehouse', countDate: '2026-10-11', reason: title, items: [{ itemCode: title, countedQuantity: 1 }] },
});

test('actionable workflow query keeps an older current-user approval when global latest ten are not actionable', { timeout: 30000 }, async t => {
  const app = await startLocalApp();
  t.after(app.close);
  const admin = await app.login('admin');
  const stores = await app.request('GET', '/api/stores', null, admin);
  assert.equal(stores.status, 200);
  const storeId = stores.data.items[0].id;
  const manager = await app.request('POST', '/api/v2/users', { username: 'older_actionable_manager', name: 'Older actionable manager', role: 'manager', storeId, password: managerPassword }, admin);
  assert.equal(manager.status, 201, JSON.stringify(manager.data));
  const managerLogin = await app.request('POST', '/api/auth/login', { username: 'older_actionable_manager', password: managerPassword });
  assert.equal(managerLogin.status, 200, JSON.stringify(managerLogin.data));
  const managerChange = await app.request('POST', '/api/auth/change-password', { currentPassword: managerPassword, newPassword: managerChangedPassword }, managerLogin.cookie);
  assert.equal(managerChange.status, 200, JSON.stringify(managerChange.data));
  const otherUserTask = await app.request('POST', '/api/v2/tasks', { title: 'Other user task', storeId }, managerChange.cookie);
  assert.equal(otherUserTask.status, 201, JSON.stringify(otherUserTask.data));
  const adminOwnTask = await app.request('POST', '/api/v2/tasks', { title: 'Admin task', storeId }, admin);
  assert.equal(adminOwnTask.status, 201, JSON.stringify(adminOwnTask.data));
  const visibleTasks = await app.request('GET', '/api/v2/tasks?limit=10&offset=0', null, admin);
  assert.equal(visibleTasks.status, 200);
  assert.equal(visibleTasks.data.items.some(item => item.id === otherUserTask.data.item.id), true, 'administrator can see the other user task');
  const myTasks = await app.request('GET', '/api/v2/tasks?limit=10&offset=0&mine=1', null, admin);
  assert.equal(myTasks.status, 200);
  assert.equal(myTasks.data.items.some(item => item.id === adminOwnTask.data.item.id), true);
  assert.equal(myTasks.data.items.some(item => item.id === otherUserTask.data.item.id), false, 'my-work task query excludes another user task');

  const older = await app.request('POST', '/api/v2/workflows', stocktake(storeId, 'Older actionable approval'), managerChange.cookie);
  assert.equal(older.status, 201, JSON.stringify(older.data));
  const managerAll = await app.request('GET', '/api/v2/workflows?limit=25&offset=0', null, managerChange.cookie);
  assert.equal(managerAll.status, 200);
  assert.equal(managerAll.data.items.some(item => item.id === older.data.item.id), true, 'creator can still see their own pending request in all approvals');
  assert.equal(managerAll.data.pendingForMe, 0, 'creator has no actionable approval count for their own request');
  const managerActionable = await app.request('GET', '/api/v2/workflows?limit=25&offset=0&actionable=1', null, managerChange.cookie);
  assert.equal(managerActionable.status, 200);
  assert.equal(managerActionable.data.total, 0, 'the My pending approvals view matches the creator badge');
  for (let index = 0; index < 11; index += 1) {
    const own = await app.request('POST', '/api/v2/workflows', stocktake(storeId, `New own approval ${index}`), admin);
    assert.equal(own.status, 201, JSON.stringify(own.data));
  }

  const globalRecent = await app.request('GET', '/api/v2/workflows?limit=10&offset=0', null, admin);
  assert.equal(globalRecent.status, 200);
  assert.equal(globalRecent.data.items.some(item => item.id === older.data.item.id), false, 'older actionable item is outside the global latest-ten page');
  assert.equal(globalRecent.data.pendingForMe, 1, 'header and navigation count include the older actionable item');
  const actionableRecent = await app.request('GET', '/api/v2/workflows?limit=10&offset=0&actionable=1', null, admin);
  assert.equal(actionableRecent.status, 200);
  assert.equal(actionableRecent.data.total, 1);
  assert.deepEqual(actionableRecent.data.items.map(item => item.id), [older.data.item.id]);
  assert.equal(actionableRecent.data.items[0].actionableForMe, true);

  const approved = await app.request('POST', `/api/v2/workflows/${older.data.item.id}/actions`, { action: 'approve', note: 'Fixture-only approval' }, admin);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const refreshed = await app.request('GET', '/api/v2/workflows?limit=10&offset=0&actionable=1', null, admin);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.pendingForMe, 0, 'approval total refreshes after a status change');
  assert.equal(refreshed.data.total, 0, 'approved item no longer appears in actionable work');
});
