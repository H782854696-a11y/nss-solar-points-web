#!/usr/bin/env node
'use strict';

// Explicit, opt-in migration only. It never runs at server startup and never
// removes users.role, so old workflow snapshots and audit records remain
// readable. Run against an isolated copy first:
//   SP_DATA_DIR=/tmp/copy node scripts/migrate-person-access-policy.js --dry-run
//   SP_DATA_DIR=/tmp/copy node scripts/migrate-person-access-policy.js --apply --backup /tmp/users-before-policy.json
// Rollback restores exactly that users snapshot:
//   SP_DATA_DIR=/tmp/copy node scripts/migrate-person-access-policy.js --rollback /tmp/users-before-policy.json

const fs = require('fs');
const path = require('path');
const rbac = require('../lib/rbac');
const { readCollection, writeCollection } = require('../lib/store');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dryRun = args.includes('--dry-run') || !apply;
const reportDetails = args.includes('--report-details');
const rollbackAt = args.indexOf('--rollback');
const backupAt = args.indexOf('--backup');
const dataDir = process.env.SP_DATA_DIR ? path.resolve(process.env.SP_DATA_DIR) : null;

if (!dataDir) throw new Error('SP_DATA_DIR is required; refusing to target an implicit data directory');
if (rollbackAt !== -1) {
  const backupPath = args[rollbackAt + 1];
  if (!backupPath) throw new Error('--rollback requires a backup path');
  if (apply) throw new Error('--rollback cannot be combined with --apply');
  const snapshot = JSON.parse(fs.readFileSync(path.resolve(backupPath), 'utf8'));
  if (!Array.isArray(snapshot.users)) throw new Error('backup does not contain a users array');
  writeCollection('users', snapshot.users);
  process.stdout.write(JSON.stringify({ rolledBack: snapshot.users.length, backup: path.resolve(backupPath) }) + '\n');
  process.exit(0);
}

const users = readCollection('users') || [];
if (!Array.isArray(users)) throw new Error('users collection must be an array');
const alreadyMigrated = users.filter(user => rbac.hasExplicitAccessPolicy(user));
if (alreadyMigrated.length) throw new Error(`refusing mixed migration: ${alreadyMigrated.length} account(s) already have accessPolicy`);
const migrated = users.map(user => ({ ...user, accessPolicy: rbac.buildAccessPolicyFromLegacy(user, users) }));
const migratedById = new Map(migrated.map(user => [user.id, user]));
const grantScopeDifferences = [];
for (const user of users) {
  const before = new Map(rbac.grantsFor(user.role).map(grant => [grant.p, grant.s]));
  const after = new Map(rbac.grantsForUser(migratedById.get(user.id)).map(grant => [grant.p, grant.s]));
  for (const permission of new Set([...before.keys(), ...after.keys()])) {
    if ((before.get(permission) || null) !== (after.get(permission) || null)) grantScopeDifferences.push({ userId: user.id, permission, beforeScope: before.get(permission) || null, afterScope: after.get(permission) || null });
  }
}
let existingAssignmentChecks = 0;
const existingAssignmentDifferences = [];
for (const actor of users) for (const target of users) {
  const before = rbac.legacyCanAssign(actor, target, 'task').ok;
  const after = rbac.canAssign(migratedById.get(actor.id), migratedById.get(target.id), 'task').ok;
  existingAssignmentChecks += 1;
  if (before !== after) existingAssignmentDifferences.push({ actorId: actor.id, targetId: target.id, before, after });
}
const summary = {
  dryRun,
  users: users.length,
  pending: migrated.filter(user => user.accessPolicy.state !== 'active').length,
  active: migrated.filter(user => user.accessPolicy.state === 'active').length,
  grants: migrated.reduce((sum, user) => sum + user.accessPolicy.grants.length, 0),
  assignmentTargets: migrated.reduce((sum, user) => sum + user.accessPolicy.assignmentTargets.task.length, 0),
  equivalence: { grantScopeDifferences: grantScopeDifferences.length, existingAssignmentChecks, existingAssignmentDifferences: existingAssignmentDifferences.length },
};
if (reportDetails) summary.equivalence.details = { grantScopeDifferences, existingAssignmentDifferences };
if (dryRun) { process.stdout.write(JSON.stringify(summary) + '\n'); process.exit(0); }
if (grantScopeDifferences.length || existingAssignmentDifferences.length) throw new Error('migration equivalence check failed; refusing to write policies');

const backupPath = backupAt === -1 ? null : args[backupAt + 1];
if (!backupPath) throw new Error('--apply requires --backup <absolute-or-relative-path>');
const resolvedBackup = path.resolve(backupPath);
if (fs.existsSync(resolvedBackup)) throw new Error('backup already exists; refusing to overwrite it');
fs.writeFileSync(resolvedBackup, JSON.stringify({ users, createdAt: new Date().toISOString(), schema: 'person-access-policy-v1' }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
writeCollection('users', migrated);
process.stdout.write(JSON.stringify({ ...summary, dryRun: false, backup: resolvedBackup }) + '\n');
