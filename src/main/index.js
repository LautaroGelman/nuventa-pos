// ============================================================
// Nuventa POS — Electron Main Process
// Loads the REAL web frontend (/login) in BrowserWindow.
// Intercepts /api/* via protocol.handle() → backend directly,
// bypassing the Next.js proxy (which doesn't work in Electron).
// Watches sessionStorage for auth tokens → saves locally for
// offline auth + sync.
// ============================================================
const { app, BrowserWindow, ipcMain, dialog, session, Menu, net, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const { pathToFileURL } = require('url');
const configStore = require('./config-store');
const { initDatabase, getDb, closeDatabase } = require('./database');
const { apiClient } = require('./api-client');
const { authService } = require('./auth-service');
const { SyncService } = require('./sync-service');
const { startLocalServer, stopLocalServer, getServerPort, loginEvents } = require('./local-server');
const { encryptToken, decryptToken } = require('./token-crypto');

let mainWindow = null;
let syncService = null;
let isOffline = false;
let onlineCheckTimer = null;
let tokenWatcherTimer = null;
let lastKnownToken = null;
let loggedOut = false; // set on logout to block token re-injection on next page load

// ── Enlarge cache ────────────────────────────────────────
app.commandLine.appendSwitch('disk-cache-size', '524288000'); // 500 MB

// ── Helpers ──────────────────────────────────────────────

function getWebAppHost() {
  try { return new URL(configStore.get('webAppUrl')).host; }
  catch { return 'www.nuventa.com.ar'; }
}

function getEffectiveBackendUrl() {
  const backendUrl = configStore.get('backendApiUrl');
  if (backendUrl) return backendUrl.replace(/\/+$/, '');
  return configStore.get('webAppUrl').replace(/\/+$/, '');
}

function parseJwt(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
  } catch { return null; }
}

