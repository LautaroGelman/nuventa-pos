// ============================================================
// Nuventa POS — Local API Server (offline REST handler)
// Mimics the backend REST API responses using local SQLite.
// When the app is offline, webRequest redirects /api/* calls here.
// ============================================================
const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { getDb } = require('./database');
const { authService } = require('./auth-service');
const { apiClient } = require('./api-client');
const { decryptToken } = require('./token-crypto');
const imageCache = require('./image-cache');

// ── Login event emitter ──────────────────────────────────
// index.js listens on this to: start sync + forward status to renderer
const loginEvents = new EventEmitter();

// Centraliza los rechazos de autenticación detectados tanto por el proxy como por el sync.
// El main process consume este evento para limpiar credenciales, avisar y volver al login.
apiClient.on('session-revoked', (info) => {
  try {
    const db = getDb();
    db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES ('cloud_session_revoked', '1')");
    db.save();
  } catch (_) { /* DB todavía no inicializada o cerrándose */ }
  loginEvents.emit('session-revoked', info);
});

// ── C05: timestamps de NEGOCIO (zona Argentina, UTC-3 fijo, sin DST) ──────
// El backend deserializa saleDate/createdAt/returnDate como LocalDateTime (sin zona). Si el POS
// mandaba `new Date().toISOString()` (UTC con 'Z'), una venta de las 21:30 ART = 00:30Z del día
// SIGUIENTE → caía en el día de negocio equivocado (sesión/arqueo/cierre/fiscal mal). Estampamos
// el reloj de pared de Argentina como ISO naive (sin 'Z'), que es lo que el backend espera.
// R4-#56: derivar la hora de NEGOCIO de la misma zona IANA que el backend (America/Argentina/Mendoza)
// en vez de un offset fijo -3. Hoy Argentina no aplica DST y coinciden, pero si se reinstaurara, el
// offset mágico haría que el POS y el backend asignaran fechas de negocio distintas en el borde del día.
const BUSINESS_TZ = 'America/Argentina/Mendoza';
function toLocalIsoInZone(date) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const hour = p.hour === '24' ? '00' : p.hour; // algunos engines devuelven '24' a medianoche
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}`;
}
function businessNowIso() {
  return toLocalIsoInZone(new Date());
}

// B10: redondeo monetario a 2 decimales (HALF_UP aproximado) para acotar la deriva de los floats JS
// frente al BigDecimal HALF_UP scale 2 del backend en acumulaciones de dinero.
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
function toBusinessIso(value) {
  if (!value) return businessNowIso();
  // Si trae 'Z' u offset explícito → convertir a hora de Argentina; si ya es naive, dejarlo igual.
  if (/[zZ]$/.test(String(value)) || /[+-]\d{2}:?\d{2}$/.test(String(value))) {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return toLocalIsoInZone(new Date(t));
  }
  return value;
}

// ── B03: esperado EN EFECTIVO de una sesión (no incluye ventas con tarjeta/transferencia/MP) ──
// Misma fórmula que el close-preview: initial + ventas EFECTIVO + inyecciones − retiros/gastos −
// devoluciones en efectivo. El cierre la usa en vez de la columna expected_amount (que sumaba el
// total COMPLETO de cada venta, inflando el esperado y generando faltantes ficticios).
function computeExpectedInCash(db, session) {
  let cashSales = 0;
  const sessionSales = db.all(
    'SELECT sp.payment_method, sp.amount FROM sales s JOIN sale_payments sp ON sp.sale_local_id = s.local_id WHERE s.cash_session_id = ?',
    [session.id]
  );
  for (const sp of sessionSales) {
    if (sp.payment_method === 'EFECTIVO') cashSales += sp.amount;
  }
  let injectionsTotal = 0;
  let withdrawalsTotal = 0;
  const movements = db.all(
    "SELECT type, amount FROM cash_movements WHERE cash_session_id = ? AND scope = 'SESSION'",
    [session.id]
  );
  for (const m of movements) {
    if (m.type === 'INJECTION') injectionsTotal += m.amount;
    else if (m.type === 'WITHDRAWAL' || m.type === 'EXPENSE') withdrawalsTotal += m.amount;
  }
  const cashRefundsRow = db.get(
    "SELECT COALESCE(SUM(total_refund_amount), 0) as total FROM returns WHERE cash_session_id = ? AND refund_method = 'CASH'",
    [session.id]
  );
  const refundsTotal = cashRefundsRow ? cashRefundsRow.total : 0;
  return round2((session.initial_amount || 0) + cashSales + injectionsTotal - withdrawalsTotal - refundsTotal); // B10
}

// ── A02: bloqueo de escrituras tras revocación de sesión en la nube ──
// Si un proxy a la nube devolvió 401 (sesión/cuenta revocada), no se permiten NUEVAS ventas/
// devoluciones/movimientos/aperturas offline hasta re-login. Devuelve true si bloqueó (ya respondió).
function blockIfSessionRevoked(db, res) {
  const row = db.get("SELECT value FROM app_config WHERE key = 'cloud_session_revoked'");
  if (row && row.value === '1') {
    jsonResponse(res, 403, {
      error: 'Tu sesión fue revocada en la nube. Volvé a iniciar sesión para seguir operando.',
      sessionRevoked: true,
    });
    return true;
  }
  return false;
}

// ── Static File Server ────────────────────────────────────
// Serves the Next.js static export from resources/web.
// With trailingSlash:true, Next maps /page/ → out/page/index.html.
const WEB_DIR = path.normalize(path.join(__dirname, '..', '..', 'resources', 'web'));

const MIME_TYPES = {
  '.html' : 'text/html; charset=utf-8',
  '.js'   : 'application/javascript; charset=utf-8',
  '.mjs'  : 'application/javascript; charset=utf-8',
  '.css'  : 'text/css; charset=utf-8',
  '.json' : 'application/json; charset=utf-8',
  '.png'  : 'image/png',
  '.jpg'  : 'image/jpeg',
  '.jpeg' : 'image/jpeg',
  '.gif'  : 'image/gif',
  '.svg'  : 'image/svg+xml',
  '.ico'  : 'image/x-icon',
  '.woff' : 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf'  : 'font/ttf',
  '.webp' : 'image/webp',
  '.txt'  : 'text/plain; charset=utf-8',
  '.map'  : 'application/json',
};

// ── Security Headers ─────────────────────────────────────
// Applied to every response to mitigate common web vulnerabilities.
const SECURITY_HEADERS = {
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // D02: se quita 'unsafe-eval' (habilitaba gadgets eval/Function; el export estático de Next no lo
  // necesita en prod) y se acota connect-src al backend Nuventa + loopback (antes `https:` permitía
  // exfiltrar a cualquier host). Se mantiene 'unsafe-inline' en script/style porque el export estático
  // de Next inyecta scripts/estilos inline y no admite nonces sin un build server (follow-up: nonces/hashes).
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http://127.0.0.1:* http://localhost:*; font-src 'self' data: https:; connect-src 'self' https://api.nuventa.com.ar https://*.nuventa.com.ar http://127.0.0.1:* http://localhost:*; frame-ancestors 'self'; base-uri 'self'; form-action 'self';",
};

function serveStaticFile(urlPath, res) {
  // Map URL path → file in WEB_DIR (Next.js trailingSlash:true convention)
  let candidate = urlPath;
  if (candidate === '/' || candidate === '') {
    candidate = '/index.html';
  } else if (candidate.endsWith('/')) {
    candidate += 'index.html';
  } else if (!path.extname(candidate)) {
    // No extension → treat as a page route → <route>/index.html
    candidate += '/index.html';
  }

  const fullPath = path.normalize(path.join(WEB_DIR, candidate));

  // Security: prevent path traversal outside WEB_DIR
  if (!fullPath.startsWith(WEB_DIR + path.sep) && fullPath !== WEB_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(fullPath) && !fs.statSync(fullPath).isDirectory()) {
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, ...SECURITY_HEADERS });
    fs.createReadStream(fullPath).pipe(res);
    return;
  }

  // SPA fallback: unknown route → root index.html (client-side router handles it)
  const rootIndex = path.join(WEB_DIR, 'index.html');
  if (fs.existsSync(rootIndex)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
    fs.createReadStream(rootIndex).pipe(res);
    return;
  }

  res.writeHead(503, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
  res.end('Static build not found. Run: npm run build:web in nuventa-pos.');
}

let server = null;
let serverPort = 0;

// ── Helpers ──────────────────────────────────────────────

// R4-#12/#46: el server escucha en loopback, pero CUALQUIER página web abierta en un navegador del
// equipo puede emitir fetch() a http://127.0.0.1:<puerto>. Validamos el header Origin para que un sitio
// web externo NO pueda operar el POS. El renderer de Electron llega vía protocol.handle (sin Origin de
// navegador) o desde el origen confiable de la app, y pasa.
function isAllowedApiOrigin(origin) {
  if (!origin) return true; // sin Origin = no es un fetch cross-origin de navegador (renderer / herramienta local)
  try {
    const u = new URL(origin);
    if (u.protocol === 'file:') return true;
    const host = u.hostname;
    if (host === '127.0.0.1' || host === 'localhost') return true;
    if (host === 'nuventa.com.ar' || host.endsWith('.nuventa.com.ar')) return true;
    return false;
  } catch {
    return false;
  }
}

// R6-#44: gate de Origin más estricto para endpoints de MUTACIÓN (ventas/devoluciones/caja/gastos).
// file:// se excluye explícitamente: una página HTML abierta desde el disco puede hacer fetch() al
// server local igual que una página web externa (misma amenaza, distinto vector). Origin ausente
// se sigue permitiendo porque el renderer de Electron llega vía protocol.handle sin header Origin.
function isAllowedMutationOrigin(origin) {
  if (!origin) return true; // renderer de Electron (protocol.handle) — no hay Origin de navegador
  try {
    const u = new URL(origin);
    if (u.protocol === 'file:') return false; // página HTML del disco — rechazar en mutaciones
    const host = u.hostname;
    if (host === '127.0.0.1' || host === 'localhost') return true;
    if (host === 'nuventa.com.ar' || host.endsWith('.nuventa.com.ar')) return true;
    return false;
  } catch {
    return false;
  }
}

// R6-#44: verifica que haya una sesión local activa (token guardado post-login) antes de permitir
// cualquier mutación. Devuelve true si ya respondió con 401 (el caller debe hacer return).
// El token se borra al salir (index.js window-all-closed) por lo que la presencia del valor en
// app_config es evidencia suficiente de que hubo un login en esta sesión de la app.
function blockIfNoSessionToken(db, res) {
  const raw = getConfigVal(db, 'auth_token');
  if (!raw) {
    jsonResponse(res, 401, { error: 'No hay sesión activa. Iniciá sesión para continuar.' });
    return true;
  }
  return false;
}

function jsonResponse(res, statusCode, data) {
  // R4-#46: se elimina 'Access-Control-Allow-Origin: *'. El renderer llega vía protocol.handle
  // (same-origin, no necesita CORS); un sitio web externo ya no puede LEER estas respuestas ni
  // disparar POST JSON cross-origin (el preflight queda sin ACAO). El Origin se valida en el router.
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(data));
}

// R8-#95: límite de 1 MB para el body. Un proceso local que pasó el filtro de Origin podría enviar
// un body de MB/GB agotando el heap y crasheando Electron. Acumulamos el tamaño por chunk; si se
// supera el límite destruimos la conexión y resolvemos null para que el caller devuelva 413.
const PARSE_BODY_MAX_BYTES = 1_048_576; // 1 MB
const IMAGE_UPLOAD_BODY_MAX_BYTES = (2 * 1024 * 1024) + (64 * 1024);
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > PARSE_BODY_MAX_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (body === '' && size === 0) { resolve({}); return; }
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve(null));
  });
}

/** Parse route like /api/client-panel/:clientId/sucursales/:sucursalId/... */
function parseRoute(pathname) {
  // Remove query string
  const path = pathname.split('?')[0];

  // Check for branch-scoped routes
  const branchMatch = path.match(
    /\/api\/client-panel\/(\d+)\/sucursales\/(\d+)\/(.+)/
  );
  if (branchMatch) {
    return {
      clientId: Number(branchMatch[1]),
      sucursalId: Number(branchMatch[2]),
      subpath: '/' + branchMatch[3],
    };
  }

  // Auth and other top-level routes
  return { clientId: null, sucursalId: null, subpath: path };
}

function parseQuery(url) {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return {};
  const params = {};
  new URLSearchParams(url.slice(qIdx)).forEach((v, k) => { params[k] = v; });
  return params;
}

function getConfigVal(db, key) {
  const row = db.get('SELECT value FROM app_config WHERE key = ?', [key]);
  return row ? row.value : null;
}

function getCurrentCashScope(db) {
  const clientId = Number(getConfigVal(db, 'client_id'));
  const sucursalId = Number(getConfigVal(db, 'sucursal_id'));
  const employeeId = Number(getConfigVal(db, 'employee_id'));
  if (![clientId, sucursalId, employeeId].every((id) => Number.isSafeInteger(id) && id > 0)) {
    return null;
  }
  return { clientId, sucursalId, employeeId };
}

/** La sesión local actual siempre pertenece al usuario, cliente y sucursal autenticados. */
function getScopedOpenCashSession(db) {
  const scope = getCurrentCashScope(db);
  if (!scope) return null;
  return db.get(`
    SELECT * FROM cash_sessions
     WHERE status = 'OPEN'
       AND client_id = ?
       AND sucursal_id = ?
       AND employee_id = ?
     ORDER BY opening_time DESC
     LIMIT 1
  `, [scope.clientId, scope.sucursalId, scope.employeeId]);
}

function getOwnedCashSessionByAnyId(db, sessionId) {
  const scope = getCurrentCashScope(db);
  const id = Number(sessionId);
  if (!scope || !Number.isSafeInteger(id) || id <= 0) return null;
  return db.get(`
    SELECT * FROM cash_sessions
     WHERE (id = ? OR cloud_id = ?)
       AND client_id = ?
       AND sucursal_id = ?
       AND employee_id = ?
     LIMIT 1
  `, [id, id, scope.clientId, scope.sucursalId, scope.employeeId]);
}

/**
 * Busca un cierre local ya confirmado por el cajero para una sesión cloud.
 *
 * El cierre del POS es local-first: entre el POST de cierre y el siguiente ciclo de sync,
 * la nube todavía puede informar la misma sesión como OPEN. Esa lectura atrasada no debe
 * volver a crear una fila OPEN ni reactivar el turno que el cajero acaba de cerrar.
 */
function getScopedClosedCashSessionByCloudId(db, cloudSessionId) {
  const scope = getCurrentCashScope(db);
  const id = Number(cloudSessionId);
  if (!scope || !Number.isSafeInteger(id) || id <= 0) return null;
  return db.get(`
    SELECT * FROM cash_sessions
     WHERE cloud_id = ?
       AND client_id = ?
       AND sucursal_id = ?
       AND employee_id = ?
       AND status = 'CLOSED'
     ORDER BY closing_time ASC, id ASC
     LIMIT 1
  `, [id, scope.clientId, scope.sucursalId, scope.employeeId]);
}

function getScopedClosedCashSessionByAnyId(db, sessionId) {
  const scope = getCurrentCashScope(db);
  const id = Number(sessionId);
  if (!scope || !Number.isSafeInteger(id) || id <= 0) return null;
  return db.get(`
    SELECT * FROM cash_sessions
     WHERE (id = ? OR cloud_id = ?)
       AND client_id = ?
       AND sucursal_id = ?
       AND employee_id = ?
       AND status = 'CLOSED'
     ORDER BY closing_time ASC, id ASC
     LIMIT 1
  `, [id, id, scope.clientId, scope.sucursalId, scope.employeeId]);
}

function quarantineLocalCashSession(db, session, reason) {
  if (!session?.id) return;
  db.run(`
    UPDATE cash_sessions
       SET status = 'FORCED_CLOSE',
           closing_time = COALESCE(closing_time, ?),
           sync_status = 'needs_review',
           sync_error = ?
     WHERE id = ? AND status = 'OPEN'
  `, [businessNowIso(), String(reason || 'La sesión local no coincide con la nube.'), session.id]);
}

function linkOrMirrorCloudCashSession(db, localSession, cloudSession) {
  const scope = getCurrentCashScope(db);
  if (!scope || !cloudSession || cloudSession.status !== 'OPEN') return null;

  const sameRegister = localSession
    && String(localSession.cash_register_id) === String(cloudSession.cashRegisterId);
  const sameCloudSession = localSession?.cloud_id
    && String(localSession.cloud_id) === String(cloudSession.id);

  if (localSession && (sameCloudSession || (!localSession.cloud_id && sameRegister))) {
    db.run(`
      UPDATE cash_sessions
         SET cloud_id = ?, cash_register_id = ?, cash_register_name = ?,
             employee_id = ?, employee_name = ?, sync_error = NULL
       WHERE id = ?
    `, [
      cloudSession.id,
      cloudSession.cashRegisterId,
      cloudSession.cashRegisterName || localSession.cash_register_name || null,
      scope.employeeId,
      cloudSession.employeeName || getConfigVal(db, 'employee_name') || '',
      localSession.id,
    ]);
    return db.get('SELECT * FROM cash_sessions WHERE id = ?', [localSession.id]);
  }

  if (localSession) {
    quarantineLocalCashSession(db, localSession, 'La nube informó una sesión actual diferente.');
  }

  const openingTime = cloudSession.openingTime || businessNowIso();
  const result = db.run(`
    INSERT INTO cash_sessions (cloud_id, client_session_uuid, client_id, sucursal_id,
      employee_id, employee_name, status, business_date, opening_time,
      initial_amount, expected_amount, cash_register_id, cash_register_name, sync_status)
    VALUES (?, NULL, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, 'pending')
  `, [
    cloudSession.id,
    scope.clientId,
    scope.sucursalId,
    scope.employeeId,
    cloudSession.employeeName || getConfigVal(db, 'employee_name') || '',
    cloudSession.businessDate || String(openingTime).slice(0, 10),
    openingTime,
    Number(cloudSession.initialAmount) || 0,
    Number(cloudSession.expectedAmount) || Number(cloudSession.initialAmount) || 0,
    cloudSession.cashRegisterId || null,
    cloudSession.cashRegisterName || null,
  ]);
  return db.get('SELECT * FROM cash_sessions WHERE id = ?', [result.lastId]);
}

// ── Role helpers ─────────────────────────────────────────

// Roles hierarchy: PROPIETARIO > ADMINISTRADOR > MULTIFUNCION > INVENTARIO > CAJERO
const ONLINE_ONLY_ROLES = ['ROLE_PROPIETARIO', 'ROLE_OWNER', 'ROLE_ADMINISTRADOR', 'ROLE_ADMIN'];

// R4-#58: derivar el rol del JWT (firmado por el backend) en vez de confiar SOLO en app_config.roles,
// que es estado local mutable. Decodificamos el payload del token (sin verificar la firma — el POS no
// tiene la clave; la autoridad final de autorización es el backend al re-validar el token). Si falla,
// se cae a app_config.roles (que de todas formas se sincroniza desde el JWT en cada login, R4-#37).
function getRolesFromToken(db) {
  try {
    const raw = getConfigVal(db, 'auth_token');
    const token = raw ? decryptToken(raw) : null;
    if (token) {
      const parts = token.split('.');
      if (parts.length === 3) {
        const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        const payload = JSON.parse(json);
        const roles = payload.roles || payload.authorities;
        if (Array.isArray(roles)) return roles;
      }
    }
  } catch (_) { /* fallback abajo */ }
  return null;
}

function getUserRoles() {
  try {
    const db = getDb();
    const fromToken = getRolesFromToken(db);
    if (fromToken) return fromToken;
    const raw = getConfigVal(db, 'roles');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function isAdminOrOwner() {
  const roles = getUserRoles();
  return roles.some((r) => ONLINE_ONLY_ROLES.includes(r.toUpperCase()) || ONLINE_ONLY_ROLES.includes(r));
}

function canManageInventory() {
  const roles = getUserRoles();
  const allowed = [...ONLINE_ONLY_ROLES, 'ROLE_INVENTARIO', 'ROLE_MULTIFUNCION'];
  return roles.some((r) => allowed.includes(r.toUpperCase()) || allowed.includes(r));
}

// ── Cloud Proxy ──────────────────────────────────────────
// Forwards request transparently to the cloud API.
// Used for admin/owner routes that don't have local implementations
// (dashboard, reports, finance, employees, daily-close, etc.)

async function proxyToCloud(req, res, method, fullUrl, body, { rawBody = false, rawResponse = false } = {}) {
  const db = getDb();
  const rawToken = getConfigVal(db, 'auth_token');
  const token = rawToken ? decryptToken(rawToken) : null;

  if (!token) {
    return jsonResponse(res, 401, { error: 'No hay sesión activa.' });
  }

  // Build the cloud URL from the original request path
  const cloudUrl = `${apiClient.baseUrl}${fullUrl}`;

  const headers = {
    ...apiClient._headers(),
    'Content-Type': rawBody ? (req.headers['content-type'] || 'application/octet-stream') : 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  const fetchOpts = { method, headers };
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    fetchOpts.body = rawBody ? body : JSON.stringify(body);
  }

  let timeout = null;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 20000);
    fetchOpts.signal = controller.signal;

    const cloudRes = await fetch(cloudUrl, fetchOpts);
    clearTimeout(timeout);

    const responseBody = rawResponse
      ? Buffer.from(await cloudRes.arrayBuffer())
      : await cloudRes.text();
    const responseText = rawResponse ? '' : responseBody;

    // A02: un rechazo de autenticación de la NUBE significa que estamos ONLINE pero la sesión/cuenta
    // fue rechazada (token revocado, sesión reemplazada, empleado dado de baja, suscripción suspendida). NO es un
    // corte de red, así que enmascararlo como 503 "offline" dejaba seguir vendiendo hasta 7 días con
    // una sesión revocada. Ahora marcamos la sesión como revocada (bloquea nuevas escrituras locales,
    // ver assertCloudSessionValid) y avisamos al main para forzar el logout. Se sigue respondiendo 503
    // a ESTA request para no disparar el loop del interceptor axios; el bloqueo real lo hace el flag.
    // Spring Security puede responder 403 cuando el JWT es válido pero su sessionId ya fue
    // invalidado. Como otros 403 sí representan falta de permisos, primero confirmamos el estado
    // mediante /session-status antes de expulsar al usuario.
    const authWasRevoked = await apiClient.handleAuthFailure(cloudRes.status, {
      path: fullUrl,
      responseBody: responseText,
    });
    if (authWasRevoked) {
      console.warn(`[LOCAL-API] Cloud rejected auth (${cloudRes.status}) for ${method} ${fullUrl} — sesión revocada`);
      return jsonResponse(res, 503, {
        error: 'Tu sesión fue cerrada o revocada en la nube. Volvé a iniciar sesión.',
        sessionRevoked: true,
      });
    }

    const imagePathMatch = fullUrl.split('?')[0].match(/\/items\/(\d+)\/image$/);
    if (cloudRes.ok && imagePathMatch) {
      const productId = Number(imagePathMatch[1]);
      if (method === 'DELETE') {
        db.run('UPDATE products SET image_url = NULL, thumbnail_url = NULL WHERE id = ?', [productId]);
        db.save();
        imageCache.removeProduct(productId);
      } else {
        try {
          const image = responseText ? JSON.parse(responseText) : {};
          db.run('UPDATE products SET image_url = ?, thumbnail_url = ? WHERE id = ?', [
            image.imageUrl || null, image.thumbnailUrl || null, productId,
          ]);
          db.save();
          imageCache.invalidateAndEnqueueProduct({
            id: productId,
            imageUrl: image.imageUrl || null,
            thumbnailUrl: image.thumbnailUrl || null,
          });
        } catch (_) { /* el próximo sync reconciliará la fila */ }
      }
    }

    // Forward cloud response status + body as-is
    // R5-#46: NO emitir 'Access-Control-Allow-Origin: *' (regresión de R4-#46, que ya lo quitó de
    // jsonResponse). El renderer llega via protocol.handle (same-origin) y no necesita CORS; con
    // ACAO:* una página file:// (que isAllowedApiOrigin permite) podría leer via CORS la respuesta
    // proxeada de rutas cloud-only (reportes/finanzas/empleados) usando el Bearer guardado.
    const responseHeaders = {
      'Content-Type': cloudRes.headers.get('content-type') || 'application/json',
      ...SECURITY_HEADERS,
    };
    if (rawResponse) {
      for (const name of ['cache-control', 'etag', 'last-modified']) {
        const value = cloudRes.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      responseHeaders['Content-Length'] = String(responseBody.length);
    }
    res.writeHead(cloudRes.status, responseHeaders);
    res.end(responseBody);
  } catch (err) {
    console.error(`[LOCAL-API] Cloud proxy failed for ${method} ${fullUrl}:`, err.message);
    const isImageMutation = /\/items\/\d+\/image(?:\?|$)/.test(fullUrl)
      && (method === 'PUT' || method === 'DELETE');
    jsonResponse(res, 503, {
      error: isImageMutation
        ? 'Para cargar o eliminar imágenes necesitás conexión a internet.'
        : 'No se pudo conectar con el servidor. Verifica tu conexión a internet.',
      offline: true,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// Routes that always require cloud proxy (admin/owner online functions)
const CLOUD_ONLY_PATTERNS = [
  /^\/dashboard/,
  /^\/reports/,
  /^\/finance/,
  /^\/employees/,
  /^\/daily-close\/(?!sessions)/, // /daily-close/sessions served locally
  /^\/recurring-expenses/,
  /^\/providers/,
  /^\/categories/,
  /^\/purchase-orders/,
  /^\/mercadopago\//,
  /^\/promotions$/,        // GET/POST promotions list (not /apply)
  /^\/promotions\/\d+/,    // PUT/DELETE specific promotion
  /^\/sucursales$/,         // branch management
];

function isCloudOnlyRoute(subpath) {
  const clean = subpath.split('?')[0];
  return CLOUD_ONLY_PATTERNS.some((pattern) => pattern.test(clean));
}

// ── Route Handlers ───────────────────────────────────────

const handlers = {};

// ─── AUTH ────────────────────────────────────────────────

handlers['POST /api/auth/login'] = async (req, res, body) => {
  const { email, password, username } = body;
  const loginEmail = email || username;

  if (!loginEmail || !password) {
    return jsonResponse(res, 400, { error: 'Email y contraseña son requeridos.' });
  }

  // ── LOCAL-FIRST login flow (auth-service.js) ──────────────
  // 1. User in SQLite + online  → remote login, update local, triggers sync
  // 2. User in SQLite + offline → local auth hash check (max 7 days)
  // 3. User NOT in SQLite + online  → remote login + download branch data
  // 4. User NOT in SQLite + offline → error (must connect at least once)
  try {
    const result = await authService.login(loginEmail, password, {
      onStatus: (status) => loginEvents.emit('login-status', status),
    });

    if (!result.success) {
      const errBody = { error: result.error };
      if (result.emailPending)        errBody.emailPending = true;
      if (result.deviceVerification) errBody.requiresDeviceVerification = true;
      if (result.email)               errBody.email = result.email;
      if (result.deviceInfo)          errBody.deviceInfo = result.deviceInfo;
      if (result.codeSent != null)    errBody.codeSent = result.codeSent;
      if (result.blocked)             errBody.blocked = true;
      return jsonResponse(res, result.deviceVerification || result.blocked ? 403 : 401, errBody);
    }

    // Notify index.js to start sync (or skip if offline)
    loginEvents.emit('login-success', result);

    const u = result.user;
    return jsonResponse(res, 200, {
      token:              u.token,
      clientId:           u.clientId,
      sucursalId:         u.sucursalId,
      employeeId:         u.employeeId,
      employeeName:       u.employeeName       || '',
      clientName:         u.clientName         || '',
      roles:              u.roles              || [],
      subscriptionStatus: u.subscriptionStatus || 'ACTIVE',
      offlineMode:        result.isOffline      || false,
    });
  } catch (err) {
    console.error('[LOCAL-API] Login error:', err.message);
    return jsonResponse(res, 500, { error: 'Error interno al procesar el login.' });
  }
};

handlers['POST /api/auth/verify-device'] = async (req, res, body, route, query) => {
  const { email, code } = body;
  if (!email || !code) {
    return jsonResponse(res, 400, { error: 'Email y código son requeridos.' });
  }

  const result = await authService.verifyDevice(email, code, query.forceLogout === 'true', {
    onStatus: (status) => loginEvents.emit('login-status', status),
  });
  if (!result.success) {
    const { success, _httpStatus, ...errBody } = result;
    return jsonResponse(res, _httpStatus || 400, errBody);
  }

  loginEvents.emit('login-success', result);
  const u = result.user;
  return jsonResponse(res, 200, {
    token:              u.token,
    clientId:           u.clientId,
    sucursalId:         u.sucursalId,
    employeeId:         u.employeeId,
    employeeName:       u.employeeName       || '',
    clientName:         u.clientName         || '',
    roles:              u.roles              || [],
    subscriptionStatus: u.subscriptionStatus || 'ACTIVE',
  });
};

handlers['POST /api/auth/resend-verification-code'] = async (req, res, body) => {
  if (!body.email) {
    return jsonResponse(res, 400, { error: 'Email es requerido.' });
  }
  try {
    const result = await apiClient.resendVerificationCode(body.email);
    const { _httpStatus, ...responseBody } = result || {};
    return jsonResponse(res, _httpStatus || 200, responseBody);
  } catch (err) {
    return jsonResponse(res, 503, { error: `No se pudo reenviar el código: ${err.message}` });
  }
};

handlers['GET /api/auth/me'] = async (req, res) => {
  const db = getDb();
  const token = getConfigVal(db, 'auth_token');
  if (!token) return jsonResponse(res, 401, { error: 'No session' });

  return jsonResponse(res, 200, {
    clientId: Number(getConfigVal(db, 'client_id')),
    sucursalId: Number(getConfigVal(db, 'sucursal_id')),
    employeeId: Number(getConfigVal(db, 'employee_id')),
    employeeName: getConfigVal(db, 'employee_name') || '',
    clientName: getConfigVal(db, 'client_name') || '',
    roles: JSON.parse(getConfigVal(db, 'roles') || '[]'),
  });
};

handlers['GET /api/auth/session-status'] = async (req, res) => {
  const db = getDb();
  const revoked = getConfigVal(db, 'cloud_session_revoked') === '1';
  if (!getConfigVal(db, 'auth_token') || !apiClient.token || revoked) {
    return jsonResponse(res, 401, {
      active: false,
      reason: revoked ? 'SESSION_CLOSED' : 'NO_SESSION',
      ...(revoked ? {
        message: 'Tu sesión fue cerrada porque iniciaste sesión en otro dispositivo.',
      } : {}),
    });
  }

  // Refleja el último estado confirmado por el heartbeat autenticado del main process. No hacemos
  // otra llamada a la nube aquí para no duplicar el tráfico periódico del frontend y de Electron.
  return jsonResponse(res, 200, { active: true });
};

handlers['POST /api/auth/logout'] = async (req, res) => {
  return jsonResponse(res, 200, {});
};

// ─── PRODUCTS ────────────────────────────────────────────

handlers['GET /items'] = async (req, res, body, route, query) => {
  const db = getDb();
  const q = query.q || '';
  let products;

  if (q) {
    const term = `%${q}%`;
    products = db.all(`
      SELECT * FROM products
      WHERE active = 1 AND (name LIKE ?1 OR code LIKE ?1 OR description LIKE ?1)
      ORDER BY CASE WHEN code = ?2 THEN 0 ELSE 1 END, name ASC
      LIMIT 100
    `, [term, q]);
  } else {
    products = db.all('SELECT * FROM products WHERE active = 1 ORDER BY name ASC');
  }

  // Convert to ProductDto format the web frontend expects
  const dtos = products.map(productToDto);
  return jsonResponse(res, 200, dtos);
};

handlers['GET /items/:id'] = async (req, res, body, route, query, pathParams) => {
  const db = getDb();
  const product = db.get('SELECT * FROM products WHERE id = ? AND active = 1', [pathParams.id]);
  if (!product) return jsonResponse(res, 404, { error: 'Product not found' });
  return jsonResponse(res, 200, productToDto(product));
};

function productToDto(p) {
  return {
    id: p.id,
    code: p.code || '',
    name: p.name,
    description: p.description || null,
    quantity: p.quantity || 0,
    cost: p.cost || 0,
    price: p.price,
    lowStockThreshold: p.low_stock_threshold || null,
    reorderQtyDefault: p.reorder_qty_default || null,
    preferredProviderId: p.preferred_provider_id || null,
    providerIds: safeJsonParse(p.provider_ids, []),
    categoryIds: safeJsonParse(p.category_ids, []),
    subcategoryIds: safeJsonParse(p.subcategory_ids, []),
    costDerived: !!p.cost_derived,
    noCode: !!p.no_code,
    // Pesable: el POS lo necesita para resolver el PLU de una etiqueta de balanza escaneada.
    weighable: !!p.weighable,
    maxUnitPrice: p.max_unit_price ?? null,
    imageUrl: imageCache.getLocalUrl(p.id, 'image', p.image_url) || p.image_url || null,
    thumbnailUrl: imageCache.getLocalUrl(p.id, 'thumbnail', p.thumbnail_url) || p.thumbnail_url || null,
  };
}

function parseRawBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (settled) return;
      settled = true;
      resolve(null);
    });
  });
}

function safeJsonParse(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; }
  catch { return fallback; }
}

// ─── SCALE SETTINGS (balanza etiquetadora) ───────────────
//
// Se sirve LOCAL a propósito. La caja necesita la máscara para decodificar la etiqueta que escanea
// el cajero, y un cajero offline no puede consultarla en la nube: si esto proxeara, la lectura de
// balanza quedaría muerta justo en el escenario para el que existe el POS offline.
// El valor lo refresca sync-service al bajar el catálogo; hasta el primer sync queda deshabilitada.
const SCALE_SETTINGS_DEFAULTS = { enabled: false, prefix: '2', mask: 'PPPPPIIIIII', priceInCents: false };

handlers['GET /scale-settings'] = async (req, res, body, route) => {
  const db = getDb();

  // R8-#76: mismo criterio que GET /registers — no proxear con el token del dueño hacia otro tenant.
  const localClientId = getConfigVal(db, 'client_id');
  if (route.clientId != null && localClientId != null
      && String(route.clientId) !== String(localClientId)) {
    console.warn(`[LOCAL-API] GET /scale-settings bloqueado — clientId path=${route.clientId} vs local=${localClientId}`);
    return jsonResponse(res, 403, { error: 'Ruta no permitida desde el POS.' });
  }

  // Nube primero (mismo patrón que /registers): el dueño edita esta config desde el propio POS y
  // leer del cache le mostraría el valor viejo. Timeout corto para no trabar la caja.
  try {
    const token = getConfigVal(db, 'auth_token');
    const plainToken = token ? decryptToken(token) : null;

    if (plainToken && apiClient.baseUrl) {
      const cloudUrl = `${apiClient.baseUrl}/api/client-panel/${route.clientId}/sucursales/${route.sucursalId}/scale-settings`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const cloudRes = await fetch(cloudUrl, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${plainToken}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (cloudRes.ok) {
        const cloudData = await cloudRes.json();
        // Write-through: deja el cache listo para la próxima vez que no haya red.
        db.run(
          "INSERT OR REPLACE INTO app_config (key, value) VALUES ('scale_settings', ?)",
          [JSON.stringify(cloudData)]
        );
        return jsonResponse(res, 200, cloudData);
      }
    }
  } catch (err) {
    console.log('[LOCAL-API] Scale settings cloud fetch failed, using local cache:', err.message);
  }

  const cached = safeJsonParse(getConfigVal(db, 'scale_settings'), null);
  jsonResponse(res, 200, cached || SCALE_SETTINGS_DEFAULTS);
};

// ─── SALES ───────────────────────────────────────────────

handlers['POST /sales'] = async (req, res, body) => {
  const db = getDb();
  if (blockIfSessionRevoked(db, res)) return; // A02
  const {
    saleDate, employeeId, status = 'COMPLETED',
    items = [], payments = [],
    cashRegisterId, totalDiscount = 0,
    originalTotal, finalTotal, promotionDiscounts = [],
  } = body;

  // R4-#44: validar la entrada del FE ANTES de mutar stock/caja. Una cantidad <=0/negativa invertía el
  // `quantity - ?` (inflaba stock) y descuadraba el arqueo; el backend la rechaza con 400 (needs_review)
  // pero el stock local ya quedaba alterado. R4-#8: un ítem independiente sin nombre se rechaza acá.
  if (!Array.isArray(items) || items.length === 0) {
    return jsonResponse(res, 400, { error: 'La venta debe tener al menos un ítem.' });
  }
  for (const it of items) {
    const q = Number(it.quantity);
    if (!Number.isInteger(q) || q < 1) {
      return jsonResponse(res, 400, { error: 'Cantidad inválida en un ítem (entero ≥ 1).' });
    }
    if (it.unitPrice != null && Number(it.unitPrice) < 0) {
      return jsonResponse(res, 400, { error: 'Precio unitario inválido (no puede ser negativo).' });
    }
    if (it.productId == null && !(it.customName && String(it.customName).trim())) {
      return jsonResponse(res, 400, { error: 'Ítem independiente sin nombre.' });
    }
  }

  // El frontend NO manda unitPrice para los ítems de CATÁLOGO (toSaleItemPayload sólo lo envía en el
  // ítem independiente y en el pesable): online el precio lo pone el backend desde su catálogo, que es
  // la autoridad. Offline no hay backend que complete el dato, así que el POS lo resuelve contra SU
  // catálogo local. Sin esto quedaba unit_price = 0 en toda venta de catálogo hecha en el POS, y de ahí
  // colgaban tres síntomas: la venta valía $0 mientras estaba 'pending' (se reconciliaba recién al
  // sincronizar — nunca si caía en needs_review) y, lo serio, la DEVOLUCIÓN offline reembolsaba $0, con
  // lo cual computeExpectedInCash no descontaba la plata que el cajero sí había entregado y el cierre
  // le imputaba un faltante fantasma.
  //
  // El precio enviado por el cliente se guarda APARTE (client_unit_price) porque es el único que el
  // sync debe reenviar. Mandar el precio resuelto del catálogo local despertaría el guard de
  // SalesService (clientSaleUuid + unitPrice != null && > 0): si el precio cambió en la nube entre el
  // cacheo del catálogo y el sync, un CAJERO se comería un 403 "no coincide con el de catálogo" y la
  // venta caería en needs_review. Con la separación, el payload de sync queda idéntico al de hoy.
  const resolvedItems = items.map((item) => {
    // R4-#8: los ítems INDEPENDIENTES (productId null) no están en el catálogo; traen customName y
    // unitPrice propios. El nombre se persiste en product_name — si no, el backend lo exige no-blank
    // al sincronizar y la venta independiente offline quedaba atrapada en needs_review.
    const prod = item.productId != null
      ? db.get('SELECT name, code, price FROM products WHERE id = ?', [item.productId])
      : null;
    const clientUnitPrice = item.unitPrice != null ? Number(item.unitPrice) : null;
    return {
      ...item,
      productName: prod
        ? prod.name
        : (item.customName && String(item.customName).trim() ? String(item.customName).trim() : 'Producto'),
      productCode: prod ? prod.code : null,
      clientUnitPrice,
      unitPrice: clientUnitPrice != null
        ? clientUnitPrice
        : (prod && prod.price != null ? Number(prod.price) : 0),
    };
  });

  const totalAmount = round2(finalTotal || resolvedItems.reduce((sum, i) => sum + (i.quantity * i.unitPrice), 0)); // B10

  // Clave de idempotencia (C01/F04): se genera UNA vez al crear la venta offline y se persiste.
  // El sync la reenvía en cada reintento; el backend deduplica por (client_id, client_sale_uuid).
  const clientSaleUuid = crypto.randomUUID();
  // C05: fecha de venta en hora de negocio (Argentina), no UTC, para no caer al día equivocado.
  const saleDateBusiness = toBusinessIso(saleDate);

  // Get current open cash session
  const currentSession = getScopedOpenCashSession(db);
  // Una versión vieja del frontend podía omitir cashRegisterId en ventas estándar aunque el turno
  // local sí tuviera caja. Persistir la caja efectiva evita que el sync envíe NULL y que la nube
  // rechace la venta con 409 por no poder abrir/vincular la sesión.
  const effectiveCashRegisterId = Number(cashRegisterId) > 0
    ? Number(cashRegisterId)
    : (Number(currentSession?.cash_register_id) > 0 ? Number(currentSession.cash_register_id) : null);
  if (!currentSession) {
    return jsonResponse(res, 409, { error: 'No hay un turno de caja abierto para registrar la venta.' });
  }
  if (!effectiveCashRegisterId) {
    return jsonResponse(res, 409, {
      error: 'El turno abierto no tiene una caja válida asociada. Cerralo y abrí uno nuevo antes de vender.',
    });
  }

  // P1-08: si la venta offline no trae employeeId, usar el del usuario logueado
  // (app_config), igual que devoluciones/movimientos. El backend exige employeeId
  // (@NotNull @Positive) → mandarlo null deja la venta atrapada en needs_review.
  const effectiveEmployeeId = employeeId || Number(getConfigVal(db, 'employee_id')) || null;
  const effectiveEmployeeName = getConfigVal(db, 'employee_name') || null;

  // P1-01: la venta + ítems + pagos + descuento de stock + ajuste de caja deben ser
  // atómicos. Sin transacción, un crash a mitad deja una venta sin líneas, o stock
  // descontado / expected_amount inflado sin venta.
  let localId;
  db.transaction(() => {
  const saleResult = db.run(`
    INSERT INTO sales (client_sale_uuid, sale_date, employee_id, employee_name, status,
      total_amount, total_discount, original_total, final_total,
      cash_register_id, cash_session_id, client_id, sucursal_id, invoice_json, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `, [
    clientSaleUuid,
    saleDateBusiness,
    effectiveEmployeeId, effectiveEmployeeName, status,
    totalAmount, totalDiscount, originalTotal || totalAmount, finalTotal || totalAmount,
    effectiveCashRegisterId, currentSession ? currentSession.id : null,
    Number(getConfigVal(db, 'client_id')) || null, Number(getConfigVal(db, 'sucursal_id')) || null, // R4-#40: tenant/sucursal de ORIGEN
    (body.invoice && body.invoice.emitInvoice) ? JSON.stringify(body.invoice) : null, // R4-#5 p3: intención de factura offline
  ]);

  localId = saleResult.lastId;

  for (const item of resolvedItems) {
    db.run(`
      INSERT INTO sale_items (sale_local_id, product_id, product_name, product_code, quantity,
        unit_price, client_unit_price)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      localId, item.productId,
      item.productName,
      item.productCode,
      item.quantity, item.unitPrice, item.clientUnitPrice,
    ]);

    // Decrement local stock. Los PESABLES quedan afuera igual que los no_code: se venden por kilo
    // y `quantity` es entero, así que el backend tampoco se los descuenta. Si no se excluyeran acá,
    // el stock local divergiría del de la nube en cada venta pesada.
    db.run(
      'UPDATE products SET quantity = MAX(0, quantity - ?) WHERE id = ? AND no_code = 0 AND weighable = 0',
      [item.quantity, item.productId]
    );
  }

  for (const pay of payments) {
    db.run(`
      INSERT INTO sale_payments (sale_local_id, payment_method, amount, external_ref)
      VALUES (?, ?, ?, ?)
    `, [localId, pay.paymentMethod, pay.amount, pay.externalReference || null]);
  }

  for (const disc of promotionDiscounts) {
    db.run(`
      INSERT INTO sale_promotion_discounts (sale_local_id, promotion_id, promotion_name, discount_amount)
      VALUES (?, ?, ?, ?)
    `, [localId, disc.promotionId, disc.promotionName, disc.discountAmount]);
  }

  // Update cash session expected amount
  // R7-#51: el esperado-en-caja sólo debe crecer con EFECTIVO; sumar el totalAmount (que incluye
  // tarjeta/transferencia/MP) inflaba expected_amount durante la sesión y GET /cash-sessions/current
  // exponía ese valor falso. Alineado con computeExpectedInCash (que sólo cuenta EFECTIVO al cerrar).
  if (currentSession) {
    const cashCollected = round2(
      payments.reduce((sum, p) => sum + (p.paymentMethod === 'EFECTIVO' ? (Number(p.amount) || 0) : 0), 0)
    ); // B10
    if (cashCollected > 0) {
      db.run(
        'UPDATE cash_sessions SET expected_amount = expected_amount + ? WHERE id = ?',
        [cashCollected, currentSession.id]
      );
    }
  }
  }); // transaction() commits + persists to disk synchronously

  // Return response matching SaleDto
  return jsonResponse(res, 201, {
    id: localId,
    saleId: localId,
    saleDate: saleDateBusiness,
    totalAmount,
    status,
    offlineCreated: true,
    items: resolvedItems.map((i, idx) => ({
      saleItemId: idx + 1,
      productId: i.productId,
      quantity: i.quantity,
      unitPrice: i.unitPrice, // precio efectivo: antes venía undefined en los ítems de catálogo
    })),
  });
};

