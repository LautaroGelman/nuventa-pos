'use strict';

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('node:assert/strict');
const { once } = require('events');
const imageCache = require('../src/main/image-cache');
const { createImageCache } = imageCache;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const smokeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'nuventa-electron-smoke-'));
app.setPath('userData', smokeUserData);

function listen(server) {
  server.listen(0, '127.0.0.1');
  return once(server, 'listening');
}

function close(server) {
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

async function waitIdle(cache) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const stats = cache.getStats();
    if (stats.activeDownloads === 0 && stats.pendingJobs === 0 && stats.delayedJobs === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Image cache did not become idle');
}

async function run() {
  const sourceServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': JPEG.length });
    res.end(JPEG);
  });
  await listen(sourceServer);
  const sourceUrl = `http://127.0.0.1:${sourceServer.address().port}/product.jpg`;
  const options = { allowHttp: true, minFreeDiskBytes: 0, manifestFlushMs: 5 };
  const dependencies = { getUserDataPath: () => smokeUserData };
  let restarted = null;
  let localServerStarted = false;
  let databaseStarted = false;

  try {
    const { initDatabase, getDb, closeDatabase } = require('../src/main/database');
    const { startLocalServer, stopLocalServer } = require('../src/main/local-server');
    await initDatabase();
    databaseStarted = true;
    const db = getDb();
    db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES ('auth_token', 'smoke-token')");
    db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES ('client_id', '1')");
    db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES ('sucursal_id', '1')");
    db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES ('employee_id', '6')");
    db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES ('employee_name', 'Cajero Smoke')");
    db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES ('roles', '[\"ROLE_CAJERO\"]')");
    db.run("INSERT INTO cash_registers (id, code, name, active, client_id, sucursal_id) VALUES (77, 'SMOKE', 'Caja Smoke', 1, 1, 1)");
    db.run("INSERT INTO products (id, code, name, price, quantity, active) VALUES (701, 'SALE-SMOKE', 'Producto Smoke', 100, 5, 1)");
    db.save();

    imageCache.initialize();
    imageCache.reconcileProducts([{ id: 501, imageUrl: sourceUrl }]);
    await waitIdle(imageCache);
    const localUrl = imageCache.getLocalUrl(501, 'image', sourceUrl);
    if (!localUrl) throw new Error('Downloaded image was not published');

    const localPort = await startLocalServer();
    localServerStarted = true;
    const served = await fetch(`http://127.0.0.1:${localPort}${localUrl}`);
    if (!served.ok) throw new Error(`Local image route returned ${served.status}`);
    const body = Buffer.from(await served.arrayBuffer());
    if (!body.equals(JPEG)) throw new Error('Local image bytes differ from downloaded bytes');

    const branchUrl = `http://127.0.0.1:${localPort}/api/client-panel/1/sucursales/1`;
    const salePayloadWithoutRegister = {
      saleDate: '2026-08-09T16:30:00',
      employeeId: 6,
      status: 'COMPLETED',
      items: [{ productId: 701, quantity: 1 }],
      payments: [{ paymentMethod: 'EFECTIVO', amount: 100 }],
    };
    const saleWithoutShift = await fetch(`${branchUrl}/sales`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(salePayloadWithoutRegister),
    });
    assert.equal(saleWithoutShift.status, 409);
    assert.equal(db.get('SELECT COUNT(*) AS cnt FROM sales').cnt, 0);
    assert.equal(db.get('SELECT quantity FROM products WHERE id = 701').quantity, 5);

    // Regresión: si la nube informa que la caja está ocupada por otro usuario, el POS no debe
    // crear una sesión local que luego permita vender y termine en conflicto al sincronizar.
    const { apiClient } = require('../src/main/api-client');
    const originalOnline = apiClient.isOnline;
    const originalGetCurrentSession = apiClient.getCurrentSession;
    const originalOpenSession = apiClient.openSession;
    const originalToken = apiClient.token;
    const originalHeartbeat = apiClient.lastHeartbeatAuthed;
    apiClient.token = 'cloud-smoke-token';
    apiClient.lastHeartbeatAuthed = true;
    apiClient.isOnline = async () => {
      apiClient.lastHeartbeatAuthed = true;
      return true;
    };
    apiClient.getCurrentSession = async () => null;
    apiClient.openSession = async () => {
      throw new Error('HTTP 409: {"message":"Caja ocupada por otro cajero."}');
    };

    db.run(`
      INSERT INTO cash_sessions (client_session_uuid, client_id, sucursal_id, employee_id,
        employee_name, status, business_date, opening_time, initial_amount, expected_amount,
        cash_register_id, cash_register_name, sync_status)
      VALUES ('stale-session-smoke', 1, 1, 6, 'Nombre anterior', 'OPEN',
        '2026-08-09', '2026-08-09T10:00:00', 0, 0, 77, 'Caja Smoke', 'pending')
    `);

    const reconciledCurrent = await fetch(`${branchUrl}/cash-sessions/current`);
    assert.equal(reconciledCurrent.status, 200);
    assert.equal(await reconciledCurrent.json(), null);
    const quarantined = db.get("SELECT status, sync_status FROM cash_sessions WHERE client_session_uuid = 'stale-session-smoke'");
    assert.equal(quarantined.status, 'FORCED_CLOSE');
    assert.equal(quarantined.sync_status, 'needs_review');

    const occupiedOpen = await fetch(`${branchUrl}/cash-sessions/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cashRegisterId: 77, initialAmount: 0 }),
    });
    assert.equal(occupiedOpen.status, 409);
    assert.match(await occupiedOpen.text(), /Caja ocupada por otro cajero/);
    assert.equal(db.get("SELECT COUNT(*) AS cnt FROM cash_sessions WHERE status = 'OPEN'").cnt, 0);

    apiClient.isOnline = originalOnline;
    apiClient.getCurrentSession = originalGetCurrentSession;
    apiClient.openSession = originalOpenSession;
    apiClient.token = originalToken;
    apiClient.lastHeartbeatAuthed = originalHeartbeat;

    const opened = await fetch(`${branchUrl}/cash-sessions/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cashRegisterId: 77, initialAmount: 0 }),
    });
    assert.equal(opened.status, 200, await opened.text());

    // Regresión: los builds anteriores omitían cashRegisterId en la venta estándar. El servidor
    // local debe heredarlo del turno abierto para que el sync pueda crear/vincular la sesión cloud.
    const sale = await fetch(`${branchUrl}/sales`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(salePayloadWithoutRegister),
    });
    assert.equal(sale.status, 201, await sale.text());
    const persistedSale = db.get('SELECT cash_register_id, cash_session_id FROM sales ORDER BY local_id DESC LIMIT 1');
    assert.equal(persistedSale.cash_register_id, 77);
    assert.ok(persistedSale.cash_session_id > 0);
    assert.equal(db.get('SELECT quantity FROM products WHERE id = 701').quantity, 4);

    // Un segundo empleado en el mismo dispositivo no hereda ni puede vender sobre el turno del primero.
    db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES ('employee_id', '7')");
    db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES ('employee_name', 'Otro cajero')");
    const otherEmployeeCurrent = await fetch(`${branchUrl}/cash-sessions/current`);
    assert.equal(otherEmployeeCurrent.status, 200);
    assert.equal(await otherEmployeeCurrent.json(), null);
    const otherEmployeeSale = await fetch(`${branchUrl}/sales`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...salePayloadWithoutRegister, employeeId: 7 }),
    });
    assert.equal(otherEmployeeSale.status, 409);
    assert.equal(db.get('SELECT quantity FROM products WHERE id = 701').quantity, 4);
    db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES ('employee_id', '6')");
    db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES ('employee_name', 'Cajero Smoke')");

    // Regresión: si local_id=1 se sincronizó como cloud_id=155, buscar "1" debe consultar la
    // venta cloud 1 y nunca devolver por accidente la venta local que ahora se identifica como 155.
    const persistedSaleForReturn = db.get('SELECT local_id FROM sales ORDER BY local_id DESC LIMIT 1');
    db.run('UPDATE sales SET cloud_id = 155, sync_status = ? WHERE local_id = ?', [
      'synced', persistedSaleForReturn.local_id,
    ]);
    const originalGetSaleById = apiClient.getSaleById;
    const tokenBeforeSaleLookup = apiClient.token;
    apiClient.token = 'cloud-smoke-token';
    apiClient.getSaleById = async (saleId) => ({ id: saleId, items: [] });

    const collidedLookup = await fetch(`${branchUrl}/sales/${persistedSaleForReturn.local_id}`);
    const collidedLookupBody = await collidedLookup.text();
    assert.equal(collidedLookup.status, 200, collidedLookupBody);
    assert.equal(JSON.parse(collidedLookupBody).id, persistedSaleForReturn.local_id);

    apiClient.getSaleById = originalGetSaleById;
    apiClient.token = tokenBeforeSaleLookup;

    // El ID definitivo 155 sí debe resolver la venta local sincronizada y permitir devolverla.
    const saleLookup = await fetch(`${branchUrl}/sales/155`);
    const saleLookupBody = await saleLookup.text();
    assert.equal(saleLookup.status, 200, saleLookupBody);
    const returnableSale = JSON.parse(saleLookupBody);
    assert.equal(returnableSale.id, 155);
    assert.equal(returnableSale.items.length, 1);
    assert.ok(returnableSale.items[0].saleItemId > 0);

    const saleReturn = await fetch(`${branchUrl}/returns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        saleId: returnableSale.id,
        reason: 'Prueba de devolución POS',
        refundMethod: 'TRANSFER',
        items: [{ saleItemId: returnableSale.items[0].saleItemId, quantity: 1 }],
      }),
    });
    const saleReturnBodyText = await saleReturn.text();
    assert.equal(saleReturn.status, 201, saleReturnBodyText);
    const saleReturnBody = JSON.parse(saleReturnBodyText);
    assert.equal(saleReturnBody.fiscalDocument.status, 'PENDING_SYNC');
    assert.equal(saleReturnBody.fiscalDocument.retryable, false);
    assert.equal(
      db.get('SELECT fiscal_status FROM returns WHERE local_id = ?', [saleReturnBody.saleReturnId]).fiscal_status,
      'PENDING_SYNC'
    );
    assert.equal(db.get('SELECT quantity FROM products WHERE id = 701').quantity, 5);

    // Regresión: un cierre local no debe resucitar si cloud todavía devuelve la misma sesión OPEN
    // durante la ventana entre el cierre y el sync. El retry por ID también debe ser idempotente.
    const localOpenSession = db.get("SELECT * FROM cash_sessions WHERE status = 'OPEN' AND employee_id = 6");
    assert.ok(localOpenSession);
    db.run('UPDATE cash_sessions SET cloud_id = ? WHERE id = ?', [4321, localOpenSession.id]);

    const firstClose = await fetch(`${branchUrl}/cash-sessions/4321/close-with-tracking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countedAmount: 100, floatLeftForNext: 0 }),
    });
    assert.equal(firstClose.status, 200, await firstClose.text());
    assert.equal(db.get('SELECT status FROM cash_sessions WHERE id = ?', [localOpenSession.id]).status, 'CLOSED');

    apiClient.token = 'cloud-smoke-token';
    apiClient.lastHeartbeatAuthed = true;
    apiClient.isOnline = async () => {
      apiClient.lastHeartbeatAuthed = true;
      return true;
    };
    apiClient.getCurrentSession = async () => ({
      id: 4321,
      status: 'OPEN',
      cashRegisterId: 77,
      cashRegisterName: 'Caja Smoke',
      employeeName: 'Cajero Smoke',
      initialAmount: 0,
      expectedAmount: 100,
      openingTime: '2026-08-09T16:00:00',
      businessDate: '2026-08-09',
    });

    const currentAfterClose = await fetch(`${branchUrl}/cash-sessions/current`);
    assert.equal(currentAfterClose.status, 200);
    assert.equal(await currentAfterClose.json(), null);
    assert.equal(db.get("SELECT COUNT(*) AS cnt FROM cash_sessions WHERE cloud_id = 4321 AND status = 'OPEN'").cnt, 0);

    const repeatedClose = await fetch(`${branchUrl}/cash-sessions/4321/close-with-tracking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countedAmount: 100, floatLeftForNext: 0 }),
    });
    const repeatedCloseBody = await repeatedClose.text();
    assert.equal(repeatedClose.status, 200, repeatedCloseBody);
    assert.equal(JSON.parse(repeatedCloseBody).status, 'CLOSED');

    db.run(`
      INSERT INTO cash_sessions (cloud_id, client_session_uuid, client_id, sucursal_id, employee_id,
        employee_name, status, business_date, opening_time, initial_amount, expected_amount,
        cash_register_id, cash_register_name, sync_status)
      VALUES (5000, 'new-session-after-close', 1, 1, 6, 'Cajero Smoke', 'OPEN',
        '2026-08-09', '2026-08-09T17:00:00', 0, 0, 77, 'Caja Smoke', 'pending')
    `);
    const staleModalRetry = await fetch(`${branchUrl}/cash-sessions/4321/close-with-tracking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countedAmount: 100, floatLeftForNext: 0 }),
    });
    assert.equal(staleModalRetry.status, 200, await staleModalRetry.text());
    assert.equal(db.get("SELECT status FROM cash_sessions WHERE cloud_id = 5000").status, 'OPEN');

    apiClient.isOnline = originalOnline;
    apiClient.getCurrentSession = originalGetCurrentSession;
    apiClient.openSession = originalOpenSession;
    apiClient.token = originalToken;
    apiClient.lastHeartbeatAuthed = originalHeartbeat;

    await imageCache.shutdown();
    await stopLocalServer();
    localServerStarted = false;
    closeDatabase();
    databaseStarted = false;
    restarted = createImageCache(dependencies, options);
    restarted.initialize();
    if (restarted.getLocalUrl(501, 'image', sourceUrl) !== localUrl) {
      throw new Error('Image did not survive an Electron restart');
    }
    await restarted.shutdown();
    restarted = null;
    console.log('[SMOKE] Electron image cache + venta/caja local: OK');
  } finally {
    await close(sourceServer);
    if (localServerStarted) {
      const { stopLocalServer } = require('../src/main/local-server');
      await stopLocalServer().catch(() => {});
    }
    await imageCache.shutdown().catch(() => {});
    if (databaseStarted) {
      const { closeDatabase } = require('../src/main/database');
      try { closeDatabase(); } catch (_) {}
    }
    if (restarted) await restarted.shutdown().catch(() => {});
    const resolved = path.resolve(smokeUserData);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(resolved, { recursive: true, force: true });
  }
}

app.whenReady().then(run).then(
  () => app.exit(0),
  (error) => {
    console.error('[SMOKE] Electron image cache failed:', error);
    app.exit(1);
  },
);
