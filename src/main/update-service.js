'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const DEFAULT_FEED_URL = 'https://descargas.nuventa.com.ar/direct';
const STORE_PRODUCT_ID = '9MWQ82CX7C5B';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 30_000;
const MIN_CHECK_GAP_MS = 5 * 60 * 1000;
const PUBLIC_STATES = new Set([
  'idle', 'checking', 'downloading', 'ready', 'installing',
  'recoverable-error', 'blocked', 'disabled', 'managed-by-store',
]);

function safeError(error) {
  return String(error?.message || error || 'No se pudo actualizar.')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 1000);
}

function normalizeFeedUrl(value) {
  try {
    const url = new URL(value || DEFAULT_FEED_URL);
    const allowedPath = url.pathname.replace(/\/+$/, '');
    if (url.protocol !== 'https:' || url.hostname !== 'descargas.nuventa.com.ar'
        || !['/direct', '/pilot'].includes(allowedPath)
        || url.username || url.password || url.search || url.hash) return DEFAULT_FEED_URL;
    return `${url.origin}${allowedPath}`;
  } catch { return DEFAULT_FEED_URL; }
}

class UpdateService extends EventEmitter {
  constructor({ autoUpdater, app, feedUrl = DEFAULT_FEED_URL, requestHeaders = {}, now = () => Date.now() }) {
    super();
    this.autoUpdater = autoUpdater;
    this.app = app;
    this.feedUrl = normalizeFeedUrl(feedUrl);
    this.requestHeaders = { ...requestHeaders };
    this.now = now;
    this._timer = null;
    this._startupTimer = null;
    this._checkPromise = null;
    this._lastCheckAt = 0;
    this._downloadedVersion = null;
    this._installationPrepared = false;
    this._started = false;
    this._history = [];
    this._diagnosticPath = typeof app.getPath === 'function'
      ? path.join(app.getPath('userData'), 'update-diagnostics.json') : null;
    this._status = {
      state: 'idle', currentVersion: app.getVersion(), availableVersion: null,
      percent: null, error: null, errorCode: null, attempts: 0, lastCheckAt: null,
      channel: this.feedUrl.endsWith('/pilot') ? 'pilot' : 'direct', feedUrl: this.feedUrl,
    };
    this._restoreDiagnostics();
  }

  start({ disabled = false, managedByStore = false } = {}) {
    if (managedByStore) {
      this._setStatus({ state: 'managed-by-store', channel: 'store', feedUrl: null, error: null });
      return;
    }
    if (disabled || !this.app.isPackaged) {
      this._setStatus({ state: 'disabled' });
      return;
    }
    if (this._started) return;
    this._started = true;
    this.autoUpdater.autoDownload = true;
    this.autoUpdater.autoInstallOnAppQuit = false;
    this.autoUpdater.allowPrerelease = false;
    this.autoUpdater.requestHeaders = this.requestHeaders;
    this.autoUpdater.setFeedURL({ provider: 'generic', url: this.feedUrl, channel: 'latest' });
    this.autoUpdater.on('checking-for-update', () =>
      this._setStatus({ state: 'checking', error: null, errorCode: null }));
    this.autoUpdater.on('update-available', (info) =>
      this._setStatus({ state: 'downloading', availableVersion: info.version, percent: 0, error: null }));
    this.autoUpdater.on('update-not-available', () =>
      this._setStatus({ state: 'idle', availableVersion: null, percent: null, error: null }));
    this.autoUpdater.on('download-progress', (progress) =>
      this._setStatus({ state: 'downloading', percent: Math.max(0, Math.min(100, progress.percent || 0)) }));
    this.autoUpdater.on('update-downloaded', (info) => {
      this._downloadedVersion = info.version;
      this._installationPrepared = false;
      this._setStatus({ state: 'ready', availableVersion: info.version, percent: 100, error: null });
    });
    this.autoUpdater.on('error', (error) => this._setStatus({
      state: 'recoverable-error', error: safeError(error), errorCode: error?.code || 'UPDATER_ERROR',
    }));
    this._startupTimer = setTimeout(() => this.checkForUpdates().catch(() => {}), STARTUP_CHECK_DELAY_MS);
    this._startupTimer.unref?.();
    this._timer = setInterval(() => this.checkForUpdates().catch(() => {}), CHECK_INTERVAL_MS);
    this._timer.unref?.();
  }

  stop() {
    if (this._startupTimer) clearTimeout(this._startupTimer);
    if (this._timer) clearInterval(this._timer);
    this._startupTimer = null;
    this._timer = null;
  }

