#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { runMigration } = require(path.join(__dirname, '..', 'lib', 'password-change-policy'));
const args = process.argv.slice(2);
const mode = args.includes('--apply') ? 'apply' : args.includes('--dry-run') ? 'dry-run' : null;
const dataIndex = args.indexOf('--data-dir');
const dataDir = dataIndex >= 0 ? args[dataIndex + 1] : null;
if (!mode || !dataDir || dataIndex === args.length - 1 || args.length !== 3) {
  console.error('Usage: migrate-password-change-policy.js --data-dir <directory> --dry-run|--apply'); process.exit(2);
}
try { console.log(JSON.stringify({ mode, ...runMigration(dataDir, { apply: mode === 'apply' }) })); }
catch (error) { console.error(`password-change-policy migration refused: ${error.message}`); process.exit(1); }
