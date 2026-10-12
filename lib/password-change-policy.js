'use strict';

// Production policy migration. It deliberately supports the current JSON
// driver only and never reads, compares, or logs password hashes.
const fs = require('node:fs');
const path = require('node:path');

const ORDINARY_EMPLOYEE_ROLES = new Set(['manager', 'store_manager', 'sales', 'warehouse', 'service', 'purchaser']);

function classifyUser(user) {
  if (!user || typeof user !== 'object') return 'invalid_record';
  if (user.username === 'admin') return 'bootstrap_or_default_admin';
  if (user.disabled === true) return 'disabled_account';
  if (!ORDINARY_EMPLOYEE_ROLES.has(user.role)) return 'management_or_unknown_role';
  return 'ordinary_employee';
}

function inspectUsers(users) {
  if (!Array.isArray(users)) throw new Error('users.json must contain an array');
  const summary = { eligible: 0, unchanged: 0, excluded: {}, eligibleRoles: {} };
  for (const user of users) {
    const group = classifyUser(user);
    if (group !== 'ordinary_employee') { summary.excluded[group] = (summary.excluded[group] || 0) + 1; continue; }
    if (user.mustChangePassword === true) {
      summary.eligible += 1;
      summary.eligibleRoles[user.role] = (summary.eligibleRoles[user.role] || 0) + 1;
    } else summary.unchanged += 1;
  }
  return summary;
}

function runMigration(dataDir, { apply = false } = {}) {
  const directory = path.resolve(dataDir || '');
  if (!directory || !fs.statSync(directory).isDirectory()) throw new Error('data directory is required');
  const marker = path.join(directory, '_storage.json');
  if (fs.existsSync(marker)) {
    let config;
    try { config = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { throw new Error('_storage.json is invalid; refusing to guess the storage driver'); }
    if (config?.driver && config.driver !== 'json') throw new Error(`storage driver ${String(config.driver)} is not supported by this migration`);
  }
  const usersFile = path.join(directory, 'users.json');
  if (!fs.existsSync(usersFile)) throw new Error('users.json is absent; refusing to create a user collection');
  let users;
  try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch { throw new Error('users.json is invalid; refusing to overwrite it'); }
  const summary = inspectUsers(users);
  if (!apply || summary.eligible === 0) return { ...summary, applied: false };
  for (const user of users) if (classifyUser(user) === 'ordinary_employee' && user.mustChangePassword === true) user.mustChangePassword = false;
  const temporary = `${usersFile}.password-policy-${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(users, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, usersFile);
  const roles = Object.entries(summary.eligibleRoles).map(([role, count]) => `${role}:${count}`).join(',') || 'none';
  const excluded = Object.entries(summary.excluded).map(([reason, count]) => `${reason}:${count}`).join(',') || 'none';
  fs.appendFileSync(path.join(directory, 'audit.log'), `[${new Date().toISOString()}] password-change-policy migration: source=user-confirmed-2026-10-12; cleared mustChangePassword for ${summary.eligible} active ordinary accounts (roles=${roles}); excluded=${excluded}; password/hash/role data unchanged\n`, { mode: 0o600 });
  return { ...summary, applied: true };
}

module.exports = { ORDINARY_EMPLOYEE_ROLES, classifyUser, inspectUsers, runMigration };
