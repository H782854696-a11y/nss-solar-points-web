'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(publicDir, 'service-worker.js'), 'utf8');

test('login uses the original small upper-left NSS Solar logo with no promotional copy', () => {
  const loginLogo = index.match(/<img\s+[^>]*class="login-logo"[^>]*>/)?.[0] || '';
  assert.match(loginLogo, /src="\/nss-solar-horizontal-logo-transparent\.png"/);
  assert.doesNotMatch(loginLogo, /src="\/nss-solar-horizontal-logo\.png"/);
  assert.doesNotMatch(index, /login-promo-copy|login\.titleMain|login\.titleAccent|login\.subtitle/);
  assert.match(css, /#loginPage \.login-logo \{ display:block; width:clamp\(280px,21vw,320px\)/);
  assert.doesNotMatch(css, /#loginPage \.login-logo[^}]*mix-blend-mode:/);
  const stylesLink = index.match(/<link rel="stylesheet" href="(\/styles\.css\?v=(\d+))"\s*\/>/);
  assert.ok(stylesLink, 'index must cache-bust the stylesheet it actually serves');
  assert.ok(Number(stylesLink[2]) > 0, 'stylesheet cache version must be a positive integer');
  assert.match(serviceWorker, /const CACHE = `\$\{CACHE_PREFIX\}\d+`;/);
  assert.match(serviceWorker, /const SHELL = \[[\s\S]*?'\/styles\.css'/);
  assert.match(serviceWorker, /ignoreSearch: true/);
});
