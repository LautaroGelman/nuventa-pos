'use strict';

const { app } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const smokeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'nuventa-electron-cloud-'));
app.setPath('userData', smokeUserData);

function readCredentials() {
  const pipeArg = process.argv.indexOf('--credential-pipe');
  if (pipeArg >= 0 && process.argv[pipeArg + 1]) {
    return new Promise((resolve, reject) => {
      let input = '';
      const socket = net.createConnection(process.argv[pipeArg + 1]);
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => { input += chunk; });
      socket.on('error', reject);
      socket.on('end', () => {
        try { resolve(JSON.parse(input)); } catch {
          reject(new Error(`Entrada de credenciales inválida (bytes=${Buffer.byteLength(input)})`));
        }
      });
    });
  }
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    const finish = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      const normalized = input.trim();
      try { resolve(JSON.parse(normalized)); } catch {
        reject(new Error(`Entrada de credenciales inválida (bytes=${Buffer.byteLength(normalized)})`));
      }
    };
    const onData = (chunk) => {
      input += chunk;
      if (process.stdin.isTTY && /[\r\n]$/.test(input)) finish();
    };
    if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
    process.stdin.on('data', onData);
    process.stdin.on('end', finish);
  });
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.content)) return value.content;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

async function responseJson(response, operation) {
  const text = await response.text();
  assert.ok(response.ok, `${operation} failed (${response.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function runMutationSmoke(db, sync, branchId) {
  const { apiClient } = require('../src/main/api-client');
  const { startLocalServer, stopLocalServer } = require('../src/main/local-server');
  const product = db.get(`SELECT id, price FROM products
    WHERE client_id=? AND sucursal_id=? AND active=1 AND price>0
      AND (stock_tracked=0 OR weighable=1 OR quantity>0)
    ORDER BY CASE WHEN stock_tracked=1 AND weighable=0 THEN 0 ELSE 1 END, id LIMIT 1`,
  [Number(apiClient.clientId), branchId]);
  const register = db.get(`SELECT id FROM cash_registers
    WHERE client_id=? AND sucursal_id=? AND active=1 ORDER BY id LIMIT 1`,
  [Number(apiClient.clientId), branchId]);
  assert.ok(product, 'No hay un producto apto para la prueba de mutación');
  assert.ok(register, 'No hay una caja activa para la prueba de mutación');

  let localServerStarted = false;
  let openedBySmoke = false;
  let activeSession = null;
  let branchUrl;
  const authenticatedToken = apiClient.token;
  const authenticatedHeartbeat = apiClient.lastHeartbeatAuthed;
  try {
    const port = await startLocalServer();
    localServerStarted = true;
    branchUrl = `http://127.0.0.1:${port}/api/client-panel/${apiClient.clientId}/sucursales/${branchId}`;

    activeSession = await responseJson(await fetch(`${branchUrl}/cash-sessions/current`), 'Consultar turno');
    if (!activeSession) {
      activeSession = await responseJson(await fetch(`${branchUrl}/cash-sessions/open`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cashRegisterId: register.id, initialAmount: 0 }),
      }), 'Abrir turno de prueba');
      openedBySmoke = true;
    }

    // The local write is performed with the cloud client deliberately unavailable.
    // Restoring the token afterwards exercises the production v1 uploader and its durable ACK.
    apiClient.token = null;
    apiClient.lastHeartbeatAuthed = false;
    let sale;
    try {
      sale = await responseJson(await fetch(`${branchUrl}/sales`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'COMPLETED', cashRegisterId: activeSession.cashRegisterId || register.id,
          items: [{ productId: product.id, quantity: 1 }],
          payments: [{ paymentMethod: 'EFECTIVO', amount: Number(product.price) }],
        }),
      }), 'Crear venta offline');
    } finally {
      apiClient.token = authenticatedToken;
      apiClient.lastHeartbeatAuthed = authenticatedHeartbeat;
    }

    assert.equal(db.get('SELECT sync_status FROM sales WHERE local_id=?', [sale.id]).sync_status, 'pending');
    await sync.forceSync();
    const syncedSale = db.get('SELECT local_id,cloud_id,sync_status FROM sales WHERE local_id=?', [sale.id]);
    assert.equal(syncedSale.sync_status, 'synced', 'La venta no quedó sincronizada');
    assert.ok(Number(syncedSale.cloud_id) > 0, 'La venta sincronizada no recibió cloud_id');
    assert.equal(db.get("SELECT COUNT(*) count FROM sync_outbox WHERE mutation_type='SALE' AND source_id=?", [sale.id]).count, 0);

    const saleItem = db.get('SELECT id FROM sale_items WHERE sale_local_id=? ORDER BY id LIMIT 1', [sale.id]);
    apiClient.token = null;
    apiClient.lastHeartbeatAuthed = false;
    let saleReturn;
    try {
      saleReturn = await responseJson(await fetch(`${branchUrl}/returns`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          saleId: syncedSale.cloud_id, reason: 'Prueba automatizada de sincronización POS', refundMethod: 'CASH',
          items: [{ saleItemId: saleItem.id, quantity: 1 }],
        }),
      }), 'Crear devolución offline');
    } finally {
      apiClient.token = authenticatedToken;
      apiClient.lastHeartbeatAuthed = authenticatedHeartbeat;
    }
    await sync.forceSync();
    const syncedReturn = db.get('SELECT cloud_id,sync_status FROM returns WHERE local_id=?', [saleReturn.id]);
    assert.equal(syncedReturn.sync_status, 'synced', 'La devolución no quedó sincronizada');
    assert.ok(Number(syncedReturn.cloud_id) > 0, 'La devolución sincronizada no recibió cloud_id');
    assert.equal(db.get("SELECT COUNT(*) count FROM sync_outbox WHERE mutation_type='RETURN' AND source_id=?", [saleReturn.id]).count, 0);

    if (openedBySmoke) {
      await responseJson(await fetch(`${branchUrl}/cash-sessions/${activeSession.id}/close-with-tracking`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countedAmount: 0, floatLeftForNext: 0, note: 'Cierre de prueba POS' }),
      }), 'Cerrar turno de prueba');
      await sync.forceSync();
      assert.equal(db.get('SELECT sync_status FROM cash_sessions WHERE id=?', [activeSession.id]).sync_status, 'synced');
    }

    return {
      saleCloudId: Number(syncedSale.cloud_id), returnCloudId: Number(syncedReturn.cloud_id),
      openedAndClosedOwnSession: openedBySmoke,
      outbox: Number(db.get("SELECT COUNT(*) count FROM sync_outbox WHERE state IN ('PENDING','IN_FLIGHT')")?.count || 0),
    };
  } finally {
    apiClient.token = authenticatedToken;
    apiClient.lastHeartbeatAuthed = authenticatedHeartbeat;
    if (openedBySmoke && activeSession && branchUrl) {
      try {
        const local = db.get('SELECT status,expected_amount FROM cash_sessions WHERE id=?', [activeSession.id]);
        if (local?.status === 'OPEN') {
          await fetch(`${branchUrl}/cash-sessions/${activeSession.id}/close-with-tracking`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              countedAmount: Number(local.expected_amount || 0), floatLeftForNext: 0,
              note: 'Limpieza de prueba POS',
            }),
          });
          await sync.forceSync();
        }
      } catch (cleanupError) {
        process.stderr.write(`[ELECTRON-CLOUD-SMOKE] cleanup: ${String(cleanupError.message || cleanupError).slice(0, 200)}\n`);
      }
    }
    if (localServerStarted) await stopLocalServer().catch(() => {});
  }
}

