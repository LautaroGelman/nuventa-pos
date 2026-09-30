// Build the exact frontend checkout selected by the POS release workflow and
// copy its static export into the Electron resources directory.
'use strict';

const { cpSync, existsSync, mkdirSync, rmSync } = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const posRoot = path.resolve(__dirname, '..');
const frontendDir = path.resolve(
  process.env.NUVENTA_FRONTEND_DIR || path.join(posRoot, '..', 'nuventa-frontend-dev')
);
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

if (!existsSync(path.join(frontendDir, 'package.json'))) {
  throw new Error(`Frontend checkout not found at ${frontendDir}`);
}

execFileSync(pnpm, ['build'], {
  cwd: frontendDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (process.argv.includes('--build-only')) process.exit(0);

const source = path.join(frontendDir, 'out');
const destination = path.join(posRoot, 'resources', 'web');
if (!existsSync(source)) throw new Error(`Frontend static export not found at ${source}`);
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
console.log('Web assets copied to', destination);