handlers['GET /sales'] = async (req, res, body, route, query) => {
  const db = getDb();
  const today = businessNowIso().slice(0, 10);

  // R7-#69: NO devolver todas las ventas del día del dispositivo. En un POS compartido eso filtraba
  // las ventas del primer cajero al segundo (nombres, ítems, precios). Scopear a la sesión de caja
  // abierta AHORA (turno actual); si no hay sesión abierta, al empleado logueado. El endpoint scoped
  // GET /cash-sessions/:id/sales ya filtra por cash_session_id; acá replicamos ese aislamiento.
  const currentSession = getScopedOpenCashSession(db);
  const currentEmployeeId = Number(getConfigVal(db, 'employee_id')) || null;

  let sales;
  if (currentSession) {
    sales = db.all(
      "SELECT * FROM sales WHERE sale_date LIKE ? AND cash_session_id = ? ORDER BY created_at DESC LIMIT 100",
      [`${today}%`, currentSession.id]
    );
  } else if (currentEmployeeId != null) {
    sales = db.all(
      "SELECT * FROM sales WHERE sale_date LIKE ? AND employee_id = ? ORDER BY created_at DESC LIMIT 100",
      [`${today}%`, currentEmployeeId]
    );
  } else {
    // Sin sesión abierta ni empleado resuelto: no exponer ventas de otros (devolver vacío).
    sales = [];
  }

  const result = sales.map((s) => {
    const items = db.all('SELECT * FROM sale_items WHERE sale_local_id = ?', [s.local_id]);
    const payments = db.all('SELECT * FROM sale_payments WHERE sale_local_id = ?', [s.local_id]);
    return {
      id: s.cloud_id || s.local_id,
      saleDate: s.sale_date,
      fecha: s.sale_date,
      totalAmount: s.total_amount,
      quantity: items.reduce((sum, i) => sum + i.quantity, 0),
      status: s.status,
      cliente: s.employee_name || '',
      paymentMethod: payments[0]?.payment_method || 'EFECTIVO',
      items: items.map((i) => ({
        saleItemId: i.id,
        productId: i.product_id,
        productName: i.product_name,
        quantity: i.quantity,
        unitPrice: i.unit_price,
      })),
    };
  });

  return jsonResponse(res, 200, result);
};