// ── D03/D04/D05: confianza de orígenes (navegación, window.open, IPC) ──
// Orígenes confiables: el servidor local (loopback), el dominio Nuventa, el webAppUrl configurado y la
// página de fallback local (file:). Cualquier otro destino se considera externo/no confiable.
function isTrustedFrameUrl(frameUrl) {
  try {
    const u = new URL(frameUrl);
    if (u.protocol === 'file:') {
      // R4-#45: NO confiar en CUALQUIER file:// (un HTML local malicioso heredaría preload + token y
      // pasaría todos los IPC). Solo archivos DENTRO del directorio empaquetado `renderer/`.
      try {
        const rendererDir = path.normalize(path.join(__dirname, '..', 'renderer')) + path.sep;
        let p = decodeURIComponent(u.pathname);
        if (process.platform === 'win32') p = p.replace(/^\//, '');
        const filePath = path.normalize(p);
        return filePath.toLowerCase().startsWith(rendererDir.toLowerCase());
      } catch { return false; }
    }
    const host = u.hostname;
    if (host === '127.0.0.1' || host === 'localhost') return true;
    if (host === 'nuventa.com.ar' || host.endsWith('.nuventa.com.ar')) return true;
    try {
      const cfg = new URL(configStore.get('webAppUrl'));
      if (u.origin === cfg.origin) return true;
    } catch { /* webAppUrl mal formado */ }
    return false;
  } catch { return false; }
}

// D05: valida que un mensaje IPC venga de un frame confiable (no de una página externa cargada por
// error en la ventana privilegiada). Evita que un sitio atacante invoque login/logout/sync/credenciales.
function isTrustedSender(event) {
  const frame = event && event.senderFrame;
  return frame ? isTrustedFrameUrl(frame.url) : false;
}

function getCachedToken() {
  try {
    const db = getDb();
    const result = db.get("SELECT value FROM app_config WHERE key = 'auth_token'");
    if (!result?.value) return null;

    const token = decryptToken(result.value);
    if (!token) return null;

    // Even if the JWT is expired, we still inject it so the frontend
    // can operate locally (the local server validates via SQLite, not
    // the JWT signature).  The sync service will detect the expired
    // token and attempt a refresh when connectivity returns.
    // Only a truly missing or corrupt token should return null.
    const jwt = parseJwt(token);
    if (jwt?.exp && jwt.exp * 1000 < Date.now()) {
      console.log('[TOKEN] Cached token expired — injecting anyway for offline use');
    }

    return token;
  } catch { return null; }
}

/** Wipes the cached auth token from SQLite and resets in-memory state.
 *  Called on every logout path so the preload never re-injects a stale token. */
function clearLocalToken() {
  try {
    const db = getDb();
    db.run("DELETE FROM app_config WHERE key = 'auth_token'");
    db.run("DELETE FROM app_config WHERE key = 'roles'"); // R4-#37: no dejar roles stale para el próximo login (se conserva client_id como ancla de tenant, #35)
    // Also clear last_token in users table so offline-login won't pick it up
    db.run("UPDATE users SET last_token = NULL");
    db.save();
  } catch { /* db may not be ready on very first run */ }
  lastKnownToken = null;
  authService.logout();
  if (syncService) syncService.stop();
}

// ── Online check ─────────────────────────────────────────

async function checkOnlineStatus() {
  try {
    const backendUrl = getEffectiveBackendUrl();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${backendUrl}/api/auth/session-status`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    isOffline = !res.ok && res.status >= 500;
    if (res.ok) isOffline = false;
  } catch {
    isOffline = true;
  }
  return !isOffline;
}

function startOnlineCheck() {
  if (onlineCheckTimer) return;
  onlineCheckTimer = setInterval(checkOnlineStatus, 30000);
}

function stopOnlineCheck() {
  if (onlineCheckTimer) { clearInterval(onlineCheckTimer); onlineCheckTimer = null; }
}

// ── API Interception ─────────────────────────────────────
// Uses Electron's protocol.handle() to transparently proxy
// /api/* requests to the backend. The browser sees responses
// as same-origin → NO CORS issues, NO preflight problems.
// This replaces the Next.js rewrites proxy that doesn't
// exist inside Electron.

function setupApiInterception() {
  const webUrl = configStore.get('webAppUrl');
  const backendUrl = getEffectiveBackendUrl();
  const webHost = getWebAppHost();
  const backendHost = new URL(backendUrl).host; // e.g. 'localhost:8080'
  const webOrigin = new URL(webUrl).origin;
  const backendOrigin = new URL(backendUrl).origin;
  const needsRedirect = webOrigin !== backendOrigin;
  const webProtocol = new URL(webUrl).protocol.replace(':', ''); // 'http' or 'https'

  console.log(`[INTERCEPT] Web: ${webOrigin}, Backend: ${backendOrigin}`);
  console.log(`[INTERCEPT] Protocol: ${webProtocol}, Redirect needed: ${needsRedirect}`);

  session.defaultSession.protocol.handle(webProtocol, async (request) => {
    const url = new URL(request.url);

    // LOCAL-FIRST: ALL /api/* requests from the renderer are served by the
    // local HTTP server — regardless of which host the frontend addresses.
    // This catches:
    //   1. Relative /api/* (host = 127.0.0.1:{port}, same as static server)
    //   2. Requests to webHost (e.g. localhost:3000 in dev)
    //   3. Requests to backendHost (e.g. localhost:8080 — baked into static
    //      builds by NEXT_PUBLIC_API_URL in .env.local)
    // The sync service (main process fetch) is NOT affected by protocol.handle.
    const isRendererApiCall = url.pathname.startsWith('/api/') &&
      (url.host === webHost || url.host === backendHost || url.hostname === '127.0.0.1');

    if (isRendererApiCall) {
      const localPort = getServerPort();
      if (localPort) {
        const targetUrl = `http://127.0.0.1:${localPort}${url.pathname}${url.search}`;
        const fetchOpts = {
          method: request.method,
          headers: Object.fromEntries(request.headers.entries()),
          bypassCustomProtocolHandlers: true,
        };
        if (request.body) {
          fetchOpts.body = request.body;
          fetchOpts.duplex = 'half';
        }
        return net.fetch(targetUrl, fetchOpts);
      }
    }

    // Everything else: pass through — MUST use bypassCustomProtocolHandlers to
    // avoid re-triggering this handler and causing infinite recursion (blank page).
    const passthroughOpts = {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      bypassCustomProtocolHandlers: true,
    };
    if (request.body) {
      passthroughOpts.body = request.body;
      passthroughOpts.duplex = 'half';
    }
    return net.fetch(request.url, passthroughOpts);
  });
}

