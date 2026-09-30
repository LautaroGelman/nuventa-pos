'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { resolveQaEnvironment, initializeQaEnvironment } = require('../src/main/qa-environment');
const env = { NUVENTA_POS_QA_WEB_URL: 'http://localhost:3010/', NUVENTA_POS_QA_API_URL: 'http://127.0.0.1:8088' };
const argv = ['electron', '.', '--dev', '--qa'];

test('QA settings have no effect without the explicit QA flag', () => {
  assert.equal(resolveQaEnvironment({ argv: [], env }), null);
  assert.equal(resolveQaEnvironment({ argv: ['--dev'], env }), null);
});
test('QA refuses production and packaged startup rather than falling back to cloud', () => {
  assert.throws(() => resolveQaEnvironment({ argv: ['--qa'], env }), /requiere --dev/);
  assert.throws(() => resolveQaEnvironment({ argv, env, packaged: true }), /sin empaquetar/);
});
test('QA accepts only complete loopback origins', () => {
  assert.deepEqual(resolveQaEnvironment({ argv, env }), {
    webAppUrl: 'http://localhost:3010', backendApiUrl: 'http://127.0.0.1:8088',
  });
  for (const value of ['', 'https://api.nuventa.com.ar', 'http://127.0.0.1.evil.invalid',
    'file:///tmp', 'http://user:password@localhost:8088', 'http://localhost:8088/api',
    'http://localhost:8088/?secret=x', 'http://localhost:8088/#x']) {
    assert.throws(() => resolveQaEnvironment({ argv, env: { ...env, NUVENTA_POS_QA_API_URL: value } }));
  }
});
test('every QA startup selects a new directory before persistence is loaded', () => {
  const selected = [];
  const app = { isPackaged: false, getPath(name) { assert.equal(name, 'temp'); return os.tmpdir(); },
    setPath(name, value) { assert.equal(name, 'userData'); selected.push(value); } };
  try {
    const first = initializeQaEnvironment(app, { argv, env });
    const second = initializeQaEnvironment(app, { argv, env });
    assert.notEqual(first.profile, second.profile);
    assert.deepEqual(selected, [first.profile, second.profile]);
    assert.equal(fs.readdirSync(first.profile).length, 0);
    assert.equal(fs.readdirSync(second.profile).length, 0);
  } finally { for (const directory of selected) fs.rmdirSync(directory); }
});
