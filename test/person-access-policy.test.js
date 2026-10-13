'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const rbac = require('../lib/rbac');
const { startLocalApp } = require('./helpers/local-app');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

test('explicit person policy is authoritative, preserves legacy mapping, and supports audited migration rules', () => {
  const legacy = { id: 'manager', role: 'manager', storeId: 'S1', country: 'PH' };
  const sales = { id: 'sales', role: 'sales', storeId: 'S1', employeeId: 'E1', country: 'PH' };
  const warehouse = { id: 'warehouse', role: 'warehouse', storeId: 'S1', employeeId: 'E2', country: 'PH' };
  const otherStore = { id: 'other-store', role: 'sales', storeId: 'S2', employeeId: 'E3', country: 'PH' };
  const existing = [legacy, sales, warehouse, otherStore];
  const migrated = { ...legacy, accessPolicy: rbac.buildAccessPolicyFromLegacy(legacy, existing) };
  assert.deepEqual(rbac.grantsForUser(migrated), rbac.grantsFor('manager'));
  assert.equal(rbac.hasPermission(migrated, 'task.assign'), true);
  assert.equal(rbac.canAssign(migrated, sales, 'task').ok, true);
  // Every account that existed during migration keeps its former outcome.
  for (const target of existing) assert.equal(rbac.canAssign(migrated, target, 'task').ok, rbac.legacyCanAssign(legacy, target, 'task').ok);
  const futureEligible = { id: 'future', role: 'pending_authorization', storeId: 'S1', employeeId: 'E4', country: 'PH', accessPolicy: { state: 'active', grants: [{ permission: 'task.view', scope: 'store' }, { permission: 'task.close', scope: 'store' }], assignmentTargets: { task: [] }, assignmentEligibility: { task: true } } };
  assert.equal(rbac.canAssign(migrated, futureEligible, 'task').ok, true, 'new in-scope task recipient joins the approved dynamic rule');
  assert.equal(rbac.canAssign(migrated, { ...futureEligible, id: 'future-not-eligible', accessPolicy: { ...futureEligible.accessPolicy, assignmentEligibility: { task: false } } }, 'task').ok, false, 'a new account without the explicit recipient capability is denied');
  assert.equal(rbac.canAssign(migrated, { ...futureEligible, id: 'future-other-store', storeId: 'S2' }, 'task').ok, false, 'a scope change is checked in real time');
  assert.equal(rbac.canAssign(migrated, { ...futureEligible, id: 'future-disabled', disabled: true }, 'task').ok, false, 'a disabled recipient is denied in real time');
  futureEligible.accessPolicy.state = 'pending_authorization';
  assert.equal(rbac.canAssign(migrated, futureEligible, 'task').ok, false, 'revoked/pending recipient is denied in real time');

  migrated.accessPolicy = { version: 1, state: 'active', grants: [{ permission: 'task.view', scope: 'self' }], assignmentTargets: { task: ['sales'] } };
  assert.equal(rbac.hasPermission(migrated, 'task.assign'), false, 'explicit policy must not fall back to legacy role');
  assert.equal(rbac.canAssign(migrated, sales, 'task').ok, false, 'missing task.assign still denies even if target is listed');

  migrated.accessPolicy.grants.push({ permission: 'task.assign', scope: 'store' });
  assert.equal(rbac.canAssign(migrated, sales, 'task').ok, true);
  assert.equal(rbac.canAssign(migrated, { ...sales, id: 'other' }, 'task').ok, false, 'an unlisted target is denied');
  migrated.accessPolicy.state = 'pending_authorization';
  assert.equal(rbac.permissionsOf(migrated).length, 0, 'pending policy has no business access');
});