// ── Token Watcher ────────────────────────────────────────
// Polls sessionStorage for the auth token every 2s.
// When a NEW token appears → save user data locally + start sync.
// When token disappears  → stop sync (user logged out).

function startTokenWatcher() {
  if (tokenWatcherTimer) return;
  console.log('[TOKEN] Watcher started');

  tokenWatcherTimer = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const token = await mainWindow.webContents.executeJavaScript(
        "sessionStorage.getItem('token')", true
      );

      if (token && token !== 'null' && token.length > 20) {
        if (token !== lastKnownToken) {
          console.log('[TOKEN] New token detected');
          lastKnownToken = token;
          await handleTokenCaptured(token);
        }
      } else if (lastKnownToken) {
        console.log('[TOKEN] Token cleared — user logged out');
        lastKnownToken = null;
        handleTokenCleared();
      }
    } catch { /* page not ready or navigating */ }
  }, 2000);
}

function stopTokenWatcher() {
  if (tokenWatcherTimer) {
    clearInterval(tokenWatcherTimer);
    tokenWatcherTimer = null;
  }
}

async function handleTokenCaptured(token) {
  const jwt = parseJwt(token);
  if (!jwt) {
    console.warn('[TOKEN] Failed to parse JWT');
    return;
  }

  // A06: el POS no puede verificar la firma HS256 (no tiene la clave), así que NO confía en los
  // claims de un token cualquiera para definir el tenant de las escrituras locales. Anclamos el
  // clientId al del primer login establecido; un token con clientId DISTINTO (forjado en
  // sessionStorage) se RECHAZA y no se persiste — evita contaminar la DB local con otro tenant.
  try {
    const dbAnchor = getDb();
    const anchorRow = dbAnchor.get("SELECT value FROM app_config WHERE key = 'client_id'");
    const anchorClient = anchorRow && anchorRow.value ? String(anchorRow.value) : null;
    if (anchorClient && String(jwt.clientId || '') !== anchorClient) {
      console.warn(`[TOKEN] RECHAZADO: clientId del token (${jwt.clientId}) difiere del ancla (${anchorClient}). Token posiblemente manipulado.`);
      return;
    }
  } catch { /* db not ready — first run */ }

  console.log(`[TOKEN] User: ${jwt.sub}, Client: ${jwt.clientId}, Sucursal: ${jwt.sucursalId}`);

  // Configure API client for sync service
  apiClient.setAuth({
    token,
    clientId: jwt.clientId,
    sucursalId: jwt.sucursalId,
    employeeId: jwt.employeeId,
  });

  // Save to local DB
  try {
    const db = getDb();
    const now = new Date().toISOString();

    // app_config (used by local-server and sync-service)
    const set = (k, v) => db.run(
      'INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)', [k, v]
    );
    set('auth_token', encryptToken(token));
    set('client_id', String(jwt.clientId || ''));
    set('sucursal_id', String(jwt.sucursalId || ''));
    set('employee_id', String(jwt.employeeId || ''));
    // R4-#37: persistir TAMBIÉN los roles del JWT actual. Antes el login web NO escribía 'roles', así
    // que el local-server leía un valor stale de un usuario anterior (un CAJERO podía heredar
    // isAdminOrOwner de un PROPIETARIO logueado antes en el equipo → ruteo/proxy admin indebido).
    set('roles', JSON.stringify(jwt.roles || jwt.authorities || []));
    set('last_online_at', now);

    // Minimal user record (no password — web-login flow)
    db.run(`
      INSERT INTO users (email, pw_hash, pw_salt, client_id, sucursal_id,
        employee_id, employee_name, client_name, last_token, last_login_at, last_online_at)
      VALUES (?1, '', '', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(email) DO UPDATE SET
        client_id = ?2, sucursal_id = ?3, employee_id = ?4,
        employee_name = ?5, client_name = ?6,
        last_token = ?7, last_login_at = ?8, last_online_at = ?9
    `, [
      jwt.sub || '', jwt.clientId || null, jwt.sucursalId || null,
      jwt.employeeId || null, jwt.employeeName || '', jwt.clientName || '',
      encryptToken(token), now, now,
    ]);

    db.save();
    console.log('[TOKEN] User info saved locally');
  } catch (err) {
    console.error('[TOKEN] Error saving user info:', err.message);
  }

  // Start sync service — only when online (skip if this is an offline-login token)
  if (syncService && !syncService._timer && !isOffline) {
    syncService.start();
  }

  // Download branch data on first login for this branch
  try {
    if (jwt.sucursalId) {
      const db = getDb();
      const branchStatus = db.get(
        'SELECT * FROM branch_data_status WHERE sucursal_id = ?',
        [jwt.sucursalId]
      );
      if (!branchStatus || !branchStatus.full_sync_completed) {
        console.log('[TOKEN] First login for this branch — downloading data...');
        await authService._downloadBranchData(
          jwt.sucursalId, jwt.clientId,
          (status) => console.log(`[SYNC] ${status.message}`)
        );
        db.run(`
          INSERT INTO branch_data_status (sucursal_id, client_id, full_sync_completed)
          VALUES (?, ?, 1)
          ON CONFLICT(sucursal_id) DO UPDATE SET client_id = ?, full_sync_completed = 1
        `, [jwt.sucursalId, jwt.clientId, jwt.clientId]);
        db.save();
        console.log('[TOKEN] Branch data downloaded');
      }
    }
  } catch (err) {
    console.error('[TOKEN] Branch data download error:', err.message);
  }
}

