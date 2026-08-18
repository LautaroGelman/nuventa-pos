'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const configStore = require('../src/main/config-store');

test('producción separa el sitio web de la API cloud', () => {
  assert.equal(configStore.isDev(), false);
  assert.deepEqual(configStore.getEnvUrls(), {
    webAppUrl: 'https://nuventa.com.ar',
    backendApiUrl: 'https://api.nuventa.com.ar',
  });
  assert.equal(configStore.get('backendApiUrl'), 'https://api.nuventa.com.ar');
});
