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

test('control center renders a safe image preview, recoverable employee removal and reset synchronization', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
  assert.match(app, /data-workflow-image-preview/);
  assert.match(app, /URL\.createObjectURL/);
  assert.match(app, /URL\.revokeObjectURL/);
  assert.match(app, /ccAttachmentZoom/);
  assert.match(app, /\['image\/png','image\/jpeg'\]\.includes\(type\)/);
  assert.match(app, /data-v2-restore-employee/);
  assert.match(app, /Remove employee profile/);
  assert.match(app, /form\?\.reset\(\)/);
  assert.match(app, /event\.key === 'Escape'/);
});
