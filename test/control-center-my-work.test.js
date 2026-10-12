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

test('approval views label all visible records separately from the actionable badge and accounts have no count badge', () => {
  assert.match(appSource, /const pendingForMe = count\(workflowData\.pendingForMe\)/);
  assert.match(appSource, /ccText\('All approvals', '全部审批'\)/);
  assert.match(appSource, /ccText\('My pending approvals', '待我审批'\)/);
  assert.match(appSource, /显示你有权限查看的全部审批记录；点击“待我审批”可查看与侧栏数字一致的项目/);
  assert.match(appSource, /const approvalLabel = \$\('#navApprovalLabel'\)/);
  assert.doesNotMatch(appSource, /navAccountCount/);
});
