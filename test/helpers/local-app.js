'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const password = 'IsolatedOnlyPassword2026!';
const changedPassword = 'IsolatedChangedPassword2026!';
const photo = { fileName: 'evidence.png', mimeType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=' };
async function startLocalApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-workflow-regression-'));
  const port = await new Promise((resolve,reject) => {
    const server = net.createServer(); server.once('error',reject);
    server.listen(0,'127.0.0.1',() => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname,'../..'), env: { ...process.env, SP_DATA_DIR: dataDir, SP_ADMIN_PASSWORD: password, PORT: String(port) }, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data',x => { output += x; }); child.stderr.on('data',x => { output += x; });
  const base = `http://127.0.0.1:${port}`;
  const request = async (method,url,body,cookie = '') => {
    const response = await fetch(base + url, { method, headers: { ...(body ? {'content-type':'application/json'} : {}), ...(cookie ? {cookie} : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
  };
  const close = async () => { if (child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit',resolve)); child.kill(); await stopped; } fs.rmSync(dataDir,{recursive:true,force:true}); };
  const login = async username => {
    const first = await request('POST','/api/auth/login',{username,password});
    if (first.status !== 200) throw new Error(JSON.stringify(first));
    const changed = await request('POST','/api/auth/change-password',{currentPassword:password,newPassword:changedPassword},first.cookie);
    if (changed.status !== 200) throw new Error(JSON.stringify(changed));
    return changed.cookie;
  };
  // Production account creation deliberately ignores a submitted role. Tests
  // that need a business actor must model the same two protected actions an
  // administrator performs: create a pending account, then grant its role.
  const createPendingThenGrant = async (adminCookie, payload, role = payload.role) => {
    const pending = { ...payload }; delete pending.role; delete pending.phone;
    const created = await request('POST', '/api/v2/users', pending, adminCookie);
    if (created.status !== 201 || !role) return created;
    const granted = await request('PUT', `/api/v2/users/${encodeURIComponent(created.data.item.id)}/role`, { role }, adminCookie);
    return granted.status === 200 ? created : granted;
  };
  for(let n=0;n<100;n++){
    try { if ((await request('GET','/api/health')).status === 200) return {base,dataDir,request,login,createPendingThenGrant,close,password,changedPassword}; } catch {}
    if(child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve,100));
  }
  await close(); throw new Error('Local app did not start: '+output);
}
module.exports = { startLocalApp, photo };
