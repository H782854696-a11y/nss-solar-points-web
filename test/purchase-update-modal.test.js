'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('shipping update modal serializes its visible fields and keeps its action footer reachable', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
  const css = fs.readFileSync(path.resolve(__dirname, '../public/styles.css'), 'utf8');
  const modalStart = app.indexOf('title: `${ccText(\'Update shipping status\'');
  const modalEnd = app.indexOf("$$('[data-purchase-file]'", modalStart);
  assert.ok(modalStart >= 0 && modalEnd > modalStart, 'shipping-update modal must exist');
  const section = app.slice(modalStart, modalEnd);
  assert.match(section, /<form id="ccPurchaseUpdate" class="cc-form-grid">/);
  for (const field of ['stage', 'vessel', 'blNo', 'containerNo', 'eta', 'arrivalDate', 'stageNote', 'note', 'attachments']) assert.match(section, new RegExp(`name="${field}"`), field);
  assert.match(section, /const fd = new FormData\(form\)/, 'save must serialize the update form, not an empty fallback form');
  assert.match(section, /await POST\(`\/api\/v2\/purchase-shipments\/\$\{encodeURIComponent\(record\.id\)\}`, payload\)/);
  assert.match(section, /save\.disabled = true/);
  assert.match(section, /save\.disabled = false; toast\(err\.message, 'error'\)/, 'failure keeps the form open and re-enables retry');
  assert.match(css, /\.modal \{[\s\S]*overflow: hidden;[\s\S]*display: flex; flex-direction: column;/);
  assert.match(css, /\.modal-body \{[\s\S]*min-height: 0;[\s\S]*overflow: auto;/);
  assert.match(css, /\.modal-footer \{[\s\S]*flex-shrink: 0;/);
});
