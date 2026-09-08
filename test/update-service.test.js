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

test('cerrar sesión advierte incluso después de posponer y respeta cada decisión', async () => {
  const { service, updater } = createService();
  service.start();
  try {
    let confirmations = 0, installations = 0;
    assert.equal(await service.confirmLogout(() => { confirmations++; }, () => { installations++; }), true);
    assert.equal(confirmations, 0);
    updater.emit('update-downloaded', { version: '1.0.2' });
    service.defer();
    assert.equal(await service.confirmLogout(async () => 2, () => { installations++; }), false);
    assert.equal(installations, 0);
    assert.equal(await service.confirmLogout(async () => 1, () => { installations++; }), true);
    assert.equal(installations, 0);
    assert.equal(await service.confirmLogout(async () => 0, () => { installations++; }), false);
    assert.equal(installations, 1);
  } finally { service.stop(); }
});

test('rechazar el aviso no instala y conserva la decisión al reiniciar', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-update-defer-'));
  const app = { isPackaged: true, getVersion: () => '1.0.1', getPath: () => directory };
  const updater = new FakeUpdater();
  const service = new UpdateService({ autoUpdater: updater, app });
  service.start();
  try {
    updater.emit('update-downloaded', { version: '1.0.2' });
    let installations = 0;
    assert.deepEqual(await service.confirmInstallation(async () => false, () => { installations++; }),
      { success: false, cancelled: true });
    assert.equal(installations, 0);
    assert.equal(service.getStatus().state, 'ready');
    const nextUpdater = new FakeUpdater();
    const restarted = new UpdateService({ autoUpdater: nextUpdater, app });
    restarted.start();
    try {
      nextUpdater.emit('update-downloaded', { version: '1.0.2' });
      assert.equal(restarted.getStatus().dismissedVersion, '1.0.2');
      assert.deepEqual(nextUpdater.installCalls, []);
      await restarted.requestNotification();
      assert.equal(restarted.getStatus().dismissedVersion, null);
      restarted.defer();
      nextUpdater.emit('update-downloaded', { version: '1.0.3' });
      assert.notEqual(restarted.getStatus().dismissedVersion, restarted.getStatus().availableVersion);
    } finally { restarted.stop(); }
  } finally {
    service.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('doble clic confirma una sola vez y guarda el silencio antes de invocar Windows', async () => {
  const { service, updater } = createService();
  service.start();
  try {
    updater.emit('update-downloaded', { version: '1.0.2' });
    let accept;
    let confirmations = 0;
    let installations = 0;
    const confirm = () => { confirmations++; return new Promise(resolve => { accept = resolve; }); };
    const install = () => {
      installations++;
      assert.equal(service.getStatus().dismissedVersion, '1.0.2');
      updater.emit('error', Object.assign(new Error('User denied elevation'), { code: 'ERR_ELECTRON_BUILDER_EXECUTE' }));
      return { success: false };
    };
    const first = service.confirmInstallation(confirm, install);
    const second = service.confirmInstallation(confirm, install);
    await Promise.resolve();
    accept(true);
    await Promise.all([first, second]);
    assert.equal(confirmations, 1);
    assert.equal(installations, 1);
    assert.equal(service.getStatus().dismissedVersion, '1.0.2');
    assert.equal(updater.autoInstallOnAppQuit, false);
  } finally { service.stop(); }
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