function handleTokenCleared() {
  authService.logout();
  if (syncService) syncService.stop();
}

// ── IPC Handlers ─────────────────────────────────────────

function registerIpcHandlers() {
  // Environment info — D05: solo a frames confiables (no exponer URLs internas a páginas externas).
  ipcMain.handle('config:get-env', (event) => {
    if (!isTrustedSender(event)) return {};
    return {
      env: configStore.getEnvName(),
      isDev: configStore.isDev(),
      webAppUrl: configStore.get('webAppUrl'),
      backendApiUrl: configStore.get('backendApiUrl'),
    };
  });

  // Synchronous: provide cached token to preload (runs before page scripts)
  ipcMain.on('auth:get-cached-token-sync', (event) => {
    if (!isTrustedSender(event)) { event.returnValue = ''; return; } // D05
    // If the user just logged out, never re-inject the token even if the DB
    // clear is still in-flight (race condition between IPC messages and nav).
    if (loggedOut) {
      loggedOut = false; // reset for next legitimate login
      event.returnValue = '';
      return;
    }
    event.returnValue = getCachedToken() || '';
  });

  // Synchronous version — called via sendSync so removeItem() blocks until
  // loggedOut=true is set.  This eliminates the race with auth:get-cached-token-sync
  // that fired on the next page load before the async IPC was processed.
  ipcMain.on('auth:token-removed-sync', (event) => {
    if (!isTrustedSender(event)) { event.returnValue = false; return; } // D05
    console.log('[AUTH] Token removed by web page (sync) — clearing local DB token');
    loggedOut = true;
    clearLocalToken();
    event.returnValue = true; // required for sendSync to unblock renderer
  });

  // Async fallback (legacy — kept in case sendSync fails)
  ipcMain.on('auth:token-removed', (event) => {
    if (!isTrustedSender(event)) return; // D05
    console.log('[AUTH] Token removed by web page — clearing local DB token');
    loggedOut = true;
    clearLocalToken();
  });

  // Offline login handler (fallback page only)
  ipcMain.handle('auth:offline-login', async (event, email, password) => {
    if (!isTrustedSender(event)) return { success: false, error: 'Origen no autorizado.' }; // D05
    apiClient.setBaseUrl(getEffectiveBackendUrl());
    const result = await authService.login(email, password, {
      onStatus: (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auth:login-status', status);
        }
      },
    });

    if (result.success && !result.isOffline) {
      // Online login succeeded from fallback → transition to web app
      const webUrl = configStore.get('webAppUrl').replace(/\/+$/, '');
      lastKnownToken = result.token; // prevent re-capture
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          // P2-09: serializar con JSON.stringify produce un literal JS correctamente escapado,
          // en vez de armar el string a mano (que no cubre saltos de línea, </script>, etc.).
          mainWindow.webContents.executeJavaScript(
            `sessionStorage.setItem('token', ${JSON.stringify(result.token)})`, true
          ).catch(() => {});
          mainWindow.loadURL(webUrl + '/');
          if (syncService && !syncService._timer) syncService.start();
        }
      }, 500);
    }
    return result;
  });

  // Manual logout (called via nuventaAuth.logout() from the web page or fallback)
  // Only clears the token + sets the loggedOut flag.  Does NOT navigate — the
  // renderer handles navigation after the IPC response lands, avoiding the race
  // where loadURL tears down the page before the promise resolves.
  ipcMain.handle('auth:logout', async (event) => {
    if (!isTrustedSender(event)) return false; // D05
    loggedOut = true;
    clearLocalToken(); // wipes DB token + stops sync
    return true;
  });

  // ── Sync IPC ─────────────────────────────────────────

  ipcMain.handle('sync:force', async (event) => {
    if (!isTrustedSender(event)) return { success: false, error: 'Origen no autorizado.' }; // D05
    if (!syncService) return { success: false, error: 'Sync service not initialized' };
    try {
      await syncService.forceSync();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('sync:status', () => {
    if (!syncService) return { syncing: false, pendingTotal: 0, lastSyncAt: null };
    try {
      return syncService.getStatus();
    } catch {
      return { syncing: false, pendingTotal: 0, lastSyncAt: null };
    }
  });

  // ── Printer IPC ──────────────────────────────────────────
  // Permite al cajero ver/elegir la impresora conectada e imprimir el comprobante fiscal
  // (PDF generado por el backend en el formato configurado) en silencio a esa impresora.

  ipcMain.handle('printer:list', async (event) => {
    if (!isTrustedSender(event)) return []; // D05
    try {
      const printers = await event.sender.getPrintersAsync();
      return printers.map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
        description: p.description || '',
        status: p.status,
        isDefault: p.isDefault,
      }));
    } catch (err) {
      console.error('[PRINTER] list error:', err.message);
      return [];
    }
  });

  ipcMain.handle('printer:get-selected', (event) => {
    if (!isTrustedSender(event)) return null; // D05
    return configStore.get('selectedPrinter') || null;
  });

  ipcMain.handle('printer:set-selected', (event, name) => {
    if (!isTrustedSender(event)) return false; // D05
    configStore.set('selectedPrinter', name || null);
    return true;
  });

  // Imprime un PDF (bytes) en silencio. Carga el PDF en una ventana oculta (visor de Chromium) y
  // lo manda a la impresora indicada en opts.deviceName, o a la seleccionada, o a la por defecto.
  ipcMain.handle('printer:print-pdf', async (event, bytes, opts = {}) => {
    if (!isTrustedSender(event)) return { success: false, error: 'Origen no autorizado.' }; // D05

    // R4-#64: validar forma/tamaño de `bytes` y el deviceName ANTES de escribir el temp / imprimir.
    // `bytes` viene del FE remoto vía contextBridge; el gate de origen no valida el CONTENIDO del payload.
    let buffer;
    if (bytes instanceof Uint8Array || Buffer.isBuffer(bytes)) buffer = Buffer.from(bytes);
    else if (bytes instanceof ArrayBuffer) buffer = Buffer.from(new Uint8Array(bytes));
    else return { success: false, error: 'Formato de PDF inválido.' };
    if (buffer.length === 0 || buffer.length > 20 * 1024 * 1024) {
      return { success: false, error: 'PDF vacío o demasiado grande (máx 20MB).' };
    }
    if (opts && opts.deviceName != null && (typeof opts.deviceName !== 'string' || opts.deviceName.length > 200)) {
      return { success: false, error: 'Impresora inválida.' };
    }

    const deviceName = opts.deviceName || configStore.get('selectedPrinter') || '';
    let tmpPath = null;
    let printWin = null;
    try {
      tmpPath = path.join(app.getPath('temp'), `nuventa-print-${Date.now()}.pdf`);
      fs.writeFileSync(tmpPath, buffer);

      printWin = new BrowserWindow({
        show: false,
        webPreferences: { plugins: true, contextIsolation: true, nodeIntegration: false },
      });
      await printWin.loadURL(pathToFileURL(tmpPath).href);

      const result = await new Promise((resolve) => {
        // pequeño delay para que el visor de PDF termine de renderizar antes de imprimir
        setTimeout(() => {
          if (!printWin || printWin.isDestroyed()) {
            resolve({ success: false, error: 'Ventana de impresión cerrada' });
            return;
          }
          printWin.webContents.print(
            {
              silent: true,
              printBackground: true,
              deviceName: deviceName || undefined,
              margins: { marginType: 'none' },
            },
            (success, failureReason) => resolve({ success, error: success ? null : failureReason })
          );
        }, 400);
      });

      return result;
    } catch (err) {
      console.error('[PRINTER] print-pdf error:', err.message);
      return { success: false, error: err.message };
    } finally {
      // dar tiempo al spooler a tomar el trabajo antes de destruir la ventana / borrar el temp
      if (printWin && !printWin.isDestroyed()) {
        setTimeout(() => { try { printWin.destroy(); } catch {} }, 3000);
      }
      if (tmpPath) {
        setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} }, 6000);
      }
    }
  });
}

