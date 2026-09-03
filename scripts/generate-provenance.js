'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const workspace = path.dirname(root);
const repos = {
  pos: root,
  frontend: process.env.NUVENTA_FRONTEND_DIR || path.join(workspace, 'nuventa-frontend-mp-orders'),
  backend: process.env.NUVENTA_BACKEND_DIR || path.join(workspace, 'nuventa-backend-mp-orders'),
};

function commit(directory) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return 'unavailable'; }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const contract = JSON.parse(fs.readFileSync(path.join(root, 'pos-contract.json'), 'utf8'));
const provenance = {
  version: pkg.version,
  storeVersion: `${pkg.version}.0`,
  contractVersion: contract.contractVersion,
  architecture: 'x64',
  commits: Object.fromEntries(Object.entries(repos).map(([name, directory]) => [name, commit(directory)])),
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(root, 'build-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(JSON.stringify(provenance));
