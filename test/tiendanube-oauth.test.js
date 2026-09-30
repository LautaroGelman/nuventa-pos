'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { authorizeTiendanube, validateAuthorization, callbackResult } = require('../src/main/tiendanube-oauth');

test('only Tiendanube authorization URLs enter the isolated OAuth window', () => {
  assert.equal(validateAuthorization('https://www.tiendanube.com/apps/123/authorize?state=nonce').hostname, 'www.tiendanube.com');
  for (const url of ['http://www.tiendanube.com/apps/123/authorize?state=x',
    'https://www.tiendanube.com.evil.invalid/apps/123/authorize?state=x',
    'https://www.tiendanube.com/apps/123/authorize', 'file:///private'])
    assert.throws(() => validateAuthorization(url));
});

test('callback requires the exact origin, route and state', () => {
  const origins = ['https://www.nuventa.com.ar'];
  assert.equal(callbackResult('https://evil.invalid/tn-callback?code=c&state=s', origins, 's'), null);
  assert.equal(callbackResult('https://www.nuventa.com.ar/other?code=c&state=s', origins, 's'), null);
  assert.throws(() => callbackResult('https://www.nuventa.com.ar/tn-callback?code=c&state=wrong', origins, 's'));
  assert.deepEqual(callbackResult('https://www.nuventa.com.ar/tn-callback/?code=c&state=s', origins, 's'), { code: 'c', state: 's' });
});

test('OAuth popup has no preload, uses ephemeral storage and returns only code/state', async () => {
  let popup; let options; let cleared = false;
  class FakeWindow extends EventEmitter {
    constructor(opts) { super(); options = opts; popup = this; this.dead = false;
      this.webContents = new EventEmitter(); this.webContents.session = new EventEmitter();
      this.webContents.session.clearStorageData = async () => { cleared = true; };
      this.webContents.session.setPermissionRequestHandler = () => {};
      this.webContents.setWindowOpenHandler = () => {};
    }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
    async loadURL() {}
  }
  const result = authorizeTiendanube({ BrowserWindow: FakeWindow, webAppUrl: 'https://www.nuventa.com.ar',
    authorizeUrl: 'https://www.tiendanube.com/apps/123/authorize?state=nonce' });
  let prevented = false;
  popup.webContents.emit('will-redirect', { preventDefault() { prevented = true; } },
    'https://www.nuventa.com.ar/tn-callback?code=code&state=nonce');
  assert.deepEqual(await result, { code: 'code', state: 'nonce' });
  assert.equal(options.webPreferences.preload, undefined);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.sandbox, true);
  assert.ok(!options.webPreferences.partition.startsWith('persist:'));
  assert.equal(prevented, true); assert.equal(cleared, true);
});
