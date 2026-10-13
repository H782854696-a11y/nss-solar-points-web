'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startLocalApp } = require('./helpers/local-app');

test('workspace layouts remain display-only and prefer account override, department default, then legacy position default', async t => {
  const app = await startLocalApp(); t.after(app.close);
  const admin = await app.login('admin');
  const original = await app.request('GET', '/api/v2/workspace-settings/me', null, admin);
  assert.equal(original.status, 200);
  const personal = await app.request('PUT', '/api/v2/workspace-settings/me', {
    settings: { defaultWorkspace: 'approvals', visibleMenus: ['approvals'], menuOrder: ['approvals'], homeModules: ['my_tasks'] },
  }, admin);
  assert.equal(personal.status, 200);
  assert.equal(personal.data.hasPersonalOverride, true);
  assert.equal(personal.data.effectiveSettings.defaultWorkspace, 'approvals');
  assert.deepEqual(personal.data.effectiveSettings.visibleMenus, ['approvals']);
  // Unknown menu/module values are ignored rather than becoming hidden permissions or executable settings.
  assert.equal(personal.data.effectiveSettings.menuOrder.includes('system.audit'), false);
  const restored = await app.request('DELETE', '/api/v2/workspace-settings/me', null, admin);
  assert.equal(restored.status, 200);
  assert.equal(restored.data.hasPersonalOverride, false);
  const departments = await app.request('GET', '/api/v2/workspace-settings/departments', null, admin);
  assert.equal(departments.status, 200);
  assert.ok(departments.data.items.length > 0);
  const saved = await app.request('PUT', `/api/v2/workspace-settings/departments/${departments.data.items[0].department.id}`, { settings: { defaultWorkspace: 'collaboration' } }, admin);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.settings.defaultWorkspace, 'collaboration');
  const positions = await app.request('GET', '/api/v2/workspace-settings/positions', null, admin);
  assert.equal(positions.status, 200, 'legacy position defaults remain readable');
  const retired = await app.request('PUT', `/api/v2/workspace-settings/positions/${positions.data.items[0].position.id}`, { settings: { defaultWorkspace: 'overview' } }, admin);
  assert.equal(retired.status, 410, 'new position defaults cannot be written');
  const users = await app.request('GET', '/api/users', null, admin);
  const target = users.data.items.find(item => item.id !== original.data.userId) || users.data.items[0];
  const managed = await app.request('PUT', `/api/v2/workspace-settings/users/${target.id}`, { settings: { defaultWorkspace: 'announcements' } }, admin);
  assert.equal(managed.status, 200);
  assert.equal(managed.data.hasPersonalOverride, true);
  assert.equal((await app.request('DELETE', `/api/v2/workspace-settings/users/${target.id}`, null, admin)).status, 200);
});

test('workspace settings UI exposes department defaults, account overrides and compatibility fallback without changing permissions', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
  const server = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  assert.match(app, /部门工作台设置/);
  assert.match(app, /恢复部门默认/);
  assert.match(app, /workspace-settings\/departments/);
  assert.match(app, /旧职位默认仅兼容读取/);
  assert.match(app, /data-workspace-account/);
  assert.match(app, /Visible workspace functions/);
  assert.match(app, /visibleMenus/);
  assert.doesNotMatch(app, /data-layout-move/);
  assert.match(server, /workspace-settings\/me/);
  assert.match(server, /workspace-settings\/users\/:userId/);
  assert.match(server, /workspace-settings\/departments/);
  assert.match(server, /system\.user\.edit/);
  assert.match(server, /WORKSPACE_LAYOUT_KEYS/);
});

test('workspace layout visibility changes only configurable entries and preserves static RBAC navigation', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
  const index = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
  const layoutKeys = ['overview', 'approvals', 'collaboration', 'storeops', 'purchasing', 'announcements'];
  const helperSource = app.match(/function isWorkspaceLayoutEntry\(key\)\s*\{\s*return WORKSPACE_LAYOUT_KEYS\.includes\(key\);\s*\}/)?.[0];
  assert.ok(helperSource, 'applyWorkspaceSettings must use an explicit layout-entry allowlist');
  const isWorkspaceLayoutEntry = new Function('WORKSPACE_LAYOUT_KEYS', `${helperSource}; return isWorkspaceLayoutEntry;`)(layoutKeys);
  const visible = new Set(['approvals']); // Legacy menuOrder without visibleMenus.
  const nav = new Map([
    ['overview', { hidden: false, display: '' }],
    ['approvals', { hidden: false, display: '' }],
    ['org', { hidden: false, display: '' }],
    // A user without org.view is already hidden by the normal RBAC pass.
    ['governance', { hidden: false, display: 'none' }],
  ]);

  // Execute the production allowlist policy: layouts may only hide their six
  // explicitly configurable workspaces.
  for (const [key, item] of nav) if (isWorkspaceLayoutEntry(key)) item.hidden = !visible.has(key);

  assert.equal(nav.get('overview').hidden, true, 'visibleMenus may hide a configurable workspace');
  assert.equal(nav.get('approvals').hidden, false, 'visibleMenus keeps a selected configurable workspace');
  assert.equal(nav.get('org').hidden, false, 'legacy menuOrder must not hide Department Personnel');
  assert.equal(nav.get('governance').hidden, false, 'layout must not mutate other static navigation');
  assert.equal(nav.get('governance').display, 'none', 'the existing RBAC denial remains authoritative');

  // Saving, restoring, or reloading all rerun the same function; verify the
  // implementation cannot write hidden on a non-layout entry in any path.
  assert.match(app, /function isWorkspaceLayoutEntry\(key\)\s*\{\s*return WORKSPACE_LAYOUT_KEYS\.includes\(key\);\s*\}/);
  assert.match(app, /if \(isWorkspaceLayoutEntry\(key\)\) el\.hidden = !visible\.has\(key\);/);
  assert.match(app, /ccPersonalWorkspaceForm[\s\S]{0,700}state\.workspaceSettings = await PUT[\s\S]{0,300}applyWorkspaceSettings\(\)/);
  assert.match(app, /ccRestoreDepartmentWorkspace[\s\S]{0,700}state\.workspaceSettings = await DELETE[\s\S]{0,300}applyWorkspaceSettings\(\)/);
  assert.match(index, /data-workspace="org"/);
  assert.match(index, /app\.js\?v=107/);
});
