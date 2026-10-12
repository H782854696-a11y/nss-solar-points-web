'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectUsers, runMigration } = require('../lib/password-change-policy');

test('migration changes only active ordinary employees and reports conservative exclusions', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-password-policy-'));
  try {
    const users = [
      { id: 'employee', username: 'employee', role: 'sales', mustChangePassword: true },
      { id: 'manager', username: 'manager', role: 'regional_manager', mustChangePassword: true },
      { id: 'admin', username: 'admin', role: 'admin', mustChangePassword: true },
      { id: 'disabled', username: 'disabled', role: 'service', disabled: true, mustChangePassword: true },
      { id: 'unknown', username: 'unknown', role: 'custom_role', mustChangePassword: true },
    ];
    fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify(users));
    assert.deepEqual(inspectUsers(users).eligibleRoles, { sales: 1 });
    assert.equal(runMigration(dataDir).eligible, 1);
    const result = runMigration(dataDir, { apply: true });
    assert.equal(result.applied, true);
    const changed = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
    assert.equal(changed.find(x => x.id === 'employee').mustChangePassword, false);
    for (const id of ['manager', 'admin', 'disabled', 'unknown']) assert.equal(changed.find(x => x.id === id).mustChangePassword, true);
    const audit = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8');
    assert.match(audit, /cleared mustChangePassword for 1 active ordinary accounts/);
    assert.doesNotMatch(audit, /\$2[aby]\$/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('migration refuses an unsupported storage driver without changing users', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-password-policy-'));
  try {
    const usersFile = path.join(dataDir, 'users.json');
    fs.writeFileSync(usersFile, JSON.stringify([{ id: 'employee', username: 'employee', role: 'sales', mustChangePassword: true }]));
    fs.writeFileSync(path.join(dataDir, '_storage.json'), JSON.stringify({ driver: 'sqlite' }));
    assert.throws(() => runMigration(dataDir, { apply: true }), /not supported/);
    assert.equal(JSON.parse(fs.readFileSync(usersFile, 'utf8'))[0].mustChangePassword, true);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
