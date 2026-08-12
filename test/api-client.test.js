'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiClient } = require('../src/main/api-client');

test('normaliza la sucursal activa y construye rutas válidas', () => {
  const client = new ApiClient();
  client.setBaseUrl('http://localhost:8080/');
  client.setAuth({ token: 'token', clientId: 1, sucursalId: '2', employeeId: null });

  assert.equal(client.sucursalId, 2);
  assert.equal(client._branchPath(), 'http://localhost:8080/api/client-panel/1/sucursales/2');
});

test('nunca genera rutas con sucursal undefined, null o cero', () => {
  for (const sucursalId of [undefined, null, '', 0, '0', 'abc']) {
    const client = new ApiClient();
    client.setAuth({ token: 'token', clientId: 1, sucursalId, employeeId: null });
    assert.throws(() => client._branchPath(), /sucursal activa válida/);
  }
});

test('cambiar de sucursal invalida el ciclo de sincronización en vuelo', () => {
  const client = new ApiClient();
  client.setAuth({ token: 'token', clientId: 1, sucursalId: 1, employeeId: null });
  const epoch = client.authEpoch;

  client.setActiveBranch(2);

  assert.equal(client.sucursalId, 2);
  assert.equal(client.authEpoch, epoch + 1);
});

test('consulta la disponibilidad autoritativa de cajas de la sucursal activa', async () => {
  const client = new ApiClient();
  client.setBaseUrl('http://localhost:8080');
  client.setAuth({ token: 'token', clientId: 7, sucursalId: 9, employeeId: 3 });
  let requestedUrl = null;
  client._fetch = async (url) => {
    requestedUrl = url;
    return [{ occupied: true }];
  };

  const result = await client.getRegisterAvailability(true);

  assert.equal(
    requestedUrl,
    'http://localhost:8080/api/client-panel/7/sucursales/9/registers/availability?onlyActive=true'
  );
  assert.deepEqual(result, [{ occupied: true }]);
});

test('consulta una venta puntual para iniciar una devolución', async () => {
  const client = new ApiClient();
  client.setBaseUrl('http://localhost:8080');
  client.setAuth({ token: 'token', clientId: 7, sucursalId: 9, employeeId: 3 });
  let requestedUrl = null;
  client._fetch = async (url) => {
    requestedUrl = url;
    return { id: 41 };
  };

  const result = await client.getSaleById(41);

  assert.equal(
    requestedUrl,
    'http://localhost:8080/api/client-panel/7/sucursales/9/sales/41'
  );
  assert.deepEqual(result, { id: 41 });
});

test('reintenta el documento fiscal de una devolución en la sucursal activa', async () => {
  const client = new ApiClient();
  client.setBaseUrl('http://localhost:8080');
  client.setAuth({ token: 'token', clientId: 7, sucursalId: 9, employeeId: 3 });
  let request = null;
  client._fetch = async (url, options) => {
    request = { url, options };
    return { saleReturnId: 81 };
  };

  const result = await client.retryReturnFiscalDocument(81);

  assert.equal(
    request.url,
    'http://localhost:8080/api/client-panel/7/sucursales/9/returns/81/fiscal-document/retry'
  );
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(result, { saleReturnId: 81 });
});

test('un 403 de permisos no revoca la sesión si session-status sigue activo', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ active: true }),
  });

  const client = new ApiClient();
  client.setAuth({ token: 'token-activo', clientId: 1, sucursalId: 2, employeeId: 3 });
  let emitted = false;
  client.on('session-revoked', () => { emitted = true; });

  assert.equal(await client.handleAuthFailure(403), false);
  assert.equal(emitted, false);
});

test('un 403 revoca la sesión cuando session-status confirma que fue cerrada', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({
    status: 401,
    text: async () => JSON.stringify({
      active: false,
      reason: 'SESSION_CLOSED',
      message: 'Tu sesión fue cerrada porque iniciaste sesión en otro dispositivo.',
    }),
  });

  const client = new ApiClient();
  client.setBaseUrl('http://localhost:8080');
  client.setAuth({ token: 'token-revocado', clientId: 1, sucursalId: 2, employeeId: 3 });
  const eventPromise = new Promise((resolve) => client.once('session-revoked', resolve));

  assert.equal(await client.handleAuthFailure(403, { path: '/api/protected' }), true);
  const event = await eventPromise;
  assert.equal(event.reason, 'SESSION_CLOSED');
  assert.match(event.message, /otro dispositivo/);
});
