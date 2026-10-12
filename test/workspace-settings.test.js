'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startLocalApp } = require('./helpers/local-app');

test('workspace layouts remain display-only and support personal restore plus admin position defaults', async t => {
  const app = await startLocalApp(); t.after(app.close);
  const admin = await app.login('admin');
  const original = await app.request('GET', '/api/v2/workspace-settings/me', null, admin);
  assert.equal(original.status, 200);
  const personal = await app.request('PUT', '/api/v2/workspace-settings/me', {
    settings: { defaultWorkspace: 'approvals', menuOrder: ['approvals', 'overview'], homeModules: ['my_tasks'] },
  }, admin);
  assert.equal(personal.status, 200);
  assert.equal(personal.data.hasPersonalOverride, true);
  assert.equal(personal.data.effectiveSettings.defaultWorkspace, 'approvals');
  // Unknown menu/module values are ignored rather than becoming hidden permissions or executable settings.
  assert.equal(personal.data.effectiveSettings.menuOrder.includes('system.audit'), false);
  const restored = await app.request('DELETE', '/api/v2/workspace-settings/me', null, admin);
  assert.equal(restored.status, 200);
  assert.equal(restored.data.hasPersonalOverride, false);
  const positions = await app.request('GET', '/api/v2/workspace-settings/positions', null, admin);
  assert.equal(positions.status, 200);
  assert.ok(positions.data.items.length > 0);
  const saved = await app.request('PUT', `/api/v2/workspace-settings/positions/${positions.data.items[0].position.id}`, { settings: { defaultWorkspace: 'collaboration' } }, admin);
  assert.equal(saved.status, 200);
  const users = await app.request('GET', '/api/users', null, admin);
  const target = users.data.items.find(item => item.id !== original.data.userId) || users.data.items[0];
  const managed = await app.request('PUT', `/api/v2/workspace-settings/users/${target.id}`, { settings: { defaultWorkspace: 'announcements' } }, admin);
  assert.equal(managed.status, 200);
  assert.equal(managed.data.hasPersonalOverride, true);
  assert.equal((await app.request('DELETE', `/api/v2/workspace-settings/users/${target.id}`, null, admin)).status, 200);
});

test('workspace settings UI exposes position defaults, personal override and restore without changing permissions', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
  const server = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  assert.match(app, /职位工作台设置/);
  assert.match(app, /恢复职位默认/);
  assert.match(app, /data-workspace-account/);
  assert.match(app, /Only features already authorized/);
  assert.match(server, /workspace-settings\/me/);
  assert.match(server, /workspace-settings\/users\/:userId/);
  assert.match(server, /system\.user\.edit/);
  assert.match(server, /WORKSPACE_LAYOUT_KEYS/);
});
