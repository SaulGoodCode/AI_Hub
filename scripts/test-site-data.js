'use strict';

const { spawn } = require('child_process');
const path = require('path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
delete env.AIHUB_DIAG;
delete env.AIHUB_SCREENSHOT;
const child = spawn(require('electron'), [path.join(__dirname, '../tests/site-data.electron.js')], {
  env, stdio: 'inherit', windowsHide: true,
});
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code === null ? 1 : code; });
