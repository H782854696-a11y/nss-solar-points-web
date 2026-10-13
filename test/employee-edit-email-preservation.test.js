'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startLocalApp } = require('./helpers/local-app');

test('employee editor omits email while partial updates retain stored legacy email', { timeout: 30000 }, async t => {
  const app = await startLocalApp(); t.after(app.close);
  const admin = await app.login('admin');
  const created = await app.request('POST', '/api/v2/employees', { name: 'Email preservation fixture', email: 'legacy@example.test' }, admin);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const updated = await app.request('PUT', `/api/v2/employees/${created.data.item.id}`, { name: 'Renamed fixture', departmentId: '' }, admin);
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.item.email, 'legacy@example.test');

  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const editor = source.match(/const modal = openModal\(\{ title: ccText\('Edit employee'[\s\S]*?\}\);\n    \$\('#ccEmployeeSave'/)?.[0] || '';
  assert.match(editor, /name="name"/);
  assert.match(editor, /name="departmentId"/);
  assert.doesNotMatch(editor, /name="email"/);
});
