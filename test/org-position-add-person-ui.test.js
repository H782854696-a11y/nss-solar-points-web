'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/ui-review.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

test('organization tree allows adding an employee profile directly to a position', () => {
  assert.match(app, /can\('staff\.create'\)[\s\S]{0,180}data-position-add-person=/,
    'add-person action is only rendered for staff-create permission');
  assert.match(app, /positions\.filter\(position => !departments\.some\(department => department\.id === position\.departmentId\)\)\.map\(renderOrganizationPosition\)/,
    'positions without a linked department remain reachable from the organization tree');
  assert.ok(app.includes("$$('[data-position-add-person]', root)"),
    'position action has a click handler');
  assert.match(app, /id="ccPositionEmployeeForm"/,
    'position action opens a dedicated employee form');
  assert.match(app, /Object\.assign\(payload, \{ positionId: position\.id, departmentId: department\?\.id \|\| '', organizationId: department\?\.organizationId \|\| '' \}\)/,
    'new employee inherits the selected position and its department/organization');
  assert.match(app, /POST\('\/api\/v2\/employees', payload\)/,
    'form persists through the existing employee API');
  assert.match(app, /Login access can be linked later in Account Management[\s\S]*?如需登录账号，可之后在账号管理中绑定/,
    'the UI distinguishes an employee profile from a login account');
  assert.match(css, /\.app-shell \.cc-position-add-person[\s\S]*?@media \(max-width:640px\)[\s\S]*?\.app-shell \.cc-position-actions/,
    'the position action has mobile layout rules');
});
