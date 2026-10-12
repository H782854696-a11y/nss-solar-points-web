'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
test('department and people UI hides legacy organization and position write entry points', () => {
  assert.match(app, /Departments & people[\s\S]{0,240}data-org-new="departments"/,
    'the organization workspace starts with the department action');
  assert.match(app, /data-org-new="employees"/,
    'employees are added from the department directory');
  assert.match(app, /name="countryCode"[\s\S]{0,120}CN[\s\S]{0,120}PH/,
    'department creation explicitly selects CN or PH');
  assert.match(app, /internal code is generated automatically/,
    'department codes are generated and not entered by users');
  assert.match(app, /existing organization and position records remain read-only/i,
    'legacy records are disclosed as read-only compatibility data');
  assert.doesNotMatch(app, /id="ccOrgForm"/, 'there is no organization creation form');
});
