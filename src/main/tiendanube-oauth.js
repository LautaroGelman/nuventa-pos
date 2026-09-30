// ============================================================
// Tiendanube OAuth uses a disposable, unprivileged browser session.
// Only code/state return to the authenticated renderer; no JWT leaves it.
// ============================================================
const crypto = require('node:crypto');

function validateAuthorization(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password
      || !['www.tiendanube.com', 'www.nuvemshop.com.br'].includes(url.hostname)
      || !/^\/apps\/\d+\/authorize\/?$/.test(url.pathname)
      || !url.searchParams.get('state')) throw new Error('URL de autorización de Tiendanube inválida.');
  return url;
}

function callbackResult(value, origins, expectedState) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!origins.includes(url.origin) || !/^\/tn-callback\/?$/.test(url.pathname)) return null;
  if (url.searchParams.get('state') !== expectedState) throw new Error('La autorización no corresponde a esta vinculación.');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('Tiendanube no autorizó la vinculación.');
  return { code, state: expectedState };
}

function authorizeTiendanube({ BrowserWindow, parent, authorizeUrl, webAppUrl, timeoutMs = 10 * 60 * 1000 }) {
  const auth = validateAuthorization(authorizeUrl);
  const origins = [...new Set([new URL(webAppUrl).origin, 'https://nuventa.com.ar', 'https://www.nuventa.com.ar'])];
  return new Promise((resolve, reject) => {
    const popup = new BrowserWindow({ parent, modal: true, width: 960, height: 780, show: false,
      title: 'Conectar Tiendanube', autoHideMenuBar: true,
      webPreferences: { partition: `tn-oauth-${crypto.randomUUID()}`, sandbox: true,
        contextIsolation: true, nodeIntegration: false, devTools: false },
    });
    const oauthSession = popup.webContents.session;
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void oauthSession.clearStorageData().catch(() => {});
      if (!popup.isDestroyed()) popup.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('La vinculación venció. Volvé a intentarlo.')), timeoutMs);
    popup.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const navigate = (event, target) => {
      try {
        const result = callbackResult(target, origins, auth.searchParams.get('state'));
        if (result) { event.preventDefault(); finish(null, result); return; }
        // No operating-system protocols, downloads or local files in this window.
        if (new URL(target).protocol !== 'https:') event.preventDefault();
      } catch (error) { event.preventDefault(); finish(error); }
    };
    popup.webContents.on('will-navigate', navigate);
    popup.webContents.on('will-redirect', navigate);
    popup.webContents.session.on('will-download', (event) => event.preventDefault());
    popup.once('ready-to-show', () => { if (!done) popup.show(); });
    popup.once('closed', () => finish(new Error('Vinculación cancelada.')));
    popup.loadURL(auth.href).catch((error) => finish(error));
  });
}

module.exports = { authorizeTiendanube, validateAuthorization, callbackResult };
