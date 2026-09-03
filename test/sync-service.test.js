'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SyncService,
  delayedInvoiceFromSaleResult,
  supportsBundleV2,
  acknowledgeLegacyOutbox,
  quarantineLegacyOutbox,
} = require('../src/main/sync-service');

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