async function cleanupCloudSale(saleId) {
  const { apiClient } = require('../src/main/api-client');
  const sale = await apiClient.getSaleById(saleId);
  const items = Array.isArray(sale?.items) ? sale.items : [];
  assert.ok(items.length > 0, `La venta cloud ${saleId} no tiene ítems para revertir`);
  const result = await apiClient.createReturn({
    clientReturnUuid: crypto.randomUUID(), saleId,
    reason: 'Limpieza de prueba automatizada de sincronización POS', refundMethod: 'CASH',
    items: items.map((item) => ({
      saleItemId: item.saleItemId || item.id, productId: item.productId, quantity: item.quantity,
    })),
  });
  return { cleanedSaleCloudId: saleId, returnCloudId: Number(result?.saleReturnId || result?.id) };
}

async function run() {
  const credentials = await readCredentials();
  const { initDatabase, getDb, closeDatabase } = require('../src/main/database');
  const { authService } = require('../src/main/auth-service');
  const { apiClient } = require('../src/main/api-client');
  const { SyncService } = require('../src/main/sync-service');
  const imageCache = require('../src/main/image-cache');
  let databaseStarted = false;
  try {
    await initDatabase();
    databaseStarted = true;
    imageCache.initialize();
    const login = await authService.login(credentials.email, credentials.password);
    assert.equal(login.success, true, login.error || 'Cloud login failed');
    credentials.password = '';

    const branches = list(await apiClient.getSucursales());
    assert.ok(branches.length > 0, 'The cloud account has no branches');
    const branchId = Number(apiClient.sucursalId || branches[0].id);
    apiClient.setActiveBranch(branchId);
    const db = getDb();
    db.run("INSERT OR REPLACE INTO app_config(key,value) VALUES ('sucursal_id',?)", [String(branchId)]);
    db.save();

    const sync = new SyncService();
    await sync.forceSync();
    sync.stop();
    const productCount = Number(db.get('SELECT COUNT(*) count FROM products WHERE active=1')?.count || 0);
    const registerCount = Number(db.get('SELECT COUNT(*) count FROM cash_registers WHERE active=1')?.count || 0);
    const outboxCount = Number(db.get('SELECT COUNT(*) count FROM sync_outbox')?.count || 0);
    assert.ok(productCount > 0, 'No products were cached in Electron SQLite');
    assert.ok(registerCount > 0, 'No registers were cached in Electron SQLite');
    assert.equal(outboxCount, 0, 'Read-only cloud smoke created unexpected mutations');
    assert.equal(sync.getStatus().protocolVersion, 1, 'Legacy production contract did not negotiate v1');

    const cleanupArg = process.argv.find((arg) => arg.startsWith('--cleanup-sale='));
    const cleanupId = cleanupArg ? Number(cleanupArg.split('=')[1]) : null;
    const mutation = Number.isSafeInteger(cleanupId) && cleanupId > 0
      ? await cleanupCloudSale(cleanupId)
      : (process.argv.includes('--mutate') ? await runMutationSmoke(db, sync, branchId) : null);
    process.stdout.write(`${JSON.stringify({ authenticated: true, protocolVersion: 1,
      cachedProducts: productCount, cachedRegisters: registerCount, outbox: outboxCount, mutation })}\n`);
    await apiClient.logout().catch(() => apiClient.clearAuth());
    authService.logout();
  } finally {
    credentials.password = '';
    await imageCache.shutdown().catch(() => {});
    if (databaseStarted) closeDatabase();
    const resolved = path.resolve(smokeUserData);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

app.whenReady().then(run).then(
  () => app.exit(0),
  (error) => {
    process.stderr.write(`[ELECTRON-CLOUD-SMOKE] ${String(error.message || error).slice(0, 300)}\n`);
    app.exit(1);
  },
);