  async checkForUpdates({ force = false } = {}) {
    if (['disabled', 'managed-by-store', 'installing'].includes(this._status.state)
        || this._downloadedVersion) return this.getStatus();
    if (this._checkPromise) {
      await this._checkPromise;
      return this.getStatus();
    }
    if (!force && this.now() - this._lastCheckAt < MIN_CHECK_GAP_MS) return this.getStatus();
    this._lastCheckAt = this.now();
    this._setStatus({
      state: 'checking', lastCheckAt: new Date(this._lastCheckAt).toISOString(),
      attempts: Number(this._status.attempts || 0) + 1, error: null, errorCode: null,
    });
    this._checkPromise = this.autoUpdater.checkForUpdates()
      .catch((error) => {
        this._setStatus({
          state: 'recoverable-error', error: safeError(error), errorCode: error?.code || 'CHECK_FAILED',
        });
        return null;
      })
      .finally(() => { this._checkPromise = null; });
    await this._checkPromise;
    return this.getStatus();
  }

  async retry() {
    if (this._downloadedVersion) {
      this._setStatus({ state: 'ready', error: null, errorCode: null });
      return this.getStatus();
    }
    return this.checkForUpdates({ force: true });
  }

  async prepareInstallation(prepare) {
    if (!this._downloadedVersion || this._status.state !== 'ready') return false;
    this._installationPrepared = false;
    try {
      await prepare(this._downloadedVersion);
      this._installationPrepared = true;
      this._setStatus({ state: 'installing', error: null, errorCode: null });
      return true;
    } catch (error) {
      this._setStatus({
        state: 'recoverable-error', error: `La actualización se pospuso: ${safeError(error)}`,
        errorCode: error?.code || 'PREPARE_FAILED',
      });
      return false;
    }
  }

  // Kept for an older renderer/main build. It intentionally performs no network operation.
  async checkForUpdatesBeforeShutdown() { return this.getStatus(); }

  async prepareForShutdown(createBackup) { return this.prepareInstallation(createBackup); }

  installDownloadedUpdate() {
    if (!this._downloadedVersion || !this._installationPrepared) return false;
    this._installationPrepared = false;
    try {
      this.autoUpdater.quitAndInstall(true, false);
      return true;
    } catch (error) {
      this._setStatus({
        state: 'recoverable-error', error: safeError(error), errorCode: error?.code || 'INSTALL_LAUNCH_FAILED',
      });
      return false;
    }
  }

  getStatus() { return { ...this._status }; }

  diagnostics() {
    return { ...this.getStatus(), history: this._history.slice(),
      storeProductId: STORE_PRODUCT_ID, generatedAt: new Date().toISOString() };
  }

  _setStatus(patch) {
    const state = PUBLIC_STATES.has(patch.state) ? patch.state : this._status.state;
    this._status = { ...this._status, ...patch, state };
    this._history.push({ at: new Date().toISOString(), state: this._status.state,
      availableVersion: this._status.availableVersion, percent: this._status.percent,
      errorCode: this._status.errorCode });
    if (this._history.length > 100) this._history.splice(0, this._history.length - 100);
    this._persistDiagnostics();
    this.emit('status', this.getStatus());
  }

  _persistDiagnostics() {
    if (!this._diagnosticPath) return;
    try {
      fs.mkdirSync(path.dirname(this._diagnosticPath), { recursive: true });
      const tmp = `${this._diagnosticPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.diagnostics(), null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this._diagnosticPath);
    } catch { /* diagnostics must never block the POS */ }
  }

  _restoreDiagnostics() {
    if (!this._diagnosticPath) return;
    try {
      const previous = JSON.parse(fs.readFileSync(this._diagnosticPath, 'utf8'));
      this._status.lastCheckAt = previous.lastCheckAt || null;
      this._status.attempts = Number(previous.attempts || 0);
      this._status.error = previous.error || null;
      this._status.errorCode = previous.errorCode || null;
      this._history = Array.isArray(previous.history) ? previous.history.slice(-100) : [];
    } catch { /* first run or invalid diagnostics */ }
  }
}

function createUpdateService(options = {}) {
  const { autoUpdater } = require('electron-updater');
  const { app } = require('electron');
  return new UpdateService({ autoUpdater, app, ...options });
}

module.exports = {
  CHECK_INTERVAL_MS, DEFAULT_FEED_URL, MIN_CHECK_GAP_MS, STARTUP_CHECK_DELAY_MS,
  STORE_PRODUCT_ID, UpdateService, createUpdateService, normalizeFeedUrl, safeError,
};
