// Business-wide presentation preferences. No offline writes and no business outbox.
'use strict';
const DEFAULTS = Object.freeze({ showFinancialAgenda: true, showRecurringExpenses: true, showPayroll: true });
const queues = new Map();
const keyFor = clientId => `business_ui_preferences:${clientId}`;
function error(status, message) { return Object.assign(new Error(message), { status }); }
function getPreferences(db, clientId) {
  try { return { ...DEFAULTS, ...JSON.parse(db.get('SELECT value FROM app_config WHERE key=?', [keyFor(clientId)])?.value || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function validate(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || Object.keys(patch).some(key => !Object.hasOwn(DEFAULTS, key) || typeof patch[key] !== 'boolean'))
    throw error(400, 'Preferencias inválidas');
}
function syncPreferences(db, api, clientId, patch) {
  if (patch !== undefined) validate(patch);
  const epoch = api.authEpoch;
  const queueKey = `${clientId}:${epoch}`;
  const checkIdentity = () => {
    if (epoch !== api.authEpoch || Number(api.clientId) !== Number(clientId))
      throw error(409, 'La sesión cambió. Volvé a abrir las preferencias.');
  };
  const task = (queues.get(queueKey) || Promise.resolve()).catch(() => undefined).then(async () => {
    checkIdentity();
    if (!api.token || require('./offline-session').isOfflineSession(api.token)) throw error(503, 'Para cambiar preferencias necesitás conexión.');
    let result;
    try {
      result = await api._fetch(`${api.baseUrl}/api/client-panel/${clientId}/ui-preferences`, patch === undefined ? {} : { method: 'PATCH', body: JSON.stringify(patch) });
    } catch (err) {
      checkIdentity();
      if (patch === undefined && err.status === 404) return getPreferences(db, clientId);
      throw err;
    }
    checkIdentity(); validate(result);
    const value = { ...DEFAULTS, ...result };
    db.run('INSERT OR REPLACE INTO app_config(key,value) VALUES (?,?)', [keyFor(clientId), JSON.stringify(value)]);
    db.save();
    return value;
  });
  queues.set(queueKey, task);
  void task.finally(() => { if (queues.get(queueKey) === task) queues.delete(queueKey); }).catch(() => undefined);
  return task;
}
module.exports = { DEFAULTS, getPreferences, syncPreferences, validate };
