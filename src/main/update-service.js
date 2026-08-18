// ============================================================
// Nuventa POS — Desktop auto-update orchestration
// Checks the signed generic feed, downloads in background and
// enables installation only after the main process saved the DB.
// ============================================================
'use strict';

const EventEmitter = require('events');

const DEFAULT_FEED_URL = 'https://descargas.nuventa.com.ar/stable';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_CHECK_GAP_MS = 5 * 60 * 1000;

class UpdateService extends EventEmitter {
  constructor({ autoUpdater, app, feedUrl = DEFAULT_FEED_URL, now = () => Date.now() }) {
    super();
    this.autoUpdater = autoUpdater;
    this.app = app;
    this.feedUrl = feedUrl;
    this.now = now;
    this._timer = null;
    this._startupTimer = null;
    this._checkPromise = null;
    this._lastCheckAt = 0;
    this._downloadedVersion = null;
    this._status = {
      state: 'idle',
      currentVersion: app.getVersion(),
      availableVersion: null,
      percent: null,
      error: null,
    };
  }

  start({ disabled = false } = {}) {
    if (disabled || !this.app.isPackaged) {
      this._setStatus({ state: 'disabled' });
      return;
    }

    this.autoUpdater.autoDownload = true;
    this.autoUpdater.autoInstallOnAppQuit = false;
    this.autoUpdater.allowPrerelease = false;
    this.autoUpdater.setFeedURL({ provider: 'generic', url: this.feedUrl, channel: 'latest' });

    this.autoUpdater.on('checking-for-update', () => {
      this._setStatus({ state: 'checking', error: null });
    });
    this.autoUpdater.on('update-available', (info) => {
      this._setStatus({ state: 'downloading', availableVersion: info.version, percent: 0, error: null });
    });
    this.autoUpdater.on('update-not-available', () => {
      this._setStatus({ state: 'up-to-date', availableVersion: null, percent: null, error: null });
    });
    this.autoUpdater.on('download-progress', (progress) => {
      this._setStatus({ state: 'downloading', percent: Math.max(0, Math.min(100, progress.percent || 0)) });
    });
    this.autoUpdater.on('update-downloaded', (info) => {
      this._downloadedVersion = info.version;
      this._setStatus({ state: 'ready', availableVersion: info.version, percent: 100, error: null });
    });
    this.autoUpdater.on('error', (error) => {
      this._setStatus({ state: 'error', error: error?.message || 'No se pudo buscar la actualización.' });
    });

    this._startupTimer = setTimeout(() => this.checkForUpdates().catch(() => {}), 10_000);
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
    if (this._status.state === 'disabled' || this._downloadedVersion) return this.getStatus();
    if (this._checkPromise) {
      await this._checkPromise;
      return this.getStatus();
    }
    if (!force && this.now() - this._lastCheckAt < MIN_CHECK_GAP_MS) return this.getStatus();

    this._lastCheckAt = this.now();
    this._checkPromise = this.autoUpdater.checkForUpdates()
      .catch((error) => {
        this._setStatus({ state: 'error', error: error?.message || 'No se pudo buscar la actualización.' });
        return null;
      })
      .finally(() => { this._checkPromise = null; });
    await this._checkPromise;
    return this.getStatus();
  }

  async prepareForShutdown(createBackup) {
    if (!this._downloadedVersion) return false;
    try {
      await createBackup(this._downloadedVersion);
      this.autoUpdater.autoInstallOnAppQuit = true;
      this._setStatus({ state: 'installing' });
      return true;
    } catch (error) {
      this.autoUpdater.autoInstallOnAppQuit = false;
      this._setStatus({
        state: 'error',
        error: `La actualización se pospuso porque no se pudo respaldar la base: ${error.message}`,
      });
      return false;
    }
  }

  getStatus() {
    return { ...this._status };
  }

  _setStatus(patch) {
    this._status = { ...this._status, ...patch };
    this.emit('status', this.getStatus());
  }
}

function createUpdateService(options = {}) {
  const { autoUpdater } = require('electron-updater');
  const { app } = require('electron');
  return new UpdateService({ autoUpdater, app, ...options });
}

module.exports = {
  CHECK_INTERVAL_MS,
  DEFAULT_FEED_URL,
  MIN_CHECK_GAP_MS,
  UpdateService,
  createUpdateService,
};
