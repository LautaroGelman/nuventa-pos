// ============================================================
// Nuventa POS — Preload Script
// 1. Injects cached auth token into sessionStorage BEFORE the
//    web page's scripts run (so AuthContext finds it on mount).
// 2. Exposes IPC channels for env info + offline login fallback.
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

// ── Inject cached token (synchronous — runs before page JS) ──
// Only inject if the session was not explicitly invalidated by a logout.
try {
  const cachedToken = ipcRenderer.sendSync('auth:get-cached-token-sync');
  if (cachedToken && cachedToken.length > 20) {
    sessionStorage.setItem('token', cachedToken);
  }
} catch { /* ignore — first launch or DB not ready */ }

// ── Intercept sessionStorage.removeItem so that removing 'token'
//    (i.e. web-app logout) also wipes the local DB copy.  Without
//    this the preload would re-inject the cached token on the next
//    page load and the user would never actually be logged out.
try {
  const _origRemove = sessionStorage.removeItem.bind(sessionStorage);
  Object.defineProperty(sessionStorage, 'removeItem', {
    writable: true,
    configurable: true,
    value: function posRemoveItem(key) {
      if (key === 'token') {
        // sendSync — blocks until main sets loggedOut=true BEFORE page navigates.
        // This prevents the race condition where auth:get-cached-token-sync
        // runs on the next page load before the async IPC was processed.
        try { ipcRenderer.sendSync('auth:token-removed-sync'); } catch { ipcRenderer.send('auth:token-removed'); }
      }
      return _origRemove(key);
    },
  });
} catch { /* non-fatal */ }

// ── Expose APIs to renderer ──────────────────────────────

contextBridge.exposeInMainWorld('nuventaConfig', {
  getEnv: () => ipcRenderer.invoke('config:get-env'),
});

contextBridge.exposeInMainWorld('nuventaAuth', {
  // Offline login (used only by the fallback page when web is unreachable)
  offlineLogin: (email, password) => ipcRenderer.invoke('auth:offline-login', email, password),
  logout: () => ipcRenderer.invoke('auth:logout'),
  // Owners select their active branch in AuthContext; main needs the same value for background sync.
  setActiveBranch: (sucursalId) => ipcRenderer.invoke('auth:set-active-branch', sucursalId),
  onLoginStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('auth:login-status', handler);
    return () => ipcRenderer.removeListener('auth:login-status', handler);
  },
});

contextBridge.exposeInMainWorld('nuventaSync', {
  forceSync: () => ipcRenderer.invoke('sync:force'),
  getStatus: () => ipcRenderer.invoke('sync:status'),
  onSyncStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('sync-status', handler);
    return () => ipcRenderer.removeListener('sync-status', handler);
  },
  onSyncComplete: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('sync-complete', handler);
    return () => ipcRenderer.removeListener('sync-complete', handler);
  },
});

contextBridge.exposeInMainWorld('nuventaUpdater', {
  getStatus: () => ipcRenderer.invoke('updater:status'),
  check: () => ipcRenderer.invoke('updater:check'),
  onStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('updater:status', handler);
    return () => ipcRenderer.removeListener('updater:status', handler);
  },
});

// ── Impresora térmica / fiscal ──────────────────────────────
// Permite que la app web (corriendo dentro del POS) liste las impresoras conectadas, recuerde
// la elegida por equipo e imprima el PDF del comprobante en silencio. En un navegador normal
// `window.nuventaPrinter` no existe → el frontend cae al fallback de descarga/impresión manual.
contextBridge.exposeInMainWorld('nuventaPrinter', {
  list: () => ipcRenderer.invoke('printer:list'),
  getSelected: () => ipcRenderer.invoke('printer:get-selected'),
  setSelected: (name) => ipcRenderer.invoke('printer:set-selected', name),
  // bytes: Uint8Array | ArrayBuffer con el PDF; opts: { deviceName? }
  printPdf: (bytes, opts) => ipcRenderer.invoke('printer:print-pdf', bytes, opts),
});