function localSaleToDto(db, sale) {
  const items = db.all('SELECT * FROM sale_items WHERE sale_local_id = ? ORDER BY id ASC', [sale.local_id]);
  const payments = db.all('SELECT * FROM sale_payments WHERE sale_local_id = ? ORDER BY id ASC', [sale.local_id]);
  return {
    id: sale.cloud_id || sale.local_id,
    saleDate: sale.sale_date,
    fecha: sale.sale_date,
    totalAmount: sale.total_amount,
    totalDiscount: sale.total_discount || 0,
    status: sale.status,
    paymentMethod: payments[0]?.payment_method || 'EFECTIVO',
    payments: payments.map((payment) => ({
      id: payment.id,
      paymentMethod: payment.payment_method,
      amount: payment.amount,
      externalId: payment.external_ref || undefined,
    })),
    items: items.map((item) => ({
      saleItemId: item.id,
      productId: item.product_id,
      productName: item.product_name,
      quantity: item.quantity,
      unitPrice: item.unit_price,
    })),
  };
}

/**
 * Resuelve el ID que ve el usuario sin mezclar los dos espacios de IDs del POS.
 * Una fila sincronizada deja de ser identificable por local_id: desde ese momento su ID público
 * es cloud_id. El local_id sólo sigue siendo público mientras cloud_id es NULL (venta offline).
 */
