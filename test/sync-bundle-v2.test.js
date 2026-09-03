'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson, sha256, retryDelaySeconds, MAX_MUTATIONS, MAX_REQUEST_BYTES } =
  require('../src/main/sync-bundle-v2');

test('el hash de idempotencia no depende del orden de las claves', () => {
  const first = canonicalJson({ z: 3, nested: { b: true, a: 'x' }, list: [{ y: 2, x: 1 }] });
  const second = canonicalJson({ list: [{ x: 1, y: 2 }], nested: { a: 'x', b: true }, z: 3 });
  assert.equal(first, second);
  assert.equal(sha256(first), sha256(second));
  assert.match(sha256(first), /^[0-9a-f]{64}$/);
});

test('los límites del contrato quedan fijados en 50 mutaciones y 1 MiB', () => {
  assert.equal(MAX_MUTATIONS, 50);
  assert.equal(MAX_REQUEST_BYTES, 1024 * 1024);
});

test('el backoff usa jitter acotado entre 15 segundos y 5 minutos', () => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const value = retryDelaySeconds(attempt);
    assert.ok(value >= 15);
    assert.ok(value <= 300);
  }
});
