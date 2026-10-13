'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalApp } = require('./helpers/local-app');

test('pending accounts have no business access, can change their own password, and require a protected first role grant', { timeout: 30000 }, async t => {
  const app = await startLocalApp(); t.after(app.close);
  const admin = await app.login('admin');
  const storeId = (await app.request('GET', '/api/stores', null, admin)).data.items[0].id;
  const created = await app.request('POST', '/api/v2/users', {
    username: 'pending_only_fixture', name: 'Pending Only Fixture', password: app.password,
    role: 'admin', phone: 'must-not-persist', storeId,
  }, admin);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.item.role, 'pending_authorization');
  assert.equal(created.data.item.phone, '');
  const pendingLogin = await app.login('pending_only_fixture');
  const me = await app.request('GET', '/api/auth/me', null, pendingLogin);
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.grants, []);
  assert.equal((await app.request('GET', '/api/v2/workflows', null, pendingLogin)).status, 403);
  assert.equal((await app.request('GET', '/api/stores', null, pendingLogin)).status, 403);
  assert.equal((await app.request('PUT', `/api/v2/users/${created.data.item.id}/role`, { role: 'sales' }, pendingLogin)).status, 403);
  assert.equal((await app.request('PUT', `/api/v2/users/${created.data.item.id}/role`, { role: 'sales' }, admin)).status, 200);
  const grantedLogin = await app.request('POST', '/api/auth/login', { username: 'pending_only_fixture', password: app.changedPassword });
  assert.equal(grantedLogin.status, 200);
  const granted = await app.request('GET', '/api/auth/me', null, grantedLogin.cookie);
  assert.equal(granted.data.user.role, 'sales');
  assert.equal(granted.data.user.storeId, storeId);
  assert.equal((await app.request('PUT', `/api/v2/users/${created.data.item.id}/role`, { role: 'admin' }, admin)).status, 409, 'the endpoint cannot change an existing user role');
});

test('first role grant fails closed when the pending account lacks the required scope', { timeout: 30000 }, async t => {
  const app = await startLocalApp(); t.after(app.close);
  const admin = await app.login('admin');
  const created = await app.request('POST', '/api/v2/users', { username: 'scope_less_pending', name: 'Scope Less', password: app.password }, admin);
  assert.equal(created.status, 201);
  assert.equal((await app.request('PUT', `/api/v2/users/${created.data.item.id}/role`, { role: 'manager' }, admin)).status, 400);
  assert.equal((await app.request('PUT', `/api/v2/users/${created.data.item.id}/role`, { role: 'regional_manager' }, admin)).status, 400);
});