function findLocalSaleByPublicId(db, saleId) {
  const cloudSale = db.get(
    'SELECT * FROM sales WHERE cloud_id = ? ORDER BY local_id DESC LIMIT 1',
    [saleId]
  );
  if (cloudSale) return cloudSale;
  return db.get(
    'SELECT * FROM sales WHERE local_id = ? AND cloud_id IS NULL',
    [saleId]
  );
}

// El modal de devoluciones consulta una venta puntual antes de habilitar las cantidades.
// Esta ruta faltaba en el servidor local: para un cajero siempre terminaba en el 404 del router,
// aunque la venta estuviera guardada en SQLite. Si no pertenece a este dispositivo, se intenta
// la consulta cloud para conservar el flujo online de ventas hechas desde otro puesto.
handlers['GET /sales/:id'] = async (req, res, body, route, query, pathParams) => {
  const db = getDb();
  const saleId = Number(pathParams.id);
  const localClientId = Number(getConfigVal(db, 'client_id')) || null;
  const localSucursalId = Number(getConfigVal(db, 'sucursal_id')) || null;

  if ((localClientId != null && Number(route.clientId) !== localClientId)
      || (localSucursalId != null && Number(route.sucursalId) !== localSucursalId)) {
    return jsonResponse(res, 403, { error: 'Ruta no permitida desde el POS.' });
  }

  const sale = findLocalSaleByPublicId(db, saleId);

  const belongsToActiveBranch = sale
    && (sale.client_id == null || localClientId == null || Number(sale.client_id) === localClientId)
    && (sale.sucursal_id == null || localSucursalId == null || Number(sale.sucursal_id) === localSucursalId);
  if (belongsToActiveBranch) {
    return jsonResponse(res, 200, localSaleToDto(db, sale));
  }

  if (apiClient.token) {
    try {
      const cloudSale = await apiClient.getSaleById(saleId);
      return jsonResponse(res, 200, cloudSale);
    } catch (err) {
      const cloudError = parseCloudHttpError(err);
      if (cloudError) return jsonResponse(res, cloudError.status, { error: cloudError.message });
      return jsonResponse(res, 503, {
        error: 'La venta no está guardada en este POS y no se pudo consultar en la nube.',
        offline: true,
      });
    }
  }

  return jsonResponse(res, 404, { error: 'Venta no encontrada en este POS.' });
};

// ─── DAILY-CLOSE / SESSIONS (local read for RegisterPicker) ─────────────────
// Returns today's cash sessions from SQLite so the register picker can mark
// which registers are occupied. Full daily-close management is cloud-only.

handlers['GET /daily-close/sessions'] = async (req, res, body, route, query) => {
  const db = getDb();
  const dateParam = query.date || businessNowIso().slice(0, 10);
  const page = parseInt(query.page || '0', 10);
  const size = parseInt(query.size || '20', 10);

  const sessions = db.all(
    `SELECT * FROM cash_sessions
     WHERE business_date = ? OR (business_date IS NULL AND DATE(opening_time) = ?)
     ORDER BY opening_time DESC
     LIMIT ? OFFSET ?`,
    [dateParam, dateParam, size, page * size]
  );

  const total = db.get(
    `SELECT COUNT(*) as cnt FROM cash_sessions
     WHERE business_date = ? OR (business_date IS NULL AND DATE(opening_time) = ?)`,
    [dateParam, dateParam]
  );

  const content = sessions.map((s) => ({
    id: s.id,
    clientId: s.client_id,
    sucursalId: s.sucursal_id,
    employeeId: s.employee_id,
    employeeName: s.employee_name,
    status: s.status,
    businessDate: s.business_date || s.opening_time?.slice(0, 10),
    openingTime: s.opening_time,
    closingTime: s.closing_time || null,
    initialAmount: s.initial_amount,
    expectedAmount: s.expected_amount,
    countedAmount: s.counted_amount,
    difference: s.difference,
    cashRegisterId: s.cash_register_id,
    cashRegisterName: s.cash_register_name || null,
    cashRegisterCode: s.cash_register_code || null,
    floatLeftForNext: s.float_left_for_next || null,
    closingNote: s.closing_note || null,
  }));

  return jsonResponse(res, 200, {
    content,
    totalElements: total?.cnt || 0,
    totalPages: Math.ceil((total?.cnt || 0) / size),
    number: page,
    size,
  });
};

// ─── CASH REGISTERS ─────────────────────────────────────

function parseCloudHttpError(err) {
  const match = String(err?.message || '').match(/^HTTP\s+(\d+):\s*([\s\S]*)$/);
  if (!match) return null;

  const status = Number(match[1]);
  const rawBody = match[2];
  let body = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; } catch (_) { /* respuesta no JSON */ }
  const message = body.message || body.reason || body.error || rawBody
    || 'La nube rechazó la operación.';
  return { status, message };
}