// ── Main Window ──────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: configStore.get('windowWidth'),
    height: configStore.get('windowHeight'),
    minWidth: 1024,
    minHeight: 700,
    title: 'Nuventa POS',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // D07: DevTools solo en dev. En prod F12/menú quedan inertes (no se puede abrir el inspector
      // para copiar el JWT de sessionStorage o llamar la API local saltando la UI).
      devTools: configStore.isDev(),
    },
  });

  // Avoid MaxListenersExceededWarning from protocol.handle() + web content
  mainWindow.webContents.setMaxListeners(50);

  // D04: denegar window.open / target=_blank. Los enlaces externos se abren en el navegador del SO
  // (no en una ventana Electron que heredaría el preload + token inyectado).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !isTrustedFrameUrl(url)) {
      shell.openExternal(url).catch(() => {});
    } else if (isTrustedFrameUrl(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  // ── Detect navigation to /login → treat as logout ──────────────────────
  // With contextIsolation:true the preload's sessionStorage.removeItem
  // override does NOT reach the renderer, so the IPC interception never
  // fires.  Instead we detect when the renderer navigates to /login and
  // proactively clear the cached token so the preload won't re-inject it.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // D03: allowlist de navegación. La ventana privilegiada (con preload + token) solo puede navegar a
    // orígenes confiables (loopback / Nuventa / webAppUrl / file). Un link/redirect/MITM a un sitio
    // externo se bloquea y, si es http(s), se abre en el navegador del SO.
    if (!isTrustedFrameUrl(url)) {
      event.preventDefault();
      console.warn('[NAV] Navegación bloqueada a origen no confiable:', url);
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
      return;
    }
    try {
      const dest = new URL(url);
      if (dest.pathname === '/login' || dest.pathname === '/login/') {
        console.log('[AUTH] Navigation to /login detected — clearing local token');
        loggedOut = true;
        clearLocalToken();
      }
    } catch { /* malformed URL — ignore */ }
  });

  // D03: bloquear también redirecciones (will-redirect) hacia orígenes no confiables.
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedFrameUrl(url)) {
      event.preventDefault();
      console.warn('[NAV] Redirección bloqueada a origen no confiable:', url);
    }
  });

  mainWindow.on('resize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const [w, h] = mainWindow.getSize();
      configStore.set('windowWidth', w);
      configStore.set('windowHeight', h);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopTokenWatcher();
  });

  return mainWindow;
}

