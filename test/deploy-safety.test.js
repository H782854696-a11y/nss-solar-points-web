const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const test = require('node:test');

const safety = path.resolve(__dirname, '../deploy/release-safety.sh');
function run(...args) { return execFileSync('bash', [safety, ...args], { encoding: 'utf8' }).trim(); }
function tryRun(...args) { return spawnSync('bash', [safety, ...args], { encoding: 'utf8' }); }
function makeRelease(root, name, compatibility) {
  const release = path.join(root, name);
  fs.mkdirSync(path.join(release, 'deploy'), { recursive: true });
  if (compatibility) fs.writeFileSync(path.join(release, 'deploy/release-contract.json'), JSON.stringify({ dataCompatibility: compatibility }));
  return release;
}
function writeDeposits(data, statuses) {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'dailyDeposits.json'), JSON.stringify(statuses.map(status => ({ status }))));
}
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nss-deploy-safety-')); }

test('unknown fallback compatibility refuses an automatic rollback and preserves the current link', () => {
  const root = temp(); const candidate = makeRelease(root, 'candidate', 'daily-deposit-review-v1');
  const legacy = makeRelease(root, 'legacy'); const data = path.join(root, 'data'); writeDeposits(data, ['pending_review']);
  const current = path.join(root, 'current'); fs.symlinkSync(candidate, current);
  const result = tryRun('safe-switch', current, legacy, data);
  assert.notStrictEqual(result.status, 0); assert.strictEqual(fs.realpathSync(current), fs.realpathSync(candidate));
});

test('candidate startup failure policy does not switch an unknown fallback link automatically', () => {
  const root = temp(); const candidate = makeRelease(root, 'candidate', 'daily-deposit-review-v1');
  const unknownFallback = makeRelease(root, 'unknown-fallback'); const data = path.join(root, 'data');
  const current = path.join(root, 'current'); fs.symlinkSync(candidate, current);
  // This is the same fail-closed operation deploy-v2 uses after a failed start:
  // it refuses the unknown fallback rather than changing the current link.
  assert.notStrictEqual(tryRun('safe-switch', current, unknownFallback, data).status, 0);
  assert.strictEqual(fs.realpathSync(current), fs.realpathSync(candidate));
});

test('incompatible legacy fallback refuses review-state data after a failed health check', () => {
  const root = temp(); const legacy = makeRelease(root, 'legacy', 'daily-deposit-legacy-v0');
  const data = path.join(root, 'data'); writeDeposits(data, ['rejected', 'confirmed']);
  const result = tryRun('rollback-allowed', legacy, data);
  assert.notStrictEqual(result.status, 0); assert.match(result.stderr, /cannot read/);
});

test('a compatible fallback is allowed only after the data contract is recognized', () => {
  const root = temp(); const fallback = makeRelease(root, 'fallback', 'daily-deposit-review-v1');
  const data = path.join(root, 'data'); writeDeposits(data, ['pending_review', 'rejected', 'confirmed']);
  assert.match(run('rollback-allowed', fallback, data), /^allowed:/);
});

test('legacy reported data is recognized and a legacy-compatible fallback can be selected', () => {
  const root = temp(); const fallback = makeRelease(root, 'fallback', 'daily-deposit-legacy-v0');
  const data = path.join(root, 'data'); writeDeposits(data, ['reported']);
  assert.strictEqual(run('data-floor', data), 'daily-deposit-legacy-v0'); assert.match(run('rollback-allowed', fallback, data), /^allowed:/);
});

test('SQLite storage is unknown to the JSON-only guard and therefore cannot trigger automatic rollback', () => {
  const root = temp(); const fallback = makeRelease(root, 'fallback', 'daily-deposit-review-v1');
  const data = path.join(root, 'data'); fs.mkdirSync(data); fs.writeFileSync(path.join(data, '_storage.json'), JSON.stringify({ driver: 'sqlite' }));
  assert.strictEqual(run('data-floor', data), 'unknown');
  assert.notStrictEqual(tryRun('rollback-allowed', fallback, data).status, 0);
});

test('backup validation creates a readable archive and checksum without overwriting', () => {
  const root = temp(); const data = path.join(root, 'data'); fs.mkdirSync(path.join(data, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(data, 'dailyDeposits.json'), '[]'); fs.writeFileSync(path.join(data, 'uploads', 'proof.txt'), 'synthetic attachment');
  const backupDir = path.join(root, 'backups'); const [archive, checksum] = run('backup', data, backupDir, 'unit-test').split('\n');
  assert.match(checksum, /^[a-f0-9]{64}$/); assert.match(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }), /data\/uploads\/proof.txt/);
  assert.throws(() => run('backup', data, backupDir, 'unit-test'));
});

test('release manifest records SHA, time, compatibility, fallback, and backup checksum', () => {
  const root = temp(); const output = path.join(root, 'record.json');
  run('manifest', output, 'release-test', 'abc123', '2026-10-08T00:00:00Z', 'daily-deposit-review-v1', '/releases/previous', '/backups/data.tgz', 'a'.repeat(64));
  const record = JSON.parse(fs.readFileSync(output));
  assert.strictEqual(record.sourceSha, 'abc123'); assert.strictEqual(record.dataCompatibility, 'daily-deposit-review-v1'); assert.strictEqual(record.rollbackTarget, '/releases/previous');
});

test('only a recorded healthy read-only candidate can be manually cleared to resume writes', () => {
  const root = temp(); const candidate = makeRelease(root, 'candidate', 'daily-deposit-review-v1');
  const data = path.join(root, 'data'); writeDeposits(data, ['pending_review']); const state = path.join(root, 'active-state.json');
  run('state', state, 'live_read_only_healthy', candidate, 'abc123', 'daily-deposit-review-v1', '/releases/old', 'interrupted after health validation');
  assert.match(run('can-resume-writes', state, candidate, data), /^allowed:/);
});

test('interrupted or unknown deployment states require manual investigation and never clear write protection', () => {
  const root = temp(); const candidate = makeRelease(root, 'candidate', 'daily-deposit-review-v1');
  const data = path.join(root, 'data'); writeDeposits(data, ['confirmed']); const state = path.join(root, 'active-state.json');
  run('state', state, 'manual_recovery_required', candidate, 'abc123', 'daily-deposit-review-v1', '', 'SIGTERM during deployment');
  const result = tryRun('can-resume-writes', state, candidate, data);
  assert.notStrictEqual(result.status, 0); assert.match(result.stderr, /requires manual investigation/);
});

test('deployment script records an interrupt-safe state before switching and traps catchable signals', () => {
  const deploy = fs.readFileSync(path.resolve(__dirname, '../deploy/deploy-v2.sh'), 'utf8');
  assert.match(deploy, /persist_deployment_state\ntrap on_deployment_signal HUP INT TERM/);
  assert.match(deploy, /pm2 stop solarpoints-v2/);
  assert.match(deploy, /live_read_only_healthy/);
});