test('administrator policy API rejects self-escalation and validates explicit grants', { timeout: 30000 }, async t => {
  const app = await startLocalApp(); t.after(app.close);
  const admin = await app.login('admin');
  const created = await app.request('POST', '/api/v2/users', { username: 'policy_target', name: 'Policy Target', password: app.password }, admin);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const targetId = created.data.item.id;
  assert.equal(created.data.item.accessPolicy.state, 'pending_authorization');

  const adminMe = await app.request('GET', '/api/auth/me', undefined, admin);
  const self = await app.request('PUT', `/api/v2/users/${adminMe.data.user.id}/access-policy`, { policy: { state: 'active', grants: [{ permission: 'system.role.manage', scope: 'global' }], assignmentTargets: { task: [] } } }, admin);
  assert.equal(self.status, 400, JSON.stringify(self.data));
  const badScope = await app.request('PUT', `/api/v2/users/${targetId}/access-policy`, { policy: { state: 'active', grants: [{ permission: 'system.role.manage', scope: 'store' }], assignmentTargets: { task: [] } } }, admin);
  assert.equal(badScope.status, 400, JSON.stringify(badScope.data));
  const badEligibility = await app.request('PUT', `/api/v2/users/${targetId}/access-policy`, { policy: { state: 'active', grants: [{ permission: 'task.view', scope: 'self' }], assignmentTargets: { task: [] }, assignmentEligibility: { task: true } } }, admin);
  assert.equal(badEligibility.status, 400, JSON.stringify(badEligibility.data));
  const applied = await app.request('PUT', `/api/v2/users/${targetId}/access-policy`, { policy: { state: 'active', grants: [{ permission: 'task.view', scope: 'self' }, { permission: 'task.close', scope: 'self' }], assignmentTargets: { task: [] } } }, admin);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.policy.grants.length, 2);
  const policyTargetCookie = await app.login('policy_target');
  const meInfo = await app.request('GET', '/api/auth/me', undefined, policyTargetCookie);
  assert.equal(meInfo.status, 200);
  assert.equal(meInfo.data.accessState, 'active');
  assert.deepEqual(meInfo.data.grants.map(g => g.p).sort(), ['task.close', 'task.view']);
});

test('explicit migration is opt-in, keeps legacy roles, and can restore the exact users snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-policy-migration-'));
  const before = [
    { id: 'a', username: 'admin', role: 'admin', disabled: false },
    { id: 'm', username: 'manager', role: 'manager', storeId: 'S1', disabled: false },
    { id: 's', username: 'sales', role: 'sales', storeId: 'S1', disabled: false },
  ];
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(before));
  const env = { ...process.env, SP_DATA_DIR: dir };
  const script = path.join(ROOT, 'scripts', 'migrate-person-access-policy.js');
  const dry = spawnSync(NODE, [script, '--dry-run'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).equivalence, { grantScopeDifferences: 0, existingAssignmentChecks: 9, existingAssignmentDifferences: 0 });
  const detailed = spawnSync(NODE, [script, '--dry-run', '--report-details'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.deepEqual(JSON.parse(detailed.stdout).equivalence.details, { grantScopeDifferences: [], existingAssignmentDifferences: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8')), before, 'dry run must not write');
  const backup = path.join(dir, 'before.json');
  const apply = spawnSync(NODE, [script, '--apply', '--backup', backup], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(apply.status, 0, apply.stderr);
  const migrated = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
  assert.equal(migrated[0].role, 'admin', 'legacy role remains for audit and old workflow compatibility');
  assert.equal(migrated[0].accessPolicy.state, 'active');
  assert.ok(migrated[0].accessPolicy.grants.length > 0);
  const rollback = spawnSync(NODE, [script, '--rollback', backup], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8')), before);
});

test('account UI replaces role grants with explicit access settings and keeps layout separate', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(app, /function openAccountAccessSettings\(account\)/);
  assert.match(app, /\/api\/v2\/users\/\$\{encodeURIComponent\(account\.id\)\}\/access-policy/);
  assert.match(app, /data-workspace-account/);
  assert.match(app, /taskEligible/);
  assert.doesNotMatch(app, /data-access-account/);
  assert.match(app, /Department association never adds access/);
  assert.doesNotMatch(app, /data-grant-role/);
  assert.doesNotMatch(app, /ccGrantRoleForm/);
  assert.match(app, /data-workspace-account/);
  assert.match(index, /app\.js\?v=110/);
});