// ── Load the App ─────────────────────────────────────────

async function loadApp() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }

  // ── STATIC-FIRST loading ─────────────────────────────────────────────────
  // Priority 1: local static build (resources/web from Next.js export)
  //             Served by the local HTTP server → 100% offline capable.
  // Priority 2: cloud URL fallback (dev mode or if assets not yet bundled)
  // Safety net: if both fail → offline fallback HTML page.
  const localPort  = getServerPort();
  const webIndex   = path.join(__dirname, '..', '..', 'resources', 'web', 'index.html');
  const hasStaticBuild = localPort && fs.existsSync(webIndex);

  let startUrl;
  if (hasStaticBuild) {
    startUrl = `http://127.0.0.1:${localPort}/`;
    console.log('[MAIN] Loading from local static build:', startUrl);
  } else {
    // No static build: load from cloud (requires internet; dev/CI scenario)
    startUrl = configStore.get('webAppUrl').replace(/\/+$/, '') + '/';
    console.log('[MAIN] No static build found — loading from cloud:', startUrl);
  }

  mainWindow.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
    if (errorCode === -3) return; // aborted — normal during redirects
    console.log(`[MAIN] Page load failed (${errorCode}): ${errorDescription} — offline fallback`);
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  });

  mainWindow.loadURL(startUrl);
  startTokenWatcher();

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