handlers['GET /registers'] = async (req, res, body, route, query) => {
  const db = getDb();
  const onlyActive = query.onlyActive !== 'false';

  // R8-#76: defensa en profundidad — rechazar si el clientId del PATH no coincide con el cliente
  // autenticado localmente. El backend re-valida el JWT, así que el daño real es limitado, pero
  // el POS no debe convertirse en un proxy para leer cajas de otro tenant con el token del dueño.
  const localClientId = getConfigVal(db, 'client_id');
  if (route.clientId != null && localClientId != null
      && String(route.clientId) !== String(localClientId)) {
    console.warn(`[LOCAL-API] R8-#76: GET /registers bloqueado — clientId path=${route.clientId} vs local=${localClientId}`);
    return jsonResponse(res, 403, { error: 'Ruta no permitida desde el POS.' });
  }

  // Always try cloud first for register selection — the user needs
  // real-time availability (which register is free/occupied).
  try {
    const token = getConfigVal(db, 'auth_token');
    const plainToken = token ? decryptToken(token) : null;

    if (plainToken && apiClient.baseUrl) {
      const cloudUrl = `${apiClient.baseUrl}/api/client-panel/${route.clientId}/sucursales/${route.sucursalId}/registers?onlyActive=${onlyActive}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const cloudRes = await fetch(cloudUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${plainToken}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (cloudRes.ok) {
        const cloudData = await cloudRes.json();
        return jsonResponse(res, 200, cloudData);
      }
    }
  } catch (err) {
    console.log('[LOCAL-API] Registers cloud fetch failed, using local cache:', err.message);
  }

  // Offline fallback — serve from local cache with warning flag
  const where = onlyActive ? 'WHERE active = 1' : '';
  const registers = db.all(`SELECT * FROM cash_registers ${where} ORDER BY name ASC`);

  const dtos = registers.map((r) => ({
    id: r.id,
    code: r.code || '',
    name: r.name,
    active: !!r.active,
    defaultOpeningFloat: r.default_opening_float || 0,
    blindCountEnabled: !!r.blind_count_enabled,
    sucursalId: r.sucursal_id,
    externalPosId: r.external_pos_id || null,
    qrUrl: r.qr_url || null,
    pointDeviceId: r.point_device_id || null,
    _offlineWarning: true,
  }));

  return jsonResponse(res, 200, dtos);
};

handlers['GET /registers/availability'] = async (req, res, body, route, query) => {
  const db = getDb();
  const onlyActive = query.onlyActive !== 'false';
  const localClientId = getConfigVal(db, 'client_id');

  if (route.clientId != null && localClientId != null
      && String(route.clientId) !== String(localClientId)) {
    return jsonResponse(res, 403, { error: 'Ruta no permitida desde el POS.' });
  }

  // Fuente autoritativa: la nube ve las aperturas hechas por todos los POS y navegadores.
  try {
    if (apiClient.token && await apiClient.isOnline() && apiClient.lastHeartbeatAuthed) {
      const cloudData = await apiClient.getRegisterAvailability(onlyActive);
      return jsonResponse(res, 200, (Array.isArray(cloudData) ? cloudData : []).map((entry) => ({
        ...entry,
        availabilityVerified: true,
      })));
    }
  } catch (err) {
    const cloudError = parseCloudHttpError(err);
    if (cloudError) {
      return jsonResponse(res, cloudError.status, { error: cloudError.message });
    }
    console.log('[LOCAL-API] Register availability cloud fetch failed, using local state:', err.message);
  }

  // Sin conexión no afirmamos que una caja esté libre: exponemos el estado local y lo marcamos
  // expresamente como no verificado para que la UI lo comunique al cajero.
  const where = onlyActive ? 'WHERE active = 1' : '';
  const registers = db.all(`SELECT * FROM cash_registers ${where} ORDER BY name ASC`);
  const localOpen = db.all("SELECT * FROM cash_sessions WHERE status = 'OPEN' AND cash_register_id IS NOT NULL");
  const openByRegister = new Map(localOpen.map((s) => [String(s.cash_register_id), s]));

  return jsonResponse(res, 200, registers.map((r) => {
    const session = openByRegister.get(String(r.id));
    return {
      register: {
        id: r.id,
        code: r.code || '',
        name: r.name,
        active: !!r.active,
        defaultOpeningFloat: r.default_opening_float || 0,
        blindCountEnabled: !!r.blind_count_enabled,
        cashierReleaseEnabled: !!r.cashier_release_enabled,
        sucursalId: r.sucursal_id,
        pointDeviceId: r.point_device_id || null,
      },
      occupied: !!session,
      occupiedSessionId: session?.cloud_id || session?.id || null,
      occupiedByEmployeeId: session?.employee_id || null,
      occupiedByEmployeeName: session?.employee_name || null,
      occupiedSince: session?.opening_time || null,
      availabilityVerified: false,
      _offlineWarning: true,
    };
  }));
};

// ─── CASH SESSIONS ───────────────────────────────────────

handlers['GET /cash-sessions/current'] = async (req, res) => {
  const db = getDb();
  let session = getScopedOpenCashSession(db);

  // Online-first: la sesión actual del JWT es la autoridad. Una fila OPEN de otro empleado
  // nunca se devuelve como propia. Las aperturas offline del mismo empleado se intentan enlazar
  // por UUID; un rechazo funcional de la nube las aísla para que no habiliten ventas por error.
  try {
    if (apiClient.token && await apiClient.isOnline() && apiClient.lastHeartbeatAuthed) {
      const cloudSession = await apiClient.getCurrentSession();
      if (cloudSession?.status === 'OPEN') {
        const locallyClosed = getScopedClosedCashSessionByCloudId(db, cloudSession.id);
        if (locallyClosed) {
          // La nube puede quedar unos segundos detrás del cierre local mientras el sync sube ventas,
          // movimientos y finalmente el arqueo. No resucitar esa misma sesión como una fila OPEN.
          if (session?.cloud_id && String(session.cloud_id) === String(cloudSession.id)) {
            quarantineLocalCashSession(
              db,
              session,
              'Duplicado local descartado: esta sesión ya había sido cerrada en el POS.'
            );
          }
          session = session?.cloud_id && String(session.cloud_id) === String(cloudSession.id)
            ? null
            : session;
          db.save();
        } else {
          session = linkOrMirrorCloudCashSession(db, session, cloudSession);
          db.save();
        }
      } else if (session?.cloud_id) {
        quarantineLocalCashSession(db, session, 'La nube ya no reconoce esta sesión como abierta.');
        db.save();
        session = null;
      } else if (session?.client_session_uuid && session?.cash_register_id) {
        try {
          const reconciled = await apiClient.openSession({
            clientSessionUuid: session.client_session_uuid,
            cashRegisterId: Number(session.cash_register_id),
            initialAmount: Number(session.initial_amount) || 0,
          });
          if (reconciled?.status === 'OPEN') {
            session = linkOrMirrorCloudCashSession(db, session, reconciled);
          } else {
            quarantineLocalCashSession(db, session, 'La sesión idempotente ya no está abierta en la nube.');
            session = null;
          }
          db.save();
        } catch (err) {
          const cloudError = parseCloudHttpError(err);
          if (cloudError && cloudError.status >= 400 && cloudError.status < 500) {
            quarantineLocalCashSession(db, session, cloudError.message);
            db.save();
            session = null;
          } else if (cloudError) {
            return jsonResponse(res, cloudError.status, { error: cloudError.message });
          }
          // Error de transporte: conservar la sesión offline scoped del mismo empleado.
        }
      } else if (session) {
        quarantineLocalCashSession(db, session, 'Sesión local antigua sin identificador para reconciliar.');
        db.save();
        session = null;
      }
    }
  } catch (err) {
    const cloudError = parseCloudHttpError(err);
    if (cloudError) {
      return jsonResponse(res, cloudError.status, { error: cloudError.message });
    }
    // Sin conectividad real se mantiene el modo offline, siempre scoped al empleado actual.
  }

  if (!session) return jsonResponse(res, 200, null);

  // Calculate sales totals for this session
  const salesByMethod = {};
  let totalSales = 0;
  const sessionSales = db.all(
    'SELECT sp.payment_method, sp.amount FROM sales s JOIN sale_payments sp ON sp.sale_local_id = s.local_id WHERE s.cash_session_id = ?',
    [session.id]
  );
  for (const sp of sessionSales) {
    salesByMethod[sp.payment_method] = (salesByMethod[sp.payment_method] || 0) + sp.amount;
    totalSales += sp.amount;
  }

  return jsonResponse(res, 200, sessionToDto(session, salesByMethod, totalSales));
};

handlers['GET /cash-sessions/current/preview'] = async (req, res) => {
  // Same as current
  return handlers['GET /cash-sessions/current'](req, res);
};

handlers['GET /cash-sessions/open-preview'] = async (req, res, body, route, query) => {
  const db = getDb();
  const cashRegisterId = query.cashRegisterId;

  const localClientId = Number(getConfigVal(db, 'client_id')) || null;
  const localSucursalId = Number(getConfigVal(db, 'sucursal_id')) || null;
  if ((localClientId != null && Number(route.clientId) !== localClientId)
      || (localSucursalId != null && Number(route.sucursalId) !== localSucursalId)) {
    return jsonResponse(res, 403, { error: 'Ruta no permitida desde el POS.' });
  }

  // La nube es la autoridad para el carry-over: el cierre anterior puede haberse realizado desde
  // el navegador u otro POS y, por diseño, las sesiones ajenas no se importan a la base local.
  // Si no hay conectividad real conservamos el preview local para poder seguir operando offline.
  try {
    if (apiClient.token && await apiClient.isOnline() && apiClient.lastHeartbeatAuthed) {
      const cloudPreview = await apiClient.getOpenSessionPreview(cashRegisterId);
      return jsonResponse(res, 200, cloudPreview);
    }
  } catch (err) {
    const cloudError = parseCloudHttpError(err);
    if (cloudError) {
      return jsonResponse(res, cloudError.status, { error: cloudError.message });
    }
    console.log('[LOCAL-API] Open preview cloud fetch failed, using local state:', err.message);
  }

  const register = cashRegisterId
    ? db.get('SELECT * FROM cash_registers WHERE id = ?', [cashRegisterId])
    : null;

  // Look for previous session on this register
  const prevSession = cashRegisterId
    ? db.get(
        "SELECT * FROM cash_sessions WHERE cash_register_id = ? AND status = 'CLOSED' ORDER BY closing_time DESC LIMIT 1",
        [cashRegisterId]
      )
    : null;

  const suggestedAmount = prevSession?.float_left_for_next || register?.default_opening_float || 0;

  return jsonResponse(res, 200, {
    cashRegisterId: cashRegisterId ? Number(cashRegisterId) : null,
    cashRegisterName: register?.name || null,
    cashRegisterCode: register?.code || null,
    defaultOpeningFloat: register?.default_opening_float || 0,
    hasCarryOver: !!prevSession?.float_left_for_next,
    previousSessionId: prevSession?.id || null,
    previousEmployeeName: prevSession?.employee_name || null,
    previousClosingTime: prevSession?.closing_time || null,
    previousFloatLeft: prevSession?.float_left_for_next || null,
    previousCountedAmount: prevSession?.counted_amount || null,
    suggestedAmount,
    suggestedAmountSource: prevSession?.float_left_for_next ? 'CARRY_OVER' : 'DEFAULT_FLOAT',
    requireOpeningConfirmation: false,
    allowOpeningDiscrepancy: true,
    discrepancyThreshold: null,
    blindCountEnabled: !!register?.blind_count_enabled,
  });
};

handlers['POST /cash-sessions/open'] = async (req, res, body) => {
  const db = getDb();
  if (blockIfSessionRevoked(db, res)) return; // A02
  const { cashRegisterId, initialAmount, declaredAmount } = body;

  // El usuario actual no puede abrir un segundo turno. Otros usuarios sólo bloquean su caja.
  const existing = getScopedOpenCashSession(db);
  if (existing) {
    return jsonResponse(res, 400, { error: 'Ya hay una sesión de caja abierta.' });
  }

  const register = cashRegisterId
    ? db.get('SELECT * FROM cash_registers WHERE id = ?', [cashRegisterId])
    : null;

  if (!cashRegisterId || !register || !register.active) {
    return jsonResponse(res, 409, { error: 'La caja seleccionada no existe o está inactiva.' });
  }

  const localRegisterOccupant = db.get(
    "SELECT employee_name FROM cash_sessions WHERE status = 'OPEN' AND cash_register_id = ? LIMIT 1",
    [cashRegisterId]
  );
  if (localRegisterOccupant) {
    return jsonResponse(res, 409, {
      error: `La caja seleccionada ya está ocupada${localRegisterOccupant.employee_name ? ` por ${localRegisterOccupant.employee_name}` : ''}.`,
    });
  }

  const requestedAmount = declaredAmount ?? initialAmount;
  const now = businessNowIso(); // C05: hora de negocio (Argentina)
  const today = now.slice(0, 10);
  const employeeId = Number(getConfigVal(db, 'employee_id'));
  const employeeName = getConfigVal(db, 'employee_name') || '';

  // Clave de idempotencia (C01): se persiste y el sync la reenvía. El backend la consumirá en P3
  // (rework de enlace de sesión) para deduplicar reaperturas; aquí ya queda generada y guardada.
  const clientSessionUuid = crypto.randomUUID();

  let cloudSession = null;
  try {
    if (apiClient.token && await apiClient.isOnline() && apiClient.lastHeartbeatAuthed) {
      cloudSession = await apiClient.openSession({
        clientSessionUuid,
        cashRegisterId: Number(cashRegisterId),
        ...(requestedAmount != null ? { initialAmount: Number(requestedAmount) } : {}),
      });
    }
  } catch (err) {
    // Un rechazo HTTP es autoritativo (ocupada, empleado con otra sesión, permisos, etc.).
    // Un fallo de transporte conserva la capacidad offline; el UUID hace idempotente el reintento.
    const cloudError = parseCloudHttpError(err);
    if (cloudError) {
      return jsonResponse(res, cloudError.status, { error: cloudError.message });
    }
    console.log('[LOCAL-API] Cloud register reservation unavailable, opening offline:', err.message);
  }

  const amount = cloudSession?.initialAmount
    ?? requestedAmount
    ?? register.default_opening_float
    ?? 0;

  const result = db.run(`
    INSERT INTO cash_sessions (cloud_id, client_session_uuid, client_id, sucursal_id, employee_id, employee_name,
      status, business_date, opening_time, initial_amount, expected_amount,
      cash_register_id, cash_register_name, cash_register_code, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, 'pending')
  `, [
    cloudSession?.id || null,
    clientSessionUuid,
    Number(getConfigVal(db, 'client_id')),
    Number(getConfigVal(db, 'sucursal_id')),
    employeeId, employeeName,
    today, now, Number(amount), Number(amount),
    cashRegisterId || null,
    register?.name || null,
    register?.code || null,
  ]);

  db.save();

  return jsonResponse(res, 200, {
    id: result.lastId,
    status: 'OPEN',
    businessDate: today,
    openingTime: now,
    initialAmount: Number(amount),
    expectedAmount: Number(amount),
    cashRegisterId: cashRegisterId || null,
    cashRegisterName: register?.name || null,
    cashRegisterCode: register?.code || null,
    employeeId,
    employeeName,
    onlineConfirmed: !!cloudSession,
  });
};

handlers['POST /cash-sessions/open-with-tracking'] = handlers['POST /cash-sessions/open'];

handlers['POST /shift/open'] = async (req, res, body) => {
  // ShiftApi.open is the same as cash-sessions/open
  return handlers['POST /cash-sessions/open'](req, res, body);
};

handlers['POST /cash-sessions/close'] = async (req, res, body, route, query, pathParams = {}) => {
  const db = getDb();
  if (blockIfSessionRevoked(db, res)) return; // R4-#61 (A02): faltaba el guard en el cierre → se podía
  // cerrar/escribir caja con la sesión cloud ya revocada (cubre también el alias close-with-tracking).
  const { countedAmount, floatLeftForNext, note } = body;

  const requestedId = pathParams.id != null ? Number(pathParams.id) : null;
  const hasRequestedId = Number.isSafeInteger(requestedId) && requestedId > 0;
  const session = getScopedOpenCashSession(db);

  // El endpoint con :id debe ser idempotente. Si el primer POST cerró correctamente pero la UI
  // reintentó por un refresh o una respuesta perdida, devolver el cierre existente evita un 400 y,
  // sobre todo, impide que un modal viejo cierre por accidente un turno nuevo.
  if (hasRequestedId && session
      && String(session.id) !== String(requestedId)
      && String(session.cloud_id) !== String(requestedId)) {
    const alreadyClosed = getScopedClosedCashSessionByAnyId(db, requestedId);
    if (alreadyClosed) return jsonResponse(res, 200, sessionToDto(alreadyClosed));
    return jsonResponse(res, 409, {
      error: 'La sesión solicitada ya no es la sesión de caja abierta actual.',
    });
  }

  if (!session) {
    if (hasRequestedId) {
      const alreadyClosed = getScopedClosedCashSessionByAnyId(db, requestedId);
      if (alreadyClosed) return jsonResponse(res, 200, sessionToDto(alreadyClosed));
    }
    return jsonResponse(res, 400, { error: 'No hay sesión de caja abierta.' });
  }

  const now = businessNowIso();
  const counted = Number(countedAmount) || 0;
  // B03: el esperado se recalcula SOLO con efectivo al cerrar (la columna expected_amount sumaba
  // ventas con tarjeta/transferencia → faltantes ficticios). Persistimos el recálculo.
  const expectedInCash = computeExpectedInCash(db, session);
  const diff = counted - expectedInCash;

  db.run(`
    UPDATE cash_sessions SET
      status = 'CLOSED', closing_time = ?, counted_amount = ?,
      expected_amount = ?, difference = ?, closing_note = ?, float_left_for_next = ?,
      sync_status = 'pending'
    WHERE id = ?
  `, [now, counted, expectedInCash, diff, note || null, floatLeftForNext || null, session.id]);

  db.save();

  return jsonResponse(res, 200, {
    ...sessionToDto(session),
    status: 'CLOSED',
    closingTime: now,
    countedAmount: counted,
    expectedAmount: expectedInCash,
    difference: diff,
    closingNote: note || null,
    floatLeftForNext: floatLeftForNext || null,
  });
};

// Handle close with session ID in path: /cash-sessions/:id/close-with-tracking
handlers['POST /cash-sessions/:id/close-with-tracking'] = handlers['POST /cash-sessions/close'];

handlers['GET /cash-sessions/:id/close-preview'] = async (req, res, body, route, query, pathParams) => {
  const db = getDb();
  const sessionId = pathParams.id;

  let session;
  if (sessionId === 'current') {
    session = getScopedOpenCashSession(db);
  } else {
    session = getOwnedCashSessionByAnyId(db, sessionId);
  }

  if (!session) return jsonResponse(res, 404, { error: 'Session not found' });

  // Calculate sales breakdown
  const salesByMethod = {};
  let totalSales = 0;
  let cashSales = 0;
  const sessionSales = db.all(
    'SELECT sp.payment_method, sp.amount FROM sales s JOIN sale_payments sp ON sp.sale_local_id = s.local_id WHERE s.cash_session_id = ?',
    [session.id]
  );
  for (const sp of sessionSales) {
    salesByMethod[sp.payment_method] = (salesByMethod[sp.payment_method] || 0) + sp.amount;
    totalSales += sp.amount;
    if (sp.payment_method === 'EFECTIVO') cashSales += sp.amount;
  }

  // Calculate cash movements for this session
  const movements = db.all(
    "SELECT type, amount FROM cash_movements WHERE cash_session_id = ? AND scope = 'SESSION'",
    [session.id]
  );
  let injectionsTotal = 0;
  let withdrawalsTotal = 0;
  for (const m of movements) {
    if (m.type === 'INJECTION') injectionsTotal += m.amount;
    else if (m.type === 'WITHDRAWAL' || m.type === 'EXPENSE') withdrawalsTotal += m.amount;
  }

  // Calculate cash refunds for this session
  // B01: el método de reembolso canónico del backend es 'CASH' (enum RefundMethod), no 'EFECTIVO'.
  // Filtrar por 'EFECTIVO' devolvía 0 → las devoluciones en efectivo no se descontaban del esperado.
  const cashRefundsRow = db.get(
    "SELECT COALESCE(SUM(total_refund_amount), 0) as total FROM returns WHERE cash_session_id = ? AND refund_method = 'CASH'",
    [session.id]
  );
  const refundsTotal = cashRefundsRow ? cashRefundsRow.total : 0;

  const expectedInCash = session.initial_amount + cashSales + injectionsTotal - withdrawalsTotal - refundsTotal;

  const formulaParts = [`${session.initial_amount} (apertura)`, `+ ${cashSales} (ventas efectivo)`];
  if (injectionsTotal > 0) formulaParts.push(`+ ${injectionsTotal} (ingresos)`);
  if (withdrawalsTotal > 0) formulaParts.push(`- ${withdrawalsTotal} (retiros/gastos)`);
  if (refundsTotal > 0) formulaParts.push(`- ${refundsTotal} (devoluciones efectivo)`);

  return jsonResponse(res, 200, {
    sessionId: session.id,
    cashRegisterId: session.cash_register_id,
    cashRegisterName: session.cash_register_name,
    cashRegisterCode: session.cash_register_code,
    employeeName: session.employee_name,
    openingTime: session.opening_time,
    initialAmount: session.initial_amount,
    blindCountEnabled: false,
    discrepancyThreshold: null,
    suggestedFloatForNext: 0,
    salesByPaymentMethod: salesByMethod,
    totalSales,
    cashSales,
    nonCashSales: totalSales - cashSales,
    injectionsTotal,
    withdrawalsTotal,
    refundsTotal,
    expectedAmountInCash: expectedInCash,
    expectedFormula: formulaParts.join(' '),
  });
};

handlers['GET /cash-sessions/history'] = async (req, res, body, route, query) => {
  const db = getDb();
  const page = parseInt(query.page || '0');
  const size = parseInt(query.size || '20');
  const offset = page * size;

  const totalRow = db.get('SELECT COUNT(*) as cnt FROM cash_sessions');
  const sessions = db.all(
    'SELECT * FROM cash_sessions ORDER BY opening_time DESC LIMIT ? OFFSET ?',
    [size, offset]
  );

  return jsonResponse(res, 200, {
    content: sessions.map((s) => sessionToDto(s)),
    totalElements: totalRow?.cnt || 0,
    totalPages: Math.ceil((totalRow?.cnt || 0) / size),
    number: page,
    size,
  });
};

handlers['GET /cash-sessions/:id/sales'] = async (req, res, body, route, query, pathParams) => {
  const db = getDb();
  let sessionId = pathParams.id;

  if (sessionId === 'current') {
    const current = getScopedOpenCashSession(db);
    sessionId = current ? current.id : -1;
  } else {
    sessionId = getOwnedCashSessionByAnyId(db, sessionId)?.id ?? -1;
  }

  const sales = db.all(
    'SELECT s.*, sp.payment_method FROM sales s LEFT JOIN sale_payments sp ON sp.sale_local_id = s.local_id WHERE s.cash_session_id = ? ORDER BY s.created_at DESC',
    [sessionId]
  );

  const result = sales.map((s) => ({
    id: s.cloud_id || s.local_id,
    createdAt: s.sale_date,
    paymentMethod: s.payment_method || 'EFECTIVO',
    total: s.total_amount,
    totalAmount: s.total_amount,
    ticketNumber: null,
    customerName: null,
    fecha: s.sale_date,
    isMixedPayment: false,
  }));

  return jsonResponse(res, 200, result);
};

handlers['GET /cash-sessions/:id/returns'] = async (req, res, body, route, query, pathParams) => {
  const db = getDb();
  let sessionId = pathParams.id;

  if (sessionId === 'current') {
    const current = getScopedOpenCashSession(db);
    sessionId = current ? current.id : -1;
  } else {
    sessionId = getOwnedCashSessionByAnyId(db, sessionId)?.id ?? -1;
  }

  const returns = db.all(
    'SELECT * FROM returns WHERE cash_session_id = ? ORDER BY created_at DESC',
    [sessionId]
  );

  const result = returns.map((r) => {
    const items = db.all('SELECT * FROM return_items WHERE return_local_id = ?', [r.local_id]);
    return {
      id: r.cloud_id || r.local_id,
      saleId: r.sale_cloud_id || r.sale_local_id,
      returnDate: r.return_date,
      reason: r.reason,
      refundMethod: r.refund_method,
      totalRefundAmount: r.total_refund_amount,
      employeeName: r.employee_name,
      items: items.map((i) => ({
        productId: i.product_id,
        productName: i.product_name,
        quantity: i.quantity,
        unitPrice: i.unit_price,
      })),
    };
  });

  return jsonResponse(res, 200, result);
};

handlers['GET /cash-sessions/:id/expenses'] = async (req, res, body, route, query, pathParams) => {
  const db = getDb();
  let sessionId = pathParams.id;

  if (sessionId === 'current') {
    const current = getScopedOpenCashSession(db);
    sessionId = current ? current.id : -1;
  } else {
    sessionId = getOwnedCashSessionByAnyId(db, sessionId)?.id ?? -1;
  }

  const movements = db.all(
    'SELECT * FROM cash_movements WHERE cash_session_id = ? ORDER BY created_at DESC',
    [sessionId]
  );

  const result = movements.map((m) => ({
    id: m.cloud_id || m.local_id,
    type: m.type,
    scope: m.scope,
    amount: m.amount,
    description: m.description,
    employeeName: m.employee_name,
    movementDate: m.movement_date,
  }));

  return jsonResponse(res, 200, result);
};

// ─── PROMOTIONS ──────────────────────────────────────────

handlers['POST /promotions/apply'] = async (req, res, body) => {
  // No promotions offline — return original totals
  const originalSubtotal = (body.items || []).reduce(
    (sum, i) => sum + (i.quantity || 0) * (i.unitPrice || 0), 0
  );
  return jsonResponse(res, 200, {
    originalSubtotal,
    totalDiscount: 0,
    finalTotal: originalSubtotal,
    appliedPromotions: [],
  });
};

// ─── RETURNS ─────────────────────────────────────────────

handlers['POST /returns'] = async (req, res, body, route) => {
  const db = getDb();
  if (blockIfSessionRevoked(db, res)) return; // A02
  const localClientId = Number(getConfigVal(db, 'client_id')) || null;
  const localSucursalId = Number(getConfigVal(db, 'sucursal_id')) || null;
  if ((localClientId != null && Number(route.clientId) !== localClientId)
      || (localSucursalId != null && Number(route.sucursalId) !== localSucursalId)) {
    return jsonResponse(res, 403, { error: 'Ruta no permitida desde el POS.' });
  }
  const {
    saleId, reason, refundMethod = 'CASH', // B01: 'CASH' canónico (enum RefundMethod del backend)
    clientReturnUuid: requestedClientReturnUuid,
    items = [],
  } = body;

  if (!saleId || items.length === 0) {
    return jsonResponse(res, 400, { error: 'Se requiere saleId y al menos un ítem.' });
  }

  // Find original sale (by cloud_id or local_id)
  let sale = findLocalSaleByPublicId(db, saleId);
  if (sale && ((sale.client_id != null && localClientId != null && Number(sale.client_id) !== localClientId)
      || (sale.sucursal_id != null && localSucursalId != null && Number(sale.sucursal_id) !== localSucursalId))) {
    sale = null;
  }
  if (!sale) {
    // Una venta hecha en otro puesto no existe en este SQLite. Con conexión, completar la
    // devolución directamente en la nube; sin conexión no hay datos suficientes para validarla.
    if (apiClient.token) {
      try {
        const cloudReturn = await apiClient.createReturn({
          ...body,
          reason: reason?.trim() || 'Devolución desde POS',
          refundMethod,
          clientReturnUuid: requestedClientReturnUuid || crypto.randomUUID(),
        });
        return jsonResponse(res, 201, cloudReturn);
      } catch (err) {
        const cloudError = parseCloudHttpError(err);
        if (cloudError) return jsonResponse(res, cloudError.status, { error: cloudError.message });
        return jsonResponse(res, 503, {
          error: 'La venta no está guardada en este POS y no se pudo registrar la devolución en la nube.',
          offline: true,
        });
      }
    }
    return jsonResponse(res, 404, { error: 'Venta no encontrada en este POS.' });
  }

  // Validate items & calculate total refund
  const saleItems = db.all('SELECT * FROM sale_items WHERE sale_local_id = ?', [sale.local_id]);

  // R7-#18: cuánto se devolvió YA de cada sale_item en devoluciones previas (offline) de ESTA
  // venta. Sin esto, validábamos contra la cantidad ORIGINAL vendida e ignorábamos las
  // devoluciones parciales anteriores: vender 3, devolver 2 y devolver 2 otra vez pasaba la
  // validación → reembolso que excede la venta + stock inflado por encima de lo vendido.
  const priorRows = db.all(`
    SELECT ri.sale_item_id AS sid, SUM(ri.quantity) AS qty
      FROM return_items ri
      JOIN returns r ON r.local_id = ri.return_local_id
     WHERE r.sale_local_id = ?
     GROUP BY ri.sale_item_id
  `, [sale.local_id]);
  const alreadyReturned = new Map(priorRows.map((row) => [row.sid, row.qty || 0]));

  let totalRefund = 0;
  const validatedItems = [];

  for (const ri of items) {
    const si = saleItems.find(
      (s) => s.id === ri.saleItemId || s.product_id === ri.productId
    );
    if (!si) {
      return jsonResponse(res, 400, { error: `Ítem de venta no encontrado: ${ri.saleItemId || ri.productId}` });
    }
    const qty = ri.quantity || 1;
    // Cantidad ya devuelta de este sale_item (devoluciones previas + lo acumulado en ESTE request,
    // por si el mismo ítem viene repetido en `items`).
    const prevReturned = alreadyReturned.get(si.id) || 0;
    const remaining = si.quantity - prevReturned;
    if (qty > remaining) {
      return jsonResponse(res, 400, { error: `Cantidad a devolver (${qty}) excede cantidad disponible (${remaining}) para ${si.product_name}` });
    }
    alreadyReturned.set(si.id, prevReturned + qty);
    const unitPrice = si.unit_price;
    totalRefund += qty * unitPrice;
    validatedItems.push({ saleItemId: si.id, productId: si.product_id, productName: si.product_name, productCode: si.product_code, quantity: qty, unitPrice });
  }
  totalRefund = round2(totalRefund); // B10

  // Get current open cash session
  const currentSession = getScopedOpenCashSession(db);

  const employeeId = Number(getConfigVal(db, 'employee_id'));
  const employeeName = getConfigVal(db, 'employee_name') || '';
  const now = businessNowIso(); // C05: hora de negocio (Argentina)

  // Clave de idempotencia (C01): se persiste y el sync la reenvía en cada reintento.
  const clientReturnUuid = requestedClientReturnUuid || crypto.randomUUID();

  // P1-01: devolución + ítems + restauración de stock + ajuste de caja, atómicos.
  let returnLocalId;
  db.transaction(() => {
  const result = db.run(`
    INSERT INTO returns (client_return_uuid, sale_local_id, sale_cloud_id, return_date, reason,
      refund_method, total_refund_amount, employee_id, employee_name,
      cash_session_id, client_id, sucursal_id, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `, [
    clientReturnUuid,
    sale.local_id, sale.cloud_id || null, now, reason || null,
    refundMethod, totalRefund, employeeId, employeeName,
    currentSession ? currentSession.id : null,
    Number(getConfigVal(db, 'client_id')) || null, Number(getConfigVal(db, 'sucursal_id')) || null, // R4-#40
  ]);

  returnLocalId = result.lastId;

  for (const vi of validatedItems) {
    db.run(`
      INSERT INTO return_items (return_local_id, sale_item_id, product_id,
        product_name, product_code, quantity, unit_price)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [returnLocalId, vi.saleItemId, vi.productId, vi.productName, vi.productCode, vi.quantity, vi.unitPrice]);

    // Restore stock. Simétrico al descuento de la venta: a un pesable nunca se le descontó, así que
    // reintegrarlo acá inflaría el stock local en cada devolución.
    db.run(
      'UPDATE products SET quantity = quantity + ? WHERE id = ? AND no_code = 0 AND weighable = 0',
      [vi.quantity, vi.productId]
    );
  }

  // Update cash session expected amount (subtract refund if cash)
  // B01: el reembolso en efectivo es 'CASH' (no 'EFECTIVO') → así sí se descuenta del esperado.
  if (currentSession && refundMethod === 'CASH') {
    db.run(
      'UPDATE cash_sessions SET expected_amount = expected_amount - ? WHERE id = ?',
      [totalRefund, currentSession.id]
    );
  }
  }); // transaction() commits + persists to disk synchronously

  return jsonResponse(res, 201, {
    id: returnLocalId,
    saleReturnId: returnLocalId,
    saleId: sale.cloud_id || sale.local_id,
    returnDate: now,
    returnedAt: now,
    reason: reason || null,
    refundMethod,
    totalRefundAmount: totalRefund,
    totalRefund,
    employeeId,
    employeeName,
    processedByName: employeeName,
    cashSessionId: currentSession ? currentSession.id : null,
    offlineCreated: true,
    fiscalDocument: {
      required: true,
      status: 'PENDING_SYNC',
      invoiceId: null,
      type: null,
      number: null,
      cae: null,
      caeExpiration: null,
      updatedAt: now,
      message: 'Se evaluará la Nota de Crédito cuando la devolución se sincronice con la nube.',
      retryable: false,
    },
    items: validatedItems.map((vi) => ({
      productId: vi.productId,
      productName: vi.productName,
      quantity: vi.quantity,
      unitPrice: vi.unitPrice,
    })),
  });
};

