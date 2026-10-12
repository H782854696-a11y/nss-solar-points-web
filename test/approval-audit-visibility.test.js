'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('approval workflow no longer renders or fetches the operation-audit panel', () => {
  assert.doesNotMatch(app, /data-cc-area="governance"[^`]*操作审计/);
  assert.doesNotMatch(app, /\/api\/v2\/audit-events/);
  assert.doesNotMatch(app, /ccAuditFilterForm|data-audit-page|data-audit-reset/);
});

test('audit recording, permission-protected API, and separate audit page remain available', () => {
  assert.match(server, /function recordControlAudit\(/);
  assert.match(server, /writeAll\('auditEvents', events\)/);
  assert.match(server, /app\.get\('\/api\/v2\/audit-events'/);
  assert.match(server, /checkPerm\(req, res, 'system\.audit\.view'\)/);
  assert.match(app, /function renderAudit\(/);
});
