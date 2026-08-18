'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isMicrosoftStoreDistribution } = require('../src/main/distribution');

test('detecta una instalacion administrada por Microsoft Store', () => {
  assert.equal(isMicrosoftStoreDistribution({ platform: 'win32', windowsStore: true }), true);
});

test('mantiene el actualizador propio en instalaciones directas', () => {
  assert.equal(isMicrosoftStoreDistribution({ platform: 'win32', windowsStore: false }), false);
  assert.equal(isMicrosoftStoreDistribution({ platform: 'linux', windowsStore: true }), false);
});
