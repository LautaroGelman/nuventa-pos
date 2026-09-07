'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SyncService,
  delayedInvoiceFromSaleResult,
  supportsBundleV2,
  acknowledgeLegacyOutbox,
  quarantineLegacyOutbox,
  SYNC_INTERVAL_MS,
} = require('../src/main/sync-service');

test('un cierre dispara un ciclo urgente sin esperar la hora', async () => {
  const service = new SyncService();
  const cycles = [];
  service._tick = async (options) => cycles.push(options);
  await service.forceSync({ urgent: true });
  assert.deepEqual(cycles, [{ urgent: true }]);
});

test('un cierre durante otro ciclo conserva prioridad aunque llegue un pedido manual después', async () => {
  const { apiClient } = require('../src/main/api-client');
  const originalOnline = apiClient.isOnline;
  const service = new SyncService();
  let finish;
  apiClient.isOnline = () => new Promise((resolve) => { finish = resolve; });
  try {
    const current = service.refreshCatalog();
    await service.forceSync({ urgent: true });
    await service.forceSync();
    const cycles = [];
    service._tick = async (options) => cycles.push(options);
    finish(false);
    await current;
    assert.deepEqual(cycles, [{ urgent: true }]);
    assert.equal(service._urgentAgain, false);
  } finally { apiClient.isOnline = originalOnline; service.stop(); }
});

test('reintenta cajas pendientes cada 15 segundos y stop cancela el reintento', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const service = new SyncService();
  let pending = false;
  const cycles = [];
  service._hasPendingCashSession = (status = 'CLOSED') => pending && status === 'CLOSED';
  service._tick = async (options) => cycles.push(options);
  service.start();
  pending = true;
  t.mock.timers.tick(15_000);
  assert.deepEqual(cycles, [{ uploadMutations: false }, { urgent: true }]);
  service.stop();
  t.mock.timers.tick(15_000);
  assert.equal(cycles.length, 2);
});

test('las operaciones esperan una hora; inicio sólo descarga catálogo y el botón puede enviar antes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const service = new SyncService();
  const uploads = [];
  service._tick = async ({ uploadMutations = true } = {}) => { uploads.push(uploadMutations); };
  try {
    service.start();
    assert.equal(SYNC_INTERVAL_MS, 3600000);
    assert.deepEqual(uploads, [false]);
    for (let i = 0; i < 5; i++) service.notifyLocalMutation();
    t.mock.timers.tick(3599999);
    assert.deepEqual(uploads, [false]);
    t.mock.timers.tick(1);
    assert.deepEqual(uploads, [false, true]);
    await service.forceSync();
    assert.deepEqual(uploads, [false, true, true]);
    service.stop();
    t.mock.timers.tick(3600000);
    assert.equal(uploads.length, 3);
  } finally {
    service.stop();
    t.mock.timers.reset();
  }
});

test('cambiar sucursal durante un ciclo sólo solicita descargar catálogo después', () => {
  const service = new SyncService();
  service._running = true;
  service.refreshCatalog();
  assert.equal(service._refreshAgain, true);
  assert.equal(service._runAgain, false);
  service.stop();
  assert.equal(service._refreshAgain, false);
});

test('al cerrar sólo espera el ciclo en vuelo y no inicia red nueva', async () => {
  const service = new SyncService();
  const events = [];
  service._running = true;
  service.stop = () => {
    events.push('stop');
    service._runAgain = false;
  };
  service._tick = async () => {
    events.push('final-sync');
  };

  setTimeout(() => {
    events.push('in-flight-finished');
    service._running = false;
  }, 10);

  await service.syncBeforeShutdown();

  assert.deepEqual(events, ['stop', 'in-flight-finished']);
});

test('una factura autorizada al sincronizar se expone para notificación manual', () => {
  assert.deepEqual(delayedInvoiceFromSaleResult({
    id: 91,
    invoice: { emitida: true, cae: '123', invoiceId: 44, numeroFormateado: '0001-00000044' },
  }, { emitInvoice: true }), {
    invoiceId: 44,
    numero: '0001-00000044',
    saleId: 91,
  });
  assert.equal(delayedInvoiceFromSaleResult({
    id: 92,
    invoice: { emitida: false, invoiceId: 45 },
  }, { emitInvoice: true }), null);
});

test('negocia bundle v2 solo cuando el contrato y la capacidad estan publicados', () => {
  assert.equal(supportsBundleV2({ currentContractVersion: 1 }), false);
  assert.equal(supportsBundleV2({ currentContractVersion: 2, features: { bundleSyncV2: true } }), true);
  assert.equal(supportsBundleV2({ currentContractVersion: 2, features: ['bundleSyncV2'] }), true);
  assert.equal(supportsBundleV2({ currentContractVersion: 2, features: {} }), false);
});

test('el ACK v1 consume solo el evento equivalente del outbox v2', () => {
  const calls = [];
  const db = { run: (sql, params) => calls.push({ sql, params }) };

  acknowledgeLegacyOutbox(db, 'SALE', 'sales', 41);
  acknowledgeLegacyOutbox(db, ['CASH_SESSION_OPEN', 'CASH_SESSION_CLOSE'], 'cash_sessions', 9);

  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /DELETE FROM sync_outbox/);
  assert.deepEqual(calls[0].params, ['sales', 41, 'SALE']);
  assert.deepEqual(calls[1].params, ['cash_sessions', 9, 'CASH_SESSION_OPEN', 'CASH_SESSION_CLOSE']);
});

test('un rechazo permanente v1 pone su outbox en cuarentena', () => {
  const calls = [];
  quarantineLegacyOutbox({ run: (sql, params) => calls.push({ sql, params }) }, 'returns', 7, 'HTTP 422');

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /state = 'QUARANTINED'/);
  assert.deepEqual(calls[0].params, ['HTTP 422', 'returns', 7]);
});
