'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('control center keeps my approval count and my-work approval rows on the actionable source', () => {
  assert.match(appSource, /GET\('\/api\/v2\/workflows\?limit=10&offset=0&actionable=1'\)/);
  assert.match(appSource, /GET\('\/api\/v2\/tasks\?limit=10&offset=0&mine=1'\)/);
  assert.match(appSource, /const recentApprovalMatters = \(recentActionableWorkflowData\.items \|\| \[\]\)\s*\.filter\(w => ACTIVE_CONTROL_TYPES\[w\.type\] && w\.actionableForMe\)/);
  assert.match(appSource, /\$\{count\(workflowData\.pendingForMe\)\}/);
  assert.match(appSource, /data-c-work-kind="\$\{item\.kind\}"/);
  assert.match(appSource, /allWorkFilter\.textContent = `\$\{ccText\('All', '全部'\)\} \$\{recentMatters\.length\}\/\$\{recentWorkTotal\}`/);
});

test('control center work filters are interactive and activity remains permission-visible', () => {
  assert.match(appSource, /data-c-work-filter="approval"/);
  assert.match(appSource, /\$\$\('\[data-c-work-filter\]', cHome\).*addEventListener\('click'/);
  assert.match(appSource, /recentActivity\.map\(item/);
});
