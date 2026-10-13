'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startLocalApp, photo } = require('./helpers/local-app');

test('announcement images are validated, atomic, visible only with their published announcement, and backwards compatible', { timeout: 60000 }, async t => {
  const app = await startLocalApp(); t.after(app.close);
  const { request, login, dataDir } = app;
  const admin = await login('admin');
  const storeId = (await request('GET', '/api/stores', null, admin)).data.items[0].id;
  const readerResult = await app.createPendingThenGrant(admin, { username: 'announcement_reader', name: 'Announcement Reader', role: 'sales', storeId, password: app.password });
  assert.equal(readerResult.status, 201, JSON.stringify(readerResult.data));
  const reader = await login('announcement_reader');
  const list = () => request('GET', '/api/v2/announcements', null, admin);
  const countFiles = () => {
    const dir = path.join(dataDir, 'uploads', 'announcements');
    return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  };

  await t.test('invalid image payloads create neither announcements nor files', async () => {
    const before = (await list()).data.items.length;
    const beforeFiles = countFiles();
    for (const images of [
      { fileName: 'not-an-array.png' },
      [{ ...photo, mimeType: 'image/svg+xml' }],
      [{ ...photo, data: 'data:image/png;base64,ZXhl' }],
      Array(11).fill(photo),
    ]) {
      const result = await request('POST', '/api/v2/announcements', { title: 'Invalid image', body: 'Must not publish', images }, admin);
      assert.equal(result.status, 400, JSON.stringify(result.data));
    }
    assert.equal((await list()).data.items.length, before);
    assert.equal(countFiles(), beforeFiles);
  });

  await t.test('storage failure rolls back the announcement before publishing', async () => {
    const uploadsPath = path.join(dataDir, 'uploads');
    fs.writeFileSync(uploadsPath, 'not a directory');
    const result = await request('POST', '/api/v2/announcements', { title: 'Atomic failure', body: 'No half-published notice', images: [photo] }, admin);
    assert.equal(result.status, 500, JSON.stringify(result.data));
    fs.unlinkSync(uploadsPath);
    assert.equal((await list()).data.items.some(item => item.title === 'Atomic failure'), false);
    assert.equal(countFiles(), 0);
  });

  let announcement;
  await t.test('PNG attachments save atomically and old attachment-free announcements stay readable', async () => {
    const old = await request('POST', '/api/v2/announcements', { title: 'No attachment legacy compatibility', body: 'Existing notices still work' }, admin);
    assert.equal(old.status, 201, JSON.stringify(old.data));
    assert.deepEqual(old.data.item.attachments, []);

    const created = await request('POST', '/api/v2/announcements', {
      title: 'Image announcement', body: 'Two safe images', pinned: true,
      images: [{ ...photo, fileName: '../../receipt.png' }, { ...photo, fileName: 'second.png' }],
    }, admin);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    announcement = created.data.item;
    assert.equal(announcement.attachments.length, 2);
    assert.equal(announcement.attachments.every(item => item.mimeType === 'image/png' && !Object.hasOwn(item, 'storedName')), true, 'storage paths are never sent to clients');
    assert.equal(countFiles(), 2);
    const published = (await list()).data.items.find(item => item.id === announcement.id);
    assert.equal(published.attachments.length, 2);
    assert.equal((await list()).data.items.find(item => item.id === old.data.item.id).attachments.length, 0);
  });

  await t.test('preview is authenticated, tied to its own published announcement, and preserves the original reader audience', async () => {
    const attachment = announcement.attachments[0];
    const endpoint = `/api/v2/announcements/${announcement.id}/attachments/${attachment.id}/preview`;
    assert.equal((await fetch(app.base + endpoint)).status, 401);
    const readerPreview = await fetch(app.base + endpoint, { headers: { cookie: reader } });
    assert.equal(readerPreview.status, 200);
    assert.equal(readerPreview.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await readerPreview.arrayBuffer()), Buffer.from(photo.data.split(',')[1], 'base64'));
    assert.equal((await request('POST', '/api/v2/announcements', { title: 'Denied', body: 'No manager permission' }, reader)).status, 403);
    const other = await request('POST', '/api/v2/announcements', { title: 'Other announcement', body: 'No attachment' }, admin);
    assert.equal(other.status, 201);
    assert.equal((await fetch(app.base + `/api/v2/announcements/${other.data.item.id}/attachments/${attachment.id}/preview`, { headers: { cookie: reader } })).status, 404, 'attachment ids cannot be used across announcements');
    assert.equal((await request('PUT', `/api/v2/announcements/${announcement.id}`, { title: announcement.title, body: announcement.body, pinned: true, status: 'archived' }, admin)).status, 200);
    assert.equal((await fetch(app.base + endpoint, { headers: { cookie: reader } })).status, 404, 'archived announcements do not create a new attachment-read path');
  });
});

test('announcement composer exposes optional multi-image previews and keeps existing publish controls', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
  const css = fs.readFileSync(path.resolve(__dirname, '../public/styles.css'), 'utf8');
  const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
  assert.match(app, /name="images" type="file" multiple accept="image\/png,image\/jpeg/);
  assert.match(app, /data-announcement-draft-images/);
  assert.match(app, /data-announcement-image-remove/);
  assert.match(app, /images: await announcementImages\(selectedImages\)/);
  assert.match(app, /data-announcement-image-preview/);
  assert.match(app, /name="title" required maxlength="180"/);
  assert.match(app, /name="body" required maxlength="5000"/);
  assert.match(app, /name="pinned" type="checkbox"/);
  assert.match(css, /\.cc-announcement-draft-images/);
  assert.match(css, /\.cc-announcement-image/);
  assert.match(html, /styles\.css\?v=63/);
});