// ── Application Menu ─────────────────────────────────────

function buildMenu() {
  const template = [
    {
      label: 'Nuventa POS',
      submenu: [
        {
          label: 'Cerrar sesión',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => {
            // Clear DB token FIRST so the preload won't re-inject it
            // when the page navigates to /login.
            loggedOut = true;
            clearLocalToken();
            if (mainWindow && !mainWindow.isDestroyed()) {
              // Remove from sessionStorage too (in case page is still alive)
              mainWindow.webContents.executeJavaScript(
                "sessionStorage.removeItem('token'); window.location.href = '/login';",
                true
              ).catch(() => {});
            }
          },
        },
        {
          label: 'Ir a Punto de Venta',
          accelerator: 'CmdOrCtrl+Shift+V',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              const url = configStore.get('webAppUrl').replace(/\/+$/, '');
              mainWindow.loadURL(url + '/sale-form');
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Forzar sincronización',
          accelerator: 'CmdOrCtrl+Shift+Y',
          click: () => { if (syncService) syncService.forceSync(); },
        },
        {
          label: 'Estado offline',
          click: () => {
            const db = getDb();
            const pendingSales = db.get("SELECT COUNT(*) as cnt FROM sales WHERE sync_status = 'pending'");
            const productCount = db.get("SELECT COUNT(*) as cnt FROM products WHERE active = 1");
            const registerCount = db.get("SELECT COUNT(*) as cnt FROM cash_registers");
            const lastSync = db.get("SELECT value FROM app_config WHERE key = 'last_product_sync'");
            const userCount = db.get("SELECT COUNT(*) as cnt FROM users");
            dialog.showMessageBox({
              type: 'info',
              title: 'Estado Offline',
              message: `Conexión: ${isOffline ? '❌ Sin conexión' : '✅ Conectado'}\n` +
                `Usuarios locales: ${userCount?.cnt || 0}\n` +
                `Productos cacheados: ${productCount?.cnt || 0}\n` +
                `Cajas registradoras: ${registerCount?.cnt || 0}\n` +
                `Ventas pendientes de sync: ${pendingSales?.cnt || 0}\n` +
                `Último sync: ${lastSync?.value || 'Nunca'}`,
            });
          },
        },
        { type: 'separator' },
        {
          label: 'Recargar página',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
          },
        },
        // D07: el ítem DevTools solo existe en dev (en prod webPreferences.devTools=false ya lo inhabilita).
        ...(configStore.isDev() ? [{
          label: 'DevTools',
          accelerator: 'F12',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.toggleDevTools();
          },
        }, { type: 'separator' }] : []),
        { role: 'quit', label: 'Salir' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App lifecycle ────────────────────────────────────────

// R5-#14: lock de instancia única. Sin esto, abrir el .exe dos veces carga dos copias de la
// misma DB sql.js en memoria y cada db.save() reescribe el ARCHIVO ENTERO (last-writer-wins),
// perdiendo silenciosamente ventas/movimientos offline y descuadrando el arqueo. La 2da
// instancia enfoca la ventana existente y no arranca su propia DB/servidor local.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return; // 2da instancia: ya se llamó app.quit(); no inicializar nada

  // 1. Config
  configStore.loadConfig();

  // 2. Initialize SQLite database
  await initDatabase();

  // 3. Start local API server (handles ALL /api/* requests in local-first mode)
  const localPort = await startLocalServer();
  console.log(`[MAIN] Local API server on port ${localPort}`);

  // 3b. React to login/status events emitted by the local server's auth handler
  loginEvents.on('login-status', (status) => {
    // Forward download progress to renderer (shows steps during first-time branch sync)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth:login-status', status);
    }
  });

  loginEvents.on('login-success', (result) => {
    console.log(`[MAIN] Login: ${result.user?.email} (offline=${result.isOffline})`);
    // apiClient was already configured by authService inside the login flow.
    // Start background sync only when we are online.
    if (syncService && !syncService._timer && !result.isOffline) {
      syncService.start();
    }
  });

  // R7-#16: la nube respondió 401 (sesión revocada: empleado dado de baja, suscripción
  // suspendida, sesión reemplazada). proxyToCloud ya seteó el flag cloud_session_revoked y
  // emitió este evento, pero antes nadie lo consumía: la UI seguía cargada e interactiva.
  // Ahora forzamos el logout y redirigimos a /login, igual que el "Cerrar sesión" del menú.
  loginEvents.on('session-revoked', (info) => {
    console.warn(`[MAIN] Sesión revocada por la nube (${info?.reason}); forzando logout`);
    loggedOut = true;
    clearLocalToken(); // borra token DB + detiene sync
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(
        "sessionStorage.removeItem('token'); window.location.href = '/login';",
        true
      ).catch(() => {});
    }
  });

  // 4. Register IPC handlers + build menu
  registerIpcHandlers();
  buildMenu();

  // 5. API interception (protocol handler — replaces Next.js proxy)
  setupApiInterception();

  // 6. Check online status
  await checkOnlineStatus();
  startOnlineCheck();

  // 7. Configure API client with backend URL
  const backendUrl = getEffectiveBackendUrl();
  apiClient.setBaseUrl(backendUrl);
  console.log(`[MAIN] Environment: ${configStore.getEnvName().toUpperCase()}`);
  console.log(`[MAIN] Web URL:     ${configStore.get('webAppUrl')}`);
  console.log(`[MAIN] Backend URL: ${backendUrl}`);

  // 8. Restore cached auth for sync service
  try {
    const db = getDb();
    const token = db.get("SELECT value FROM app_config WHERE key = 'auth_token'");
    const clientId = db.get("SELECT value FROM app_config WHERE key = 'client_id'");
    const sucursalId = db.get("SELECT value FROM app_config WHERE key = 'sucursal_id'");
    const employeeId = db.get("SELECT value FROM app_config WHERE key = 'employee_id'");

    if (token?.value && clientId?.value) {
      apiClient.setAuth({
        token: decryptToken(token.value),
        clientId: Number(clientId.value),
        sucursalId: Number(sucursalId.value),
        employeeId: Number(employeeId.value),
      });
    }
  } catch { /* ignore */ }

  // 9. Start sync service (will run if auth is available)
  syncService = new SyncService();
  syncService.on('sync-status', (status) => {
    isOffline = !status.online;
    // Forward to renderer so SyncButton can update
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync-status', status);
    }
  });
  syncService.on('sync-complete', (results) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync-complete', results);
    }
  });
  syncService.on('products-updated', () => { console.log('[MAIN] Products updated from sync'); });
  if (apiClient.token) syncService.start();

  // 10. Load the app — web frontend (online) or fallback (offline)
  //     Cached token is injected by the preload script.
  await loadApp();
});