handlers['GET /returns'] = async (req, res, body, route, query) => {
  const db = getDb();
  let sql = 'SELECT * FROM returns WHERE 1=1';
  const params = [];

  if (query.saleId) {
    sql += ' AND (sale_cloud_id = ? OR sale_local_id = ?)';
    params.push(query.saleId, query.saleId);
  }
  if (query.from) {
    sql += ' AND return_date >= ?';
    params.push(query.from);
  }
  if (query.to) {
    sql += ' AND return_date <= ?';
    params.push(query.to + 'T23:59:59');
  }

  sql += ' ORDER BY created_at DESC LIMIT 100';
  const returns = db.all(sql, params);

  const result = returns.map((r) => {
    const items = db.all('SELECT * FROM return_items WHERE return_local_id = ?', [r.local_id]);
    return {
      id: r.cloud_id || r.local_id,
      saleReturnId: r.cloud_id || r.local_id,
      saleId: r.sale_cloud_id || r.sale_local_id,
      returnDate: r.return_date,
      returnedAt: r.return_date,
      reason: r.reason,
      refundMethod: r.refund_method,
      totalRefundAmount: r.total_refund_amount,
      totalRefund: r.total_refund_amount,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      processedByName: r.employee_name,
      cashSessionId: r.cash_session_id,
      fiscalDocument: {
        required: r.fiscal_status !== 'NOT_REQUIRED',
        status: r.fiscal_status || (r.sync_status === 'synced' ? 'FAILED' : 'PENDING_SYNC'),
        invoiceId: r.fiscal_invoice_id || null,
        type: r.fiscal_type || null,
        number: r.fiscal_number || null,
        cae: r.fiscal_cae || null,
        caeExpiration: r.fiscal_cae_expiration || null,
        updatedAt: r.fiscal_updated_at || null,
        message: r.fiscal_message || (r.sync_status === 'synced'
          ? 'Sin información fiscal devuelta por la nube.'
          : 'Pendiente de sincronizar con la nube.'),
        retryable: Boolean(r.fiscal_retryable),
      },
      items: items.map((i) => ({
        productId: i.product_id,
        productName: i.product_name,
        quantity: i.quantity,
        unitPrice: i.unit_price,
      })),
    };
  });

  return jsonResponse(res, 200, result);
};

