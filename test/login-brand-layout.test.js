'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');

test('login uses the original small upper-left NSS Solar logo with no promotional copy', () => {
  assert.match(index, /src="\/nss-solar-horizontal-logo-clean\.png"/);
  assert.doesNotMatch(index, /login-promo-copy|login\.titleMain|login\.titleAccent|login\.subtitle/);
  assert.match(css, /#loginPage \.login-logo \{ display:block; width:clamp\(280px,21vw,320px\)/);
  assert.doesNotMatch(css, /#loginPage \.login-logo[^}]*mix-blend-mode:/);
  assert.match(index, /styles\.css\?v=57/);
});
