'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SyncService } = require('../src/main/sync-service');

test('al cerrar espera el ciclo en vuelo y luego ejecuta una sincronización final', async () => {
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

  assert.deepEqual(events, ['stop', 'in-flight-finished', 'final-sync', 'stop']);
});