handlers['POST /returns/:id/fiscal-document/retry'] = async (req, res, body, route, query, pathParams) => {
  if (!isAdminOrOwner()) {
    return jsonResponse(res, 403, { error: 'Solo propietarios y administradores pueden reintentar documentos fiscales.' });
  }
  try {
    const result = await apiClient.retryReturnFiscalDocument(pathParams.id);
    const fiscal = result.fiscalDocument || {};
    const db = getDb();
    db.run(`
      UPDATE returns
         SET fiscal_status = ?, fiscal_message = ?, fiscal_invoice_id = ?, fiscal_type = ?,
             fiscal_number = ?, fiscal_cae = ?, fiscal_cae_expiration = ?,
             fiscal_updated_at = ?, fiscal_retryable = ?
       WHERE cloud_id = ?
    `, [
      fiscal.status || 'FAILED',
      fiscal.message || 'La nube no devolvió información fiscal para esta devolución.',
      fiscal.invoiceId || null,
      fiscal.type || null,
      fiscal.number || null,
      fiscal.cae || null,
      fiscal.caeExpiration || null,
      fiscal.updatedAt || null,
      fiscal.retryable ? 1 : 0,
      Number(pathParams.id),
    ]);
    db.save();
    return jsonResponse(res, 200, result);
  } catch (err) {
    const cloudError = parseCloudHttpError(err);
    return jsonResponse(res, cloudError?.status || 503, {
      error: cloudError?.message || 'No se pudo reintentar la Nota de Crédito en la nube.',
    });
  }
};

// ─── CASH MOVEMENTS (expenses, injections, withdrawals) ─

handlers['POST /expenses'] = async (req, res, body) => {
  const db = getDb();
  if (blockIfSessionRevoked(db, res)) return; // A02
  const {
    type = 'EXPENSE', scope = 'SESSION',
    amount, description, note,
    expenseCategoryId, categoryRef,
  } = body;

  if (!amount || amount <= 0) {
    return jsonResponse(res, 400, { error: 'El monto debe ser mayor a cero.' });
  }

  // R4-#62: validar scope contra el enum del backend (SESSION/BRANCH). Un scope arbitrario hacía que
  // Jackson fallara la deserialización con 400 al sincronizar → el movimiento quedaba en needs_review.
  if (scope !== 'SESSION' && scope !== 'BRANCH') {
    return jsonResponse(res, 400, { error: "scope inválido (debe ser 'SESSION' o 'BRANCH')." });
  }

  // C04/B09: aceptar `note` (nombre canónico del backend) o `description` (legacy); y resolver la
  // categoría de gasto. El front manda `categoryRef`: numérico = id de categoría (para EXPENSE),
  // o `SYS::...` para inyección/retiro/ajuste (sin categoría). Persistimos ambos para el sync.
  const movementNote = (note !== undefined && note !== null) ? note : (description || null);
  let categoryId = null;
  if (expenseCategoryId != null && !Number.isNaN(Number(expenseCategoryId))) {
    categoryId = Number(expenseCategoryId);
  } else if (categoryRef != null && /^\d+$/.test(String(categoryRef))) {
    categoryId = Number(categoryRef);
  }

  const validTypes = ['INJECTION', 'WITHDRAWAL', 'ADJUSTMENT', 'EXPENSE'];
  if (!validTypes.includes(type)) {
    return jsonResponse(res, 400, { error: `Tipo inválido. Valores permitidos: ${validTypes.join(', ')}` });
  }

  const currentSession = getScopedOpenCashSession(db);

  const employeeId = Number(getConfigVal(db, 'employee_id'));
  const employeeName = getConfigVal(db, 'employee_name') || '';
  const now = businessNowIso(); // C05: hora de negocio (Argentina)

  // Clave de idempotencia (C01/C04): se persiste y el sync la reenvía en cada reintento.
  const clientMovementUuid = crypto.randomUUID();

  const result = db.run(`
    INSERT INTO cash_movements (client_movement_uuid, type, scope, amount, description,
      expense_category_id, employee_id, employee_name, cash_session_id, movement_date, client_id, sucursal_id, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `, [
    clientMovementUuid,
    type, scope, Number(amount), movementNote,
    categoryId,
    employeeId, employeeName,
    currentSession ? currentSession.id : null, now,
    Number(getConfigVal(db, 'client_id')) || null, Number(getConfigVal(db, 'sucursal_id')) || null, // R4-#40
  ]);

  // Update cash session expected amount
  if (currentSession && scope === 'SESSION') {
    if (type === 'INJECTION') {
      db.run(
        'UPDATE cash_sessions SET expected_amount = expected_amount + ? WHERE id = ?',
        [Number(amount), currentSession.id]
      );
    } else if (type === 'WITHDRAWAL' || type === 'EXPENSE') {
      db.run(
        'UPDATE cash_sessions SET expected_amount = expected_amount - ? WHERE id = ?',
        [Number(amount), currentSession.id]
      );
    }
  }

  db.save();

  return jsonResponse(res, 201, {
    id: result.lastId,
    type,
    scope,
    amount: Number(amount),
    description: movementNote,
    note: movementNote,
    expenseCategoryId: categoryId,
    employeeId,
    employeeName,
    cashSessionId: currentSession ? currentSession.id : null,
    movementDate: now,
    createdAt: now,
    offlineCreated: true,
  });
};

handlers['POST /cash-movements'] = handlers['POST /expenses'];

handlers['GET /expenses'] = async (req, res, body, route, query) => {
  const db = getDb();
  let sql = 'SELECT * FROM cash_movements WHERE 1=1';
  const params = [];

  if (query.sessionId) {
    sql += ' AND cash_session_id = ?';
    params.push(query.sessionId);
  }
  if (query.type) {
    sql += ' AND type = ?';
    params.push(query.type);
  }
  if (query.from) {
    sql += ' AND movement_date >= ?';
    params.push(query.from);
  }
  if (query.to) {
    sql += ' AND movement_date <= ?';
    params.push(query.to + 'T23:59:59');
  }

  sql += ' ORDER BY created_at DESC LIMIT 100';
  const movements = db.all(sql, params);

  const result = movements.map((m) => ({
    id: m.cloud_id || m.local_id,
    type: m.type,
    scope: m.scope,
    amount: m.amount,
    description: m.description,
    employeeId: m.employee_id,
    employeeName: m.employee_name,
    cashSessionId: m.cash_session_id,
    movementDate: m.movement_date,
  }));

  return jsonResponse(res, 200, result);
};

