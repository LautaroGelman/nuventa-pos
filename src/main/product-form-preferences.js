// Branch-scoped preferences and an independent, durable metadata queue.
function keys(clientId, branchId) {
  return { value: `product_form_preferences:${clientId}:${branchId}`, pending: `product_form_preferences_pending:${clientId}:${branchId}` };
}
function read(db, key, fallback) {
  try { return JSON.parse(db.get('SELECT value FROM app_config WHERE key=?', [key])?.value || 'null') || fallback; }
  catch { return fallback; }
}
function getPreferences(db, clientId, branchId) {
  const key = keys(clientId, branchId);
  return { wholesaleEnabled: false, photoEnabled: false, ...read(db, key.value, {}), ...read(db, key.pending, {}).patch };
}
function patchPreferences(db, clientId, branchId, patch) {
  const key = keys(clientId, branchId);
  const pending = read(db, key.pending, {});
  const next = { revision: require('crypto').randomUUID(), patch: { ...pending.patch, ...patch } };
  db.run('INSERT OR REPLACE INTO app_config(key,value) VALUES (?,?)', [key.pending, JSON.stringify(next)]);
  db.save();
  return getPreferences(db, clientId, branchId);
}
const inFlight = new Map();
async function syncPreferences(db, api, clientId, branchId) {
  const key = keys(clientId, branchId);
  if (inFlight.has(key.value)) return inFlight.get(key.value);
  const epoch = api.authEpoch;
  const task = (async () => {
    const pending = read(db, key.pending, {});
    const url = `${api.baseUrl}/api/client-panel/${clientId}/sucursales/${branchId}/product-form-preferences`;
    const data = pending.patch ? await api._fetch(url, { method: 'PATCH', body: JSON.stringify(pending.patch) }) : await api._fetch(url);
    if (epoch !== api.authEpoch) return;
    db.run('INSERT OR REPLACE INTO app_config(key,value) VALUES (?,?)', [key.value, JSON.stringify(data)]);
    if (pending.revision && read(db, key.pending, {}).revision === pending.revision)
      db.run('DELETE FROM app_config WHERE key=?', [key.pending]);
    db.save();
  })();
  inFlight.set(key.value, task);
  try { await task; } finally { inFlight.delete(key.value); }
}
module.exports = { getPreferences, patchPreferences, syncPreferences };
