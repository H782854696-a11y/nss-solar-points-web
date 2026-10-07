'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const shellSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'service-worker.js'), 'utf8');
// 缓存版本号以 service-worker.js 为准，测试不再硬编码（bump 缓存时无需改测试）
const currentCache = 'nss-control-shell-v' + shellSource.match(/CACHE_PREFIX\}(\d+)`/)[1];

test('PWA shell survives versioned offline URLs and preserves unrelated caches', async () => {
  const listeners = new Map();
  const stores = new Map([
    ['nss-control-shell-v11', new Map([['/old.js', { name: 'old' }]])],
    ['unrelated-member-cache', new Map([['/member.js', { name: 'member' }], ['/app.js', { name: 'wrong-member-app' }]])],
  ]);
  const keyOf = request => typeof request === 'string' ? request : new URL(request.url).pathname + new URL(request.url).search;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async addAll(urls) { for (const url of urls) entries.set(url, { name: url, ok: true }); },
        async put(request, response) { entries.set(keyOf(request), response); },
        async match(request, options = {}) {
          const key = keyOf(request);
          if (entries.has(key)) return entries.get(key);
          if (options.ignoreSearch) {
            const pathname = key.split('?')[0];
            for (const [candidate, response] of entries) if (candidate.split('?')[0] === pathname) return response;
          }
          return undefined;
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request, options = {}) {
      const key = keyOf(request);
      for (const entries of stores.values()) {
        if (entries.has(key)) return entries.get(key);
        if (options.ignoreSearch) {
          const pathname = key.split('?')[0];
          for (const [candidate, response] of entries) if (candidate.split('?')[0] === pathname) return response;
        }
      }
      return undefined;
    },
  };
  let online = false, claimed = false;
  const self = {
    location: { origin: 'https://nss.example' },
    clients: { async claim() { claimed = true; } },
    skipWaiting() {},
    addEventListener(type, handler) { listeners.set(type, handler); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'service-worker.js'), 'utf8'), {
    self, caches, URL, Promise,
    fetch: async request => {
      if (!online) throw new Error('offline');
      return { name: keyOf(request), ok: true, clone() { return this; } };
    },
  });
  async function lifecycle(type) {
    const work = [];
    listeners.get(type)({ waitUntil(promise) { work.push(promise); } });
    await Promise.all(work);
  }
  await lifecycle('install');
  await lifecycle('activate');
  assert.equal(claimed, true);
  assert.equal(stores.has('nss-control-shell-v11'), false);
  assert.equal(stores.has('unrelated-member-cache'), true);
  // 缓存版本号从 service-worker.js 动态读取，避免每次 bump 缓存都要改测试
  assert.equal(stores.has(currentCache), true);

  async function resource(url, mode = 'no-cors') {
    let responsePromise;
    const work = [];
    listeners.get('fetch')({
      request: { url: `https://nss.example${url}`, method: 'GET', mode },
      respondWith(promise) { responsePromise = promise; },
      waitUntil(promise) { work.push(promise); },
    });
    const response = responsePromise ? await responsePromise : undefined;
    await Promise.all(work);
    return response;
  }
  assert.equal((await resource('/app.js?v=50')).name, '/app.js');
  assert.equal((await resource('/styles.css?v=39')).name, '/styles.css');
  assert.equal((await resource('/other-page', 'navigate')).name, '/');
  assert.equal(await resource('/api/v2/workflows'), undefined);
  online = true;
  assert.equal((await resource('/app.js?v=51')).name, '/app.js?v=51');
  assert.equal(stores.get(currentCache).has('/app.js?v=51'), true);
  // 预缓存清单必须包含安装所需的 PNG 图标（iOS apple-touch-icon 等）
  for (const icon of ['/pwa-icon-180.png', '/pwa-icon-192.png', '/pwa-icon-512.png', '/pwa-icon-maskable-512.png']) {
    assert.equal(stores.get(currentCache).has(icon), true, `PWA 图标未预缓存: ${icon}`);
  }
});