handlers['GET /cash-movements'] = handlers['GET /expenses'];

// ─── DAILY CLOSE (stub) ─────────────────────────────────

handlers['GET /daily-close/preview'] = async (req, res) => {
  return jsonResponse(res, 200, { readyToClose: false, openSessionsRemaining: 0 });
};

// ─── MERCADOPAGO (stub — requires online) ───────────────

handlers['GET /api/mercadopago-point'] = async (req, res) => {
  return jsonResponse(res, 503, { error: 'MercadoPago Point requiere conexión a internet.' });
};

// ── Session DTO helper ───────────────────────────────────

function sessionToDto(s, salesByMethod, totalSales) {
  return {
    id: s.cloud_id || s.id,
    clientId: s.client_id,
    sucursalId: s.sucursal_id,
    employeeId: s.employee_id,
    employeeName: s.employee_name,
    status: s.status,
    businessDate: s.business_date,
    openingTime: s.opening_time,
    closingTime: s.closing_time || null,
    initialAmount: s.initial_amount || 0,
    expectedAmount: s.expected_amount || 0,
    countedAmount: s.counted_amount || null,
    difference: s.difference || null,
    cashRegisterId: s.cash_register_id || null,
    cashRegisterName: s.cash_register_name || null,
    cashRegisterCode: s.cash_register_code || null,
    salesByPaymentMethod: salesByMethod || {},
    totalSales: totalSales || 0,
    closingNote: s.closing_note || null,
    floatLeftForNext: s.float_left_for_next || null,
  };
}

// ── Request Router ───────────────────────────────────────

function routeRequest(method, pathname, route) {
  const subpath = route.subpath;

  // Auth routes (top-level, not branch-scoped)
  const authKey = `${method} ${pathname.split('?')[0]}`;
  if (handlers[authKey]) return { handler: handlers[authKey], params: {} };

  // Branch-scoped routes — match static routes first
  const staticKey = `${method} ${subpath.split('?')[0]}`;
  if (handlers[staticKey]) return { handler: handlers[staticKey], params: {} };

  // Pattern matching for routes with :id parameters
  const cleanSubpath = subpath.split('?')[0];

  // /items/:id
  const itemMatch = cleanSubpath.match(/^\/items\/(\d+)$/);
  if (itemMatch && method === 'GET') {
    return { handler: handlers['GET /items/:id'], params: { id: Number(itemMatch[1]) } };
  }

  // /sales/:id (búsqueda previa a una devolución)
  const saleMatch = cleanSubpath.match(/^\/sales\/(\d+)$/);
  if (saleMatch && method === 'GET') {
    return { handler: handlers['GET /sales/:id'], params: { id: Number(saleMatch[1]) } };
  }

  // /cash-sessions/:id/close-preview
  const closePreviewMatch = cleanSubpath.match(/^\/cash-sessions\/([^/]+)\/close-preview$/);
  if (closePreviewMatch && method === 'GET') {
    return { handler: handlers['GET /cash-sessions/:id/close-preview'], params: { id: closePreviewMatch[1] } };
  }

  // /cash-sessions/:id/close-with-tracking
  const closeTrackingMatch = cleanSubpath.match(/^\/cash-sessions\/([^/]+)\/close-with-tracking$/);
  if (closeTrackingMatch && method === 'POST') {
    return { handler: handlers['POST /cash-sessions/:id/close-with-tracking'], params: { id: closeTrackingMatch[1] } };
  }

  // /cash-sessions/:id/sales
  const sessionSalesMatch = cleanSubpath.match(/^\/cash-sessions\/([^/]+)\/sales$/);
  if (sessionSalesMatch && method === 'GET') {
    return { handler: handlers['GET /cash-sessions/:id/sales'], params: { id: sessionSalesMatch[1] } };
  }

  // /cash-sessions/:id/returns
  const sessionReturnsMatch = cleanSubpath.match(/^\/cash-sessions\/([^/]+)\/returns$/);
  if (sessionReturnsMatch && method === 'GET') {
    return { handler: handlers['GET /cash-sessions/:id/returns'], params: { id: sessionReturnsMatch[1] } };
  }

  const returnFiscalRetryMatch = cleanSubpath.match(/^\/returns\/(\d+)\/fiscal-document\/retry$/);
  if (returnFiscalRetryMatch && method === 'POST') {
    return {
      handler: handlers['POST /returns/:id/fiscal-document/retry'],
      params: { id: Number(returnFiscalRetryMatch[1]) },
    };
  }

  // /cash-sessions/:id/expenses
  const sessionExpensesMatch = cleanSubpath.match(/^\/cash-sessions\/([^/]+)\/expenses$/);
  if (sessionExpensesMatch && method === 'GET') {
    return { handler: handlers['GET /cash-sessions/:id/expenses'], params: { id: sessionExpensesMatch[1] } };
  }

  // MercadoPago top-level routes
  if (pathname.includes('/mercadopago-point')) {
    return { handler: handlers['GET /api/mercadopago-point'], params: {} };
  }

  return null;
}

// ── Start / Stop server ──────────────────────────────────

function startLocalServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      // R4-#18: decodeURIComponent puede lanzar URIError ante un % malformado en la URL; sin try/catch
      // eso tumbaba el handler de la request. Defensivo.
      let pathname;
      try {
        pathname = decodeURIComponent(req.url.split('?')[0]);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
        return res.end('Bad request');
      }

      const isApi = pathname.startsWith('/api/');

      // R4-#12/#46: bloquear /api/* desde un origen web externo (CSRF/DNS-rebinding desde una pestaña del
      // navegador del cajero). El renderer (sin Origin de navegador / origen confiable) pasa.
      if (isApi && !isAllowedApiOrigin(req.headers.origin)) {
        return jsonResponse(res, 403, { error: 'Origen no autorizado.' });
      }

      // R6-#44: endurecer el gate para mutaciones locales (ventas/devoluciones/caja/gastos).
      // (a) file:// rechazado: una página HTML del disco tiene el mismo acceso de red que una web
      //     externa; no debe poder operar la caja aunque el server sea loopback.
      // (b) Token de sesión requerido: cualquier proceso local (script, curl, etc.) que no haya
      //     pasado por el login no tiene el token en app_config y queda bloqueado con 401.
      const isMutation = isApi && (req.method === 'POST' || req.method === 'PUT'
        || req.method === 'PATCH' || req.method === 'DELETE');
      if (isMutation) {
        if (!isAllowedMutationOrigin(req.headers.origin)) {
          return jsonResponse(res, 403, { error: 'Origen no autorizado para esta operación.' });
        }
        // These public auth steps run before a token exists.
        const mutationPath = decodeURIComponent(req.url.split('?')[0]);
        const isPublicAuthEndpoint = mutationPath === '/api/auth/login'
          || mutationPath === '/api/auth/logout'
          || mutationPath === '/api/auth/verify-device'
          || mutationPath === '/api/auth/resend-verification-code';
        if (!isPublicAuthEndpoint) {
          try {
            if (blockIfNoSessionToken(getDb(), res)) return;
          } catch (_) {
            return jsonResponse(res, 401, { error: 'No hay sesión activa.' });
          }
        }
      }

      // R8-#33: los GET de datos de negocio (/items, /sales, /cash-sessions/*, /registers,
      // /returns, /expenses) también requieren sesión activa. Cualquier proceso local sin token
      // (curl, malware, XSS de página local) podía leer catálogo con costos, totales de caja,
      // PII de ventas, etc. sin autenticación. Excluimos sólo /api/auth/* y session-status.
      if (isApi && req.method === 'GET') {
        const getPath = decodeURIComponent(req.url.split('?')[0]);
        const isAuthGet = getPath === '/api/auth/me'
          || getPath === '/api/auth/session-status'
          || getPath.startsWith('/api/auth/');
        if (!isAuthGet) {
          try {
            if (blockIfNoSessionToken(getDb(), res)) return;
          } catch (_) {
            return jsonResponse(res, 401, { error: 'No hay sesión activa.' });
          }
        }
      }

      // Handle CORS preflight (sin ACAO:* — solo se refleja un origen confiable)
      if (req.method === 'OPTIONS') {
        const origin = req.headers.origin;
        const headers = {
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        };
        if (origin && isAllowedApiOrigin(origin)) {
          headers['Access-Control-Allow-Origin'] = origin;
          headers['Vary'] = 'Origin';
        }
        res.writeHead(200, headers);
        return res.end();
      }

      // Non-API requests → serve static web files from resources/web
      if (!isApi) {
        return serveStaticFile(pathname, res);
      }

      try {
        const query = parseQuery(req.url);
        const route = parseRoute(req.url);
        const subpath = route.subpath.split('?')[0];

        // Excepción binaria acotada: preservar el multipart y su boundary hacia la nube.
        const isProductImageRoute = /^\/items\/\d+\/image$/.test(subpath);
        if (isProductImageRoute && (req.method === 'PUT' || req.method === 'DELETE')) {
          if (!canManageInventory()) {
            return jsonResponse(res, 403, { error: 'No tenés permisos para modificar imágenes de productos.' });
          }
          if (req.method === 'DELETE') {
            return await proxyToCloud(req, res, req.method, req.url, {});
          }
          if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data;')) {
            return jsonResponse(res, 415, { error: 'La imagen debe enviarse como multipart/form-data.' });
          }
          const rawImageBody = await parseRawBody(req, IMAGE_UPLOAD_BODY_MAX_BYTES);
          if (rawImageBody === null) {
            return jsonResponse(res, 413, { error: 'La imagen optimizada supera el límite permitido de 2 MB.' });
          }
          return await proxyToCloud(req, res, req.method, req.url, rawImageBody, { rawBody: true });
        }

        // ── Local product images (cached offline) ──────────
        const localImageMatch = subpath.match(/^\/api\/local-product-images\/(\d+)\/(image|thumbnail)$/);
        if (localImageMatch && req.method === 'GET') {
          imageCache.serveRequest(req, res, Number(localImageMatch[1]), localImageMatch[2]);
          return;
        }

        // Development object storage: CloudFront serves these immutable public objects in prod.
        // Proxy them for every POS role so a cache miss can still render while the offline cache fills.
        if (req.method === 'GET' && /^\/api\/local-product-images\/product-images\/\d+\/\d+\/\d+\/[0-9a-f-]+\/(full|thumb)\.jpg$/i.test(pathname)) {
          return await proxyToCloud(req, res, req.method, req.url, {}, { rawResponse: true });
        }

        let body;
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          body = await parseBody(req);
          // R8-#95: null significa que el body excedió el límite — responder 413.
          if (body === null) {
            return jsonResponse(res, 413, { error: 'Cuerpo de la solicitud demasiado grande (máx. 1 MB).' });
          }
        } else {
          body = {};
        }

        // ── Role-based routing ────────────────────────────
        // Cloud-only routes (dashboard, reports, finance, employees, etc.)
        // Admin/Owner → proxy to cloud
        // Cajero/Inventario → 403 blocked
        if (route.clientId && isCloudOnlyRoute(subpath)) {
          if (isAdminOrOwner()) {
            const fullUrl = req.url; // preserve original URL with query params
            return await proxyToCloud(req, res, req.method, fullUrl, body);
          }
          return jsonResponse(res, 403, {
            error: 'Esta función no está disponible para tu rol en modo local.',
          });
        }

        // ── Multi-branch inventory search (always cloud, any role) ──
        if (subpath === '/inventory/all-branches' || subpath === '/products/all-branches') {
          const fullUrl = req.url;
          return await proxyToCloud(req, res, req.method, fullUrl, body);
        }

        // ── Product creation: block cajero ──
        if (subpath === '/items' && req.method === 'POST') {
          if (!canManageInventory()) {
            return jsonResponse(res, 403, {
              error: 'No tienes permisos para crear productos.',
            });
          }
        }

        const match = routeRequest(req.method, pathname, route);

        if (match) {
          await match.handler(req, res, body, route, query, match.params);
        } else if (isAdminOrOwner()) {
          // R4-#34: el fallback proxea rutas no manejadas a la nube con el token del dueño (confused
          // deputy). Acotamos con un denylist: el POS NUNCA debe alcanzar el super-admin/admin global de
          // plataforma ni el panel de OTRO cliente. Las rutas legítimas del propio cliente siguen pasando.
          const lp = pathname.toLowerCase();
          const ownClientId = getConfigVal(getDb(), 'client_id');
          const denied = lp.startsWith('/api/super-admin') || lp.startsWith('/api/superpanel') || lp.startsWith('/api/admin/')
            || (route.clientId != null && ownClientId != null && String(route.clientId) !== String(ownClientId));
          if (denied) {
            console.warn(`[LOCAL-API] Proxy bloqueado (R4-#34): ${req.method} ${pathname}`);
            return jsonResponse(res, 403, { error: 'Ruta no permitida desde el POS.' });
          }
          // Admin/Owner fallback: proxy unhandled routes to cloud
          const fullUrl = req.url;
          return await proxyToCloud(req, res, req.method, fullUrl, body);
        } else {
          console.log(`[LOCAL-API] Unhandled: ${req.method} ${pathname}`);
          jsonResponse(res, 404, {
            error: `Endpoint no disponible en modo offline: ${req.method} ${pathname}`,
          });
        }
      } catch (err) {
        console.error('[LOCAL-API] Error:', err);
        jsonResponse(res, 500, { error: err.message });
      }
    });

    // Listen on a random available port
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      console.log(`[LOCAL-API] Offline API server running on http://127.0.0.1:${serverPort}`);
      resolve(serverPort);
    });

    server.on('error', reject);
  });
}

function stopLocalServer() {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        console.log('[LOCAL-API] Server stopped');
        resolve();
      });
    } else {
      resolve();
    }
  });
}

function getServerPort() {
  return serverPort;
}

module.exports = { startLocalServer, stopLocalServer, getServerPort, loginEvents };
