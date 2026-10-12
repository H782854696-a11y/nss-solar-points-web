'use strict';

// Keep local development data out of the repository's data/ directory on every
// supported platform.  An explicitly supplied SP_DATA_DIR always wins.
const { spawn } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const env = {
  ...process.env,
  SP_DATA_DIR: process.env.SP_DATA_DIR || path.join(projectRoot, '.local-data')
};

const child = spawn(process.execPath, ['server.js'], {
  cwd: projectRoot,
  env,
  stdio: 'inherit'
});

child.on('error', error => {
  console.error(`Unable to start the local development server: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', code => {
  process.exitCode = code === null ? 1 : code;
});
