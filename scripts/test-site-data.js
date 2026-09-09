'use strict';

const { spawn } = require('child_process');
const path = require('path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
delete env.AIHUB_DIAG;
delete env.AIHUB_SCREENSHOT;

const tests = ['site-data.electron.js', 'navigation-state.electron.js'];

function run(index) {
  if (index >= tests.length) return;
  const child = spawn(require('electron'), [path.join(__dirname, '../tests', tests[index])], {
    env, stdio: 'inherit', windowsHide: true,
  });
  child.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    if (code !== 0) {
      process.exitCode = code === null ? 1 : code;
      return;
    }
    run(index + 1);
  });
}

run(0);
