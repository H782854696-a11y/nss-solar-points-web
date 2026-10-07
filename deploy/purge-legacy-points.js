#!/usr/bin/env node
// Purge only collections owned by the retired points application. Run after
// deploying the blocking routes, with solarpoints-v2 stopped and a backup made.
const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(process.env.SP_DATA_DIR || '');
if (process.argv[2] !== '--apply' || dataDir !== '/opt/solarpoints-v2/data') {
  console.error('Requires --apply and SP_DATA_DIR=/opt/solarpoints-v2/data');
  process.exit(2);
}
const legacy = ['members', 'transactions', 'rules', 'pending', 'products', 'redemptions', 'sheets', 'expiry-state'];
for (const name of legacy) {
  const file = path.join(dataDir, `${name}.json`);
  if (fs.existsSync(file)) { fs.unlinkSync(file); console.log(`Removed ${name}.json`); }
}
const oldImages = path.join(dataDir, 'uploads', 'mall');
if (fs.existsSync(oldImages)) { fs.rmSync(oldImages, { recursive: true, force: true }); console.log('Removed uploads/mall'); }
console.log('Retired points collections removed; shared stores, users and V2 collections retained.');
