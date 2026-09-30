// ============================================================
// Shared online stock policy. Metadata is durable and tenant/branch scoped.
// Offline sales cannot consume products known to be shared with Tiendanube.
// ============================================================
const { isOfflineSession } = require('./offline-session');
const key = (api) => `tiendanube:${Number(api.clientId)}:${Number(api.sucursalId)}`;
const failure = (message, status = 503) => Object.assign(new Error(message), { status });

function cached(db, api) {
  try { return JSON.parse(db.get('SELECT value FROM app_config WHERE key=?', [key(api)])?.value || 'null'); }
  catch { return null; }
}

async function refresh(db, api, { refreshReservations = false } = {}) {
  if (!api.token || isOfflineSession(api.token)) throw failure('Los productos de Tiendanube requieren iniciar sesión online.');
  const epoch = api.authEpoch; const scope = key(api);
  const response = await api._fetch(`${api._branchPath()}/pos-sync/tiendanube${refreshReservations ? '?refreshReservations=true' : ''}`);
  if (epoch !== api.authEpoch || scope !== key(api)) throw failure('La sucursal o sesión cambió. Reintentá la venta.', 409);
  if (!response || typeof response.active !== 'boolean' || !Array.isArray(response.linkedProductIds)
      || response.linkedProductIds.some(id => !Number.isSafeInteger(id) || id <= 0)
      || !response.availableStock || typeof response.availableStock !== 'object')
    throw failure('No se pudo verificar el stock compartido con Tiendanube.');
  const value = { ...response, checkedAt: Date.now() };
  db.run('INSERT OR REPLACE INTO app_config(key,value) VALUES (?,?)', [scope, JSON.stringify(value)]);
  db.save();
  return value;
}

async function prepareSale(db, api, items, flush) {
  if (!Array.isArray(items)) return;
  const quantities = new Map();
  for (const item of items) if (Number(item.productId) > 0)
    quantities.set(Number(item.productId), (quantities.get(Number(item.productId)) || 0) + Number(item.quantity));
  if (!quantities.size) return;
  let state = cached(db, api);
  // A first online verification is required after upgrade, before allowing stock sales offline.
  // Once a branch is known not to share stock it retains the ordinary offline policy.
  if (!state) state = await refresh(db, api);
  const shared = state.linkedProductIds.filter(id => quantities.has(id));
  if (!shared.length) return;
  if (!api.token || isOfflineSession(api.token))
    throw failure('Esta venta incluye productos publicados en Tiendanube. Conectate e iniciá sesión online antes de cobrar.');
  if (typeof flush !== 'function') throw failure('No se pudo sincronizar el stock online. Reintentá antes de cobrar.');
  const epoch = api.authEpoch;
  await flush();
  if (api.authEpoch !== epoch) throw failure('La sesión cambió durante la venta.', 409);
  // A failed upload must never be hidden by overwriting local stock with the cloud catalog.
  const pending = db.get(`SELECT 1 FROM sync_outbox WHERE client_id=? AND sucursal_id=? LIMIT 1`,
    [Number(api.clientId), Number(api.sucursalId)]);
  if (pending) throw failure('Quedan operaciones pendientes de sincronizar. Resolvelas antes de cobrar productos de Tiendanube.', 409);
  state = await refresh(db, api, { refreshReservations: true });
  for (const id of state.linkedProductIds) {
    if (!quantities.has(id)) continue;
    const available = state.availableStock[String(id)];
    if (available === null) continue;
    if (!Number.isFinite(available)) throw failure('No se pudo confirmar el stock disponible de un producto online.');
    if (quantities.get(id) > available)
      throw failure(`El producto ${id} tiene ${available} unidades disponibles: el resto está vendido o reservado en Tiendanube. Actualizá la venta antes de cobrar.`, 409);
  }
}

// Serializes checks and local commits so two renderer requests cannot reuse the same stock snapshot.
const salesInFlight = new Map();
async function exclusive(scope, operation) {
  const previous = salesInFlight.get(scope) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  salesInFlight.set(scope, next);
  await previous;
  try { return await operation(scope); }
  finally { release(); if (salesInFlight.get(scope) === next) salesInFlight.delete(scope); }
}

module.exports = { cached, refresh, prepareSale, exclusive };
