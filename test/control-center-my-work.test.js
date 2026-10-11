'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('control center keeps my approval count and my-work approval rows on the actionable source', () => {
  assert.match(appSource, /const recentApprovalMatters = \(recentWorkflowData\.items \|\| \[\]\)\s*\.filter\(w => ACTIVE_CONTROL_TYPES\[w\.type\] && w\.actionableForMe\)/);
  assert.match(appSource, /\$\{count\(workflowData\.pendingForMe\)\}/);
  assert.match(appSource, /data-c-work-kind="\$\{item\.kind\}"/);
});

test('control center work filters are interactive and activity remains permission-visible', () => {
  assert.match(appSource, /data-c-work-filter="approval"/);
  assert.match(appSource, /\$\$\('\[data-c-work-filter\]', cHome\).*addEventListener\('click'/);
  assert.match(appSource, /recentActivity\.map\(item/);
});
