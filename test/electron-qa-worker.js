'use strict';
// CLI-only worker: no BrowserWindow, UI automation, installed profile or production endpoint.
const { app } = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const assert = require('node:assert/strict');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const qa = require('../src/main/qa-environment').initializeQaEnvironment(app);
assert.ok(qa, 'Explicit --dev --qa required');
const fixture = JSON.parse(fs.readFileSync(arg('--fixture'), 'utf8'));
const claims = JSON.parse(Buffer.from(fixture.token.split('.')[1], 'base64url'));
assert.equal(fixture.clientId, Number(process.env.NUVENTA_POS_QA_CLIENT_ID));
assert.ok(fixture.clientId > 1 || (process.argv.includes('--shared-stock') && fixture.clientId === 1),
  'The original demo requires the explicit coordinated shared-stock scenario');
assert.equal(Number(claims.clientId), fixture.clientId);
assert.equal(Number(claims.sucursalId), fixture.sucursalId);
const database = require('../src/main/database');
const { apiClient } = require('../src/main/api-client');
const { authService } = require('../src/main/auth-service');
const { SyncService } = require('../src/main/sync-service');
const local = require('../src/main/local-server');
const imageCache = require('../src/main/image-cache');
const policy = require('../src/main/tiendanube-policy');
const config = require('../src/main/config-store');
let db, sync, port, control;
const originalFetch = global.fetch;
global.fetch = (url, options) => {
  const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'QA attempted a non-loopback request');
  return originalFetch(url, { ...options, redirect: 'error' });
};
function snapshot() {
  return {
    clientId: apiClient.clientId, sucursalId: apiClient.sucursalId, employeeId: apiClient.employeeId,
    profile: qa.profile, protocolVersion: sync.getStatus().protocolVersion,
    products: db.all('SELECT id,quantity,price FROM products ORDER BY id'),
    sales: db.all('SELECT local_id,cloud_id,client_sale_uuid,sync_status,total_amount FROM sales ORDER BY local_id'),
    outbox: db.all('SELECT mutation_type,state,source_id FROM sync_outbox ORDER BY sequence'),
    sessions: db.all('SELECT id,cloud_id,status,expected_amount,sync_status FROM cash_sessions ORDER BY id'),
  };
}
async function command(input) {
  if (input.action === 'snapshot') return snapshot();
  if (input.action === 'online') {
    apiClient.setBaseUrl(input.value ? qa.backendApiUrl : 'http://127.0.0.1:9');
    return { onlineEndpoint: input.value };
  }
  if (input.action === 'sync') { await sync.forceSync(); return snapshot(); }
  if (input.action === 'policy') return policy.refresh(db, apiClient, { refreshReservations: true });
  if (input.action === 'reload') {
    sync.stop(); db.save(); database.closeDatabase(); await database.initDatabase();
    db = database.getDb(); sync = new SyncService();
    local.setTiendanubeSaleSync(() => sync.flushForTiendanubeSale());
    return snapshot();
  }
  if (input.action === 'request') {
    assert.match(input.route, /^\/(sales|returns|cash-sessions)(?:[/?]|$)/);
    const response = await fetch(`http://127.0.0.1:${port}/api/client-panel/${fixture.clientId}/sucursales/${fixture.sucursalId}${input.route}`, {
      method: input.body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
      body: input.body ? JSON.stringify(input.body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  if (input.action === 'shutdown') {
    sync.stop(); await local.stopLocalServer(); await imageCache.shutdown(); database.closeDatabase();
    setTimeout(() => app.exit(0), 100); return { stopped: true };
  }
  throw new Error('Unknown QA action');
}
app.whenReady().then(async () => {
  assert.equal(config.get('backendApiUrl'), qa.backendApiUrl);
  assert.equal(config.get('webAppUrl'), qa.webAppUrl);
  apiClient.setBaseUrl(config.get('backendApiUrl'));
  apiClient.setAuth({ token: fixture.token, clientId: fixture.clientId, sucursalId: fixture.sucursalId, employeeId: fixture.employeeId });
  assert.equal(await apiClient.isOnline(), true);
  assert.equal(apiClient.lastHeartbeatAuthed, true);
  await apiClient.getMe();
  await database.initDatabase(); db = database.getDb(); imageCache.initialize();
  // Equivalent to the main process capturing a previously OTP-verified QA session.
  // No backend authentication is bypassed and each cashier has an independent token.
  const identity = { ...fixture, roles: claims.roles || [`ROLE_${fixture.role}`], employeeName: fixture.name };
  authService._saveUserLocally(fixture.email, fixture.password, identity, claims);
  authService._configureApiClient(identity, claims);
  fixture.password = '';
  sync = new SyncService(); await sync.forceSync();
  await policy.refresh(db, apiClient);
  local.setTiendanubeSaleSync(() => sync.flushForTiendanubeSale());
  port = await local.startLocalServer();
  control = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const input = buffer.slice(0, buffer.indexOf('\n')); buffer = '';
      Promise.resolve().then(() => command(JSON.parse(input)))
        .then(result => socket.end(JSON.stringify({ ok: true, result }) + '\n'))
        .catch(error => socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n'));
    });
  });
  control.listen(arg('--channel'), () => console.log('QA_READY ' + JSON.stringify(snapshot())));
}).catch(error => { console.error('QA_FAILED ' + error.message); app.exit(1); });
