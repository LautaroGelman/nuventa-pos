'use strict';

const { spawn } = require('child_process');
const electronBinary = require('electron');

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, ['test/electron-smoke.js', '--dev'], {
  cwd: process.cwd(),
  env: environment,
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (error) => {
  console.error('[SMOKE] Could not launch Electron:', error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) console.error(`[SMOKE] Electron terminated by ${signal}`);
  process.exitCode = code === 0 ? 0 : 1;
});
