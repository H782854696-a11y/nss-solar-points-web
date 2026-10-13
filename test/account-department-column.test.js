'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('account list shows only the linked employee department, never a role label or inferred link', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const accounts = app.match(/async function renderAccounts\(root\) \{[\s\S]*?\n\}\n\n\/\*\* 启用 \/ 停用/)?.[0] || '';
  const departmentRows = accounts.match(/const departmentNameFor = \(a\) => \{[\s\S]*?\n  \};\n\n  \/\/ 表头/)?.[0] || '';

  assert.match(i18n, /'accounts\.colRole': \['Department', '部门'\]/);
  assert.match(accounts, /GET\('\/api\/v2\/departments'\)/);
  assert.match(departmentRows, /const departmentNameFor = \(a\) => \{/);
  assert.match(departmentRows, /accountEmployees\.find\(x => x\.userId === a\.id\)/);
  assert.match(departmentRows, /if \(!employee\?\.departmentId\) return '—';/);
  assert.match(departmentRows, /accountDepartments\.find\(x => x\.id === employee\.departmentId\)/);
  assert.match(departmentRows, /return department\?\.name \|\| '—';/);
  assert.doesNotMatch(departmentRows, /a\.employeeId/);
  assert.doesNotMatch(departmentRows, /roleLabel\(a\.role\)/);
  assert.equal((departmentRows.match(/escapeHtml\(departmentNameFor\(a\)\)/g) || []).length, 2);
  assert.match(html, /app\.js\?v=110/);
});
