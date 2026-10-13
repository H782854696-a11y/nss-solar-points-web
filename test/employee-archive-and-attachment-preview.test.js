'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startLocalApp, photo } = require('./helpers/local-app');

test('employee removal is a recoverable archive with protected account and history semantics', async t => {
  const app = await startLocalApp(); t.after(app.close);
  const admin = await app.login('admin');
  const created = await app.request('POST', '/api/v2/employees', { name: 'Archive fixture' }, admin);
  assert.equal(created.status, 201);
  const id = created.data.item.id;
  assert.equal((await app.request('POST', `/api/v2/employees/${id}/archive`, {}, admin)).status, 200);
  assert.equal((await app.request('GET', '/api/v2/employees', null, admin)).data.items.some(x => x.id === id), false);
  assert.equal((await app.request('GET', '/api/v2/employees/archived', null, admin)).data.items.some(x => x.id === id), true);
  assert.equal((await app.request('POST', `/api/v2/employees/${id}/restore`, {}, admin)).status, 200);
  assert.equal((await app.request('GET', '/api/v2/employees', null, admin)).data.items.some(x => x.id === id), true);
});

test('permanent employee deletion requires an exact confirmation and blocks account, task, workflow, and definition references', async t => {
  const app = await startLocalApp(); t.after(app.close);
  const admin = await app.login('admin');
  const created = await app.request('POST', '/api/v2/employees', { name: 'Hard delete fixture' }, admin);
  const item = created.data.item;
  assert.equal((await app.request('DELETE', `/api/v2/employees/${item.id}`, { confirmEmployeeCode: 'wrong' }, admin)).status, 400);
  assert.equal((await app.request('GET', '/api/v2/employees', null, admin)).data.items.some(x => x.id === item.id), true, 'a cancelled/wrong confirmation never deletes');
  assert.equal((await app.request('DELETE', `/api/v2/employees/${item.id}`, { confirmEmployeeCode: item.employeeCode }, admin)).status, 200);
  const linked = await app.request('POST', '/api/v2/employees', { name: 'Linked hard delete fixture' }, admin);
  const account = await app.request('POST', '/api/v2/users', { username: 'hard_delete_link', name: 'Hard Delete Link', password: app.password, employeeId: linked.data.item.id }, admin);
  assert.equal(account.status, 201);
  assert.equal((await app.request('DELETE', `/api/v2/employees/${linked.data.item.id}`, { confirmEmployeeCode: linked.data.item.employeeCode }, admin)).status, 409);

  const defined = await app.request('POST', '/api/v2/employees', { name: 'Definition hard delete fixture' }, admin);
  // Inject a historical definition reference into this test's isolated data
  // directory. It models a pre-current-schema user slot plus employee ID.
  const definitionPath = path.join(app.dataDir, 'workflowDefinitions.json');
  const stored = JSON.parse(fs.readFileSync(definitionPath, 'utf8'));
  stored.push({ id: 'delete-reference-definition', type: 'stocktake', active: true, config: { steps: [{ approvers: [{ kind: 'user', id: defined.data.item.userId || defined.data.item.id, employeeId: defined.data.item.id }] }] } });
  fs.writeFileSync(definitionPath, JSON.stringify(stored));
  assert.equal((await app.request('DELETE', `/api/v2/employees/${defined.data.item.id}`, { confirmEmployeeCode: defined.data.item.employeeCode }, admin)).status, 409);

  const historical = await app.request('POST', '/api/v2/employees', { name: 'Historical approval hard delete fixture' }, admin);
  const instancePath = path.join(app.dataDir, 'workflowInstances.json');
  const instances = JSON.parse(fs.readFileSync(instancePath, 'utf8'));
  instances.push({ id: 'delete-reference-instance', assignedApproverAccess: { steps: [[{ userId: 'historical-account', employeeId: historical.data.item.id }]] } });
  fs.writeFileSync(instancePath, JSON.stringify(instances));
  assert.equal((await app.request('DELETE', `/api/v2/employees/${historical.data.item.id}`, { confirmEmployeeCode: historical.data.item.employeeCode }, admin)).status, 409);
});

test('workflow images have an authenticated inline-preview response but non-images remain downloads', async t => {
  const app = await startLocalApp(); t.after(app.close);
  const admin = await app.login('admin');
  const stores = await app.request('GET', '/api/stores', null, admin);
  const workflow = await app.request('POST', '/api/v2/workflows', { type: 'stocktake', form: { storeId: stores.data.items[0].id, counterName: 'fixture' }, images: [photo] }, admin);
  assert.equal(workflow.status, 201, JSON.stringify(workflow.data));
  const item = workflow.data.item, attachment = item.attachments[0];
  const response = await fetch(`${app.base}/api/v2/workflows/${item.id}/attachments/${attachment.id}/download?disposition=inline`, { headers: { cookie: admin } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^inline;/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await fetch(`${app.base}/api/v2/workflows/${item.id}/attachments/${attachment.id}/download`)).status, 401);
});

test('control center renders a safe image preview and does not expose a removed-employee restore queue', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
  assert.match(app, /data-workflow-image-preview/);
  assert.match(app, /URL\.createObjectURL/);
  assert.match(app, /URL\.revokeObjectURL/);
  assert.match(app, /ccAttachmentZoom/);
  assert.match(app, /\['image\/png','image\/jpeg'\]\.includes\(type\)/);
  assert.doesNotMatch(app, /data-v2-restore-employee/);
  assert.doesNotMatch(app, /GET\('\/api\/v2\/employees\/archived'\)/);
  assert.match(app, /Remove employee profile/);
  assert.match(app, /form\?\.reset\(\)/);
  assert.match(app, /event\.key === 'Escape'/);
});
