'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('published announcement count stays informational and readable in every sidebar state', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui-review.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(app, /setNavBadge\('#navAnnouncementCount', announcements\.filter\(item => item\.status === 'published'\)\.length\);/);
  assert.match(css, /\[data-workspace="announcements"\] \.nav-count-neutral,/);
  assert.match(css, /\[data-workspace="announcements"\]\.active \.nav-count-neutral,/);
  assert.match(css, /\[data-workspace="announcements"\]:hover \.nav-count-neutral/);
  assert.match(css, /background: #F8FAFC;\s*color: #17202A;/);
  assert.match(html, /ui-review\.css\?v=35/);
});
