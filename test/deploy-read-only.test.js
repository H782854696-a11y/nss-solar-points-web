const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nss-read-only-')); }
function fingerprint(dir) {
  const rows = [];
  function walk(at, relative = '') {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const child = path.join(at, entry.name), name = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child, name);
      else rows.push(`${name}:${crypto.createHash('sha256').update(fs.readFileSync(child)).digest('hex')}`);
    }
  }
  walk(dir); return rows.sort().join('\n');
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

test('read-only storage and audit paths do not alter existing, missing, or corrupt data files', () => {
  const sandbox = temp(); const data = path.join(sandbox, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, '_seeded.json'), JSON.stringify({ at: 'test' }));
  fs.writeFileSync(path.join(data, 'audit.log'), 'baseline\n');
  fs.writeFileSync(path.join(data, 'corruptProbe.json'), '{broken');
  const before = fingerprint(data);
  const script = `
    const store = require('./lib/store');
    store.readCollection('missingProbe');
    store.readCollection('corruptProbe');
    let blocked = false; try { store.writeCollection('users', []); } catch { blocked = true; }
    if (!blocked) process.exit(9);
    require('./lib/audit').auditLog('must not be written');
  `;
  execFileSync(process.execPath, ['-e', script], { cwd: root, env: { ...process.env, SP_DATA_DIR: data, SP_DEPLOY_READ_ONLY: '1' } });
  assert.equal(fingerprint(data), before);
  assert.equal(fs.existsSync(path.join(data, 'missingProbe.json')), false);
});

test('read-only server health validation rejects writes without modifying its data directory', { timeout: 15000 }, async t => {
  const sandbox = temp(); const data = path.join(sandbox, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, '_seeded.json'), JSON.stringify({ at: 'test' }));
  fs.writeFileSync(path.join(data, 'audit.log'), 'baseline\n');
  const before = fingerprint(data), port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, SP_DATA_DIR: data, SP_DEPLOY_READ_ONLY: '1', SP_DISABLE_BACKGROUND_JOBS: '1', PORT: String(port) }, stdio: 'ignore' });
  t.after(() => { child.kill(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 50 && !healthy; i += 1) { try { healthy = (await fetch(`${base}/api/health`)).ok; } catch {} if (!healthy) await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.equal(healthy, true);
  const blocked = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(blocked.status, 503);
  assert.equal(fingerprint(data), before);
});
