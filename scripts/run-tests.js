'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testDirectory = path.join(__dirname, '..', 'test');
const testFiles = fs.readdirSync(testDirectory)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(testDirectory, name));

if (testFiles.length === 0) {
  throw new Error('No se encontraron archivos *.test.js.');
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
