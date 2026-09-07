'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  UpdateService, MIN_CHECK_GAP_MS, cleanupStalePendingUpdate, normalizeFeedUrl,
} = require('../src/main/update-service');

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.checks = 0;
    this.autoInstallOnAppQuit = false;
    this.installCalls = [];
  }

  setFeedURL(config) { this.feed = config; }
  async checkForUpdates() { this.checks += 1; }
  quitAndInstall(isSilent, isForceRunAfter) { this.installCalls.push([isSilent, isForceRunAfter]); }
}

function createService({ packaged = true } = {}) {
  const updater = new FakeUpdater();
  let currentTime = MIN_CHECK_GAP_MS;
  const service = new UpdateService({
    autoUpdater: updater,
    app: { isPackaged: packaged, getVersion: () => '1.0.1' },
    now: () => currentTime,
  });
  return { service, updater, advance: (ms) => { currentTime += ms; } };
}

test('no consulta el feed en desarrollo', async () => {
  const { service, updater } = createService({ packaged: false });
  service.start();
  await service.checkForUpdates({ force: true });
  assert.equal(service.getStatus().state, 'disabled');
  assert.equal(updater.checks, 0);
});

test('acepta los feeds direct, pilot y stable del dominio de descargas', () => {
  assert.equal(normalizeFeedUrl('https://descargas.nuventa.com.ar/stable/'), 'https://descargas.nuventa.com.ar/stable');
  assert.equal(normalizeFeedUrl('https://descargas.nuventa.com.ar/pilot/'),
    'https://descargas.nuventa.com.ar/pilot');
  assert.equal(normalizeFeedUrl('https://evil.example/direct'),
    'https://descargas.nuventa.com.ar/direct');
  assert.equal(normalizeFeedUrl('https://descargas.nuventa.com.ar/pilot?token=secret'),
    'https://descargas.nuventa.com.ar/direct');
});

test('serializa y limita las consultas al feed', async () => {
  const { service, updater, advance } = createService();
  service.start();
  await service.checkForUpdates();
  await service.checkForUpdates();
  assert.equal(updater.checks, 1);
  advance(MIN_CHECK_GAP_MS);
  await service.checkForUpdates();
  assert.equal(updater.checks, 2);
  service.stop();
});

test('el cierre nunca consulta el feed ni espera una descarga', async () => {
  const { service, updater } = createService();
  service.start();
  const status = await service.checkForUpdatesBeforeShutdown();

  assert.equal(updater.checks, 0);
  assert.equal(status.state, 'idle');
  service.stop();
});

test('Store administra las actualizaciones sin configurar ni consultar R2', async () => {
  const { service, updater } = createService();
  service.start({ managedByStore: true });
  await service.checkForUpdates({ force: true });
  assert.equal(service.getStatus().state, 'managed-by-store');
  assert.equal(updater.feed, undefined);
  assert.equal(updater.checks, 0);
  service.stop();
});

test('solo habilita la instalación al salir después del respaldo', async () => {
  const { service, updater } = createService();
  service.start();
  updater.emit('update-downloaded', { version: '1.0.2' });

  let backedUpVersion = null;
  const prepared = await service.prepareForShutdown(async (version) => {
    backedUpVersion = version;
  });

  assert.equal(prepared, true);
  assert.equal(backedUpVersion, '1.0.2');
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.deepEqual(updater.installCalls, []);
  assert.equal(service.getStatus().state, 'installing');
  assert.equal(service.installDownloadedUpdate(), true);
  assert.deepEqual(updater.installCalls, [[true, true]]);
  assert.equal(service.installDownloadedUpdate(), false);
  service.stop();
});

test('pospone la instalación si el respaldo falla', async () => {
  const { service, updater } = createService();
  service.start();
  updater.emit('update-downloaded', { version: '1.0.2' });
  const prepared = await service.prepareForShutdown(async () => {
    throw new Error('disco lleno');
  });

  assert.equal(prepared, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(service.installDownloadedUpdate(), false);
  assert.deepEqual(updater.installCalls, []);
  assert.match(service.getStatus().error, /disco lleno/);
  service.stop();
});

test('elimina sólo un paquete pendiente igual o anterior a la versión instalada', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuventa-updater-cache-'));
  const pending = path.join(root, 'nuventa-pos-updater', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'Nuventa-POS-Setup-1.0.9.exe'), 'old');
  fs.writeFileSync(path.join(pending, 'current.blockmap'), 'old-map');
  fs.writeFileSync(path.join(pending, 'update-info.json'), JSON.stringify({
    fileName: 'Nuventa-POS-Setup-1.0.9.exe', sha512: 'test',
  }));

  assert.equal(cleanupStalePendingUpdate(root, '1.1.0'), true);
  assert.equal(fs.existsSync(path.join(pending, 'update-info.json')), false);
  assert.equal(fs.existsSync(path.join(pending, 'Nuventa-POS-Setup-1.0.9.exe')), false);

  fs.writeFileSync(path.join(pending, 'Nuventa-POS-Setup-1.2.0.exe'), 'future');
  fs.writeFileSync(path.join(pending, 'update-info.json'), JSON.stringify({
    fileName: 'Nuventa-POS-Setup-1.2.0.exe', sha512: 'test',
  }));
  assert.equal(cleanupStalePendingUpdate(root, '1.1.0'), false);
  assert.equal(fs.existsSync(path.join(pending, 'Nuventa-POS-Setup-1.2.0.exe')), true);
  fs.rmSync(root, { recursive: true, force: true });
});