app.on('window-all-closed', async () => {
  stopOnlineCheck();
  stopTokenWatcher();
  // R4-#42: detener el scheduler y ESPERAR a que un _tick en vuelo termine (hasta 3s) antes de cerrar
  // la DB, para no perder el marcado 'synced' de una venta que ya se creó en la nube.
  if (syncService) { syncService.stop(); await syncService.drain(3000).catch(() => {}); }
  // Clear cached token on exit — user must log in again on next launch.
  try {
    const db = getDb();
    db.run("DELETE FROM app_config WHERE key = 'auth_token'");
    db.run("DELETE FROM app_config WHERE key = 'roles'"); // R4-#37: roles no deben sobrevivir a otro login
    db.run("UPDATE users SET last_token = NULL"); // A10: que el login offline no reuse el token tras cerrar la app
    db.save();
  } catch { /* best-effort */ }
  stopLocalServer();
  closeDatabase();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) loadApp();
});

process.on('uncaughtException', (err) => {
  // D11: el detalle (rutas/SQL/stack) va SOLO al log, no al usuario. Se persiste y cierra la DB para
  // no dejar estado a medias (ej. expected_amount actualizado pero venta no insertada) y se termina de
  // forma controlada en vez de seguir corriendo en estado posiblemente inconsistente.
  console.error('[MAIN] Uncaught exception:', err);
  try { closeDatabase(); } catch { /* best-effort */ }
  try {
    dialog.showErrorBox('Error inesperado',
      'Ocurrió un error inesperado. La aplicación se cerrará para proteger los datos; volvé a abrirla.');
  } catch { /* dialog puede no estar disponible */ }
  app.exit(1);
});
