'use strict';
const { app } = require('electron');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'nuventa-purchases-test-')));
const database = require('../src/main/database');
const receipts = require('../src/main/purchase-receipts');
const { BundleSyncV2, sha256, canonicalJson } = require('../src/main/sync-bundle-v2');
const { apiClient } = require('../src/main/api-client');
const { startLocalServer, stopLocalServer } = require('../src/main/local-server');
let db, port;
const scope = { clientId: 1, branchId: 1, employeeId: 6, canPrice: true };
const newLine = (name, noCode = false) => {
  const clientProductUuid = crypto.randomUUID();
  return { uuid: crypto.randomUUID(), productId: null, clientProductUuid,
    newProduct: { clientProductUuid, name, code: noCode ? null : 'TEST-' + clientProductUuid, noCode, price: 2500 },
    decision: 'RECEIVE', exclusionReason: null, sourceDescription: null, invoiceQuantity: 15, unitsPerPack: 1,
    lineAmount: null, priceDecision: 'KEEP', expectedPricing: { cost: 0, price: 2500, pricingMode: 'MANUAL', targetMarkupPercent: null, costPending: true },
    reviewed: true, reviewedSalePrice: null, rememberMatch: false };
};
const request = line => ({ uuid: crypto.randomUUID(), providerId: null, receivedAt: null, totalAmount: null,
  adjustmentAmount: null, adjustmentReason: null, notes: null, documentUuid: null, duplicateReviewed: false, lines: [line] });
async function post(route, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/client-panel/1/sucursales/1${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
app.whenReady().then(async () => {
  await database.initDatabase(); db = database.getDb(); port = await startLocalServer();
  try {
    db.transaction(() => {
      for (const [key, value] of Object.entries({ auth_token: 'synthetic-purchases-token', client_id: '1', sucursal_id: '1', employee_id: '6',
        employee_name: 'Test owner', roles: '["ROLE_PROPIETARIO"]', last_online_at: new Date().toISOString(), [receipts.featureKey(scope)]: JSON.stringify({ enabled: true }) }))
        db.run('INSERT OR REPLACE INTO app_config(key,value) VALUES (?,?)', [key, value]);
      db.run("INSERT INTO cash_registers(id,name,active,client_id,sucursal_id) VALUES(77,'Test',1,1,1)");
      db.run("INSERT INTO cash_sessions(client_session_uuid,client_id,sucursal_id,employee_id,status,business_date,opening_time,initial_amount,expected_amount,cash_register_id,sync_status) VALUES('test-session',1,1,6,'OPEN','2026-09-09','2026-09-09T09:00:00',0,0,77,'synced')");
      db.run('DELETE FROM sync_outbox');
    });
    apiClient.setAuth({ token: 'synthetic-purchases-token', clientId: 1, sucursalId: 1, employeeId: 6 });
    apiClient.setBaseUrl('http://127.0.0.1:9'); apiClient.isOnline = async () => false;
    // Reconstruct the previous schema only inside this disposable test profile,
    // then upgrade a populated database with its cash session and catalog intact.
    assert.ok(path.basename(app.getPath('userData')).startsWith('nuventa-purchases-test-'));
    db.transaction(() => {
      db.run("INSERT INTO products(id,client_id,sucursal_id,code,name,cost,price,quantity,stock_tracked,active) VALUES(899,1,1,'LEGACY','Producto anterior',5,10,7,1,1)");
      for (const table of ['purchase_receipt_lines', 'purchase_receipt_amendments', 'purchase_receipts', 'product_client_references']) db.run(`DROP TABLE ${table}`);
      db.run('DROP INDEX idx_product_client_uuid');
      for (const [table, columns] of Object.entries({ products: ['client_product_uuid','cost_pending','pricing_mode','target_markup_percent','pending_price_receipt_uuid'],
        sale_items: ['client_product_uuid','unit_cost_at_sale','cost_pending','receipt_price_uuid'], return_items: ['client_product_uuid'] }))
        for (const column of columns) db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      db.run('DELETE FROM schema_migrations WHERE version IN (15,16)');
    });
    database.closeDatabase(); await database.initDatabase(); db = database.getDb();
    assert.deepEqual(db.get('SELECT price,cost,quantity,cost_pending,client_product_uuid FROM products WHERE id=899'),
      { price: 10, cost: 5, quantity: 7, cost_pending: 0, client_product_uuid: null });
    assert.equal(db.get('SELECT COUNT(*) n FROM cash_sessions').n, 1);
    assert.equal(db.get('SELECT MAX(version) n FROM schema_migrations').n, 16);
    db.run('DELETE FROM products WHERE id=899');
    console.log('[PURCHASES] Migración SQLite 14 → 16 con catálogo y caja existentes: OK');
    const line = newLine('Bebida nueva'); const input = request(line);
    receipts.saveDraft(db, scope, input.uuid, input);
    database.closeDatabase(); await database.initDatabase(); db = database.getDb();
    assert.deepEqual(receipts.get(db, scope, input.uuid).draft, input);
    const confirmed = await post('/purchase-receipts/confirm', input);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const localId = confirmed.body.lines[0].productId;
    assert.ok(localId < 0); assert.equal(confirmed.body.amountStatus, 'AMOUNT_PENDING');
    assert.equal((await post('/purchase-receipts/confirm', input)).status, 200);
    assert.equal(db.get('SELECT quantity FROM products WHERE id=?', [localId]).quantity, 15);
    const sale = await post('/sales', { clientSaleUuid: crypto.randomUUID(), items: [{ productId: localId, quantity: 3 }], payments: [{ paymentMethod: 'EFECTIVO', amount: 7500 }] });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    assert.equal(db.get('SELECT quantity FROM products WHERE id=?', [localId]).quantity, 12);
    const frozenSale = db.get("SELECT payload_json,payload_hash FROM sync_outbox WHERE mutation_type='SALE'");
    assert.equal(JSON.parse(frozenSale.payload_json).items[0].clientProductUuid, line.clientProductUuid);
    assert.equal(JSON.parse(frozenSale.payload_json).items[0].productId, undefined);
    assert.equal(db.get('SELECT cost_pending FROM sale_items').cost_pending, 1);
    const amount = { mutationUuid: crypto.randomUUID(), expectedVersion: 0, providerId: null, totalAmount: 30000, adjustmentAmount: null, adjustmentReason: null, lines: [] };
    receipts.complete(db, scope, input.uuid, amount); receipts.complete(db, scope, input.uuid, amount);
    assert.equal(db.get('SELECT COUNT(*) n FROM purchase_receipt_amendments').n, 1);
    assert.equal(db.get('SELECT cost_pending FROM products WHERE id=?', [localId]).cost_pending, 1);
    database.closeDatabase(); await database.initDatabase(); db = database.getDb();
    assert.equal(receipts.get(db, scope, input.uuid).totalAmount, 30000);
    assert.throws(() => receipts.get(db, { ...scope, branchId: 2 }, input.uuid), /encontrado/);
    let cloudStock = 0, lost = true; const applied = new Map(); const seen = [];
    const fake = { clientId: 1, sucursalId: 1, syncBundle: async body => {
      const results = [];
      for (const mutation of body.mutations) {
        assert.equal(sha256(canonicalJson(mutation.payload)), mutation.payloadHash);
        seen.push(mutation.type);
        if (applied.has(mutation.idempotencyKey)) { results.push({ ...applied.get(mutation.idempotencyKey), status: 'DUPLICATE' }); continue; }
        let result = { idempotencyKey: mutation.idempotencyKey, status: 'APPLIED', cloudId: null };
        if (mutation.type === 'PURCHASE_RECEIPT') {
          cloudStock += 15;
          result.result = { ...confirmed.body, version: 3, lines: confirmed.body.lines.map(value => ({ ...value, productId: 901 })) };
        } else if (mutation.type === 'SALE') {
          assert.ok(applied.has(input.uuid));
          assert.equal(JSON.stringify(mutation.payload), JSON.stringify(JSON.parse(frozenSale.payload_json)));
          cloudStock -= 3; result.cloudId = 501; result.result = { id: 501, totalAmount: 7500 };
        } else if (mutation.type === 'PURCHASE_RECEIPT_AMOUNTS') {
          assert.equal(mutation.payload.baseMutationUuid, input.uuid);
          result.result = { ...confirmed.body, version: 4, totalAmount: 30000, expenseId: 71, amountStatus: 'COMPLETE', lines: confirmed.body.lines.map(value => ({ ...value, productId: 901 })) };
        } else throw new Error('Unexpected mutation: ' + mutation.type);
        applied.set(mutation.idempotencyKey, result); results.push(result);
      }
      if (lost && body.mutations.length) { lost = false; throw new Error('Injected response lost after cloud commit'); }
      return { results, changes: [{ entityType: 'PRODUCT', entityId: 901, action: 'UPSERT', payload: { id: 901, clientProductUuid: line.clientProductUuid,
        name: 'Bebida nueva', code: line.newProduct.code, price: 2500, cost: 0, costPending: true, stockTracked: true, quantity: cloudStock } }], nextCursor: 'test-cursor', hasMore: false };
    } };
    try { await new BundleSyncV2(fake).sync(); } catch (error) { assert.match(error.message, /response lost/); }
    await new BundleSyncV2(fake).sync({ uploadMutations: false });
    assert.equal(db.get('SELECT quantity FROM products WHERE id=?', [localId]).quantity, 12);
    assert.equal(db.get('SELECT COUNT(*) n FROM products').n, 1);
    db.run("UPDATE sync_outbox SET next_retry_at=NULL,state='PENDING'");
    await new BundleSyncV2(fake).sync();
    assert.equal(cloudStock, 12);
    assert.equal(db.get('SELECT COUNT(*) n FROM products').n, 1);
    assert.equal(db.get('SELECT quantity FROM products WHERE id=901').quantity, 12);
    assert.equal(db.get('SELECT COUNT(*) n FROM sync_outbox').n, 0);
    assert.equal(db.get('SELECT product_id FROM sale_items').product_id, 901);
    assert.equal(receipts.get(db, scope, input.uuid).expenseId, 71);
    assert.equal(receipts.get(db, scope, input.uuid).syncStatus, 'SYNCED');
    assert.ok(seen.indexOf('PURCHASE_RECEIPT') < seen.indexOf('SALE'));
    db.run("INSERT INTO products(id,client_id,sucursal_id,code,name,price,cost,quantity,cloud_quantity,stock_tracked,active,pricing_mode,target_markup_percent) VALUES(900,1,1,'EXISTING','Bebida existente',1300,1000,5,5,1,1,'MARKUP',30)");
    const existingInput = request({ ...newLine('Bebida existente'), productId: 900, clientProductUuid: null, newProduct: null,
      invoiceQuantity: 13, lineAmount: 23400, priceDecision: 'ACCEPT',
      expectedPricing: { cost: 1000, price: 1300, pricingMode: 'MARKUP', targetMarkupPercent: 30, costPending: false } });
    const existingReceipt = receipts.confirm(db, scope, existingInput);
    assert.equal(db.get('SELECT price FROM products WHERE id=900').price, 2400);
    let remotePrice = 1300, remoteStock = 5, reviewedConflict = false, receiptApplied = false;
    const catalogSync = { clientId: 1, sucursalId: 1, syncBundle: async body => {
      const results = body.mutations.map(mutation => {
        if (mutation.type === 'PURCHASE_RECEIPT') {
          if (!reviewedConflict) return { idempotencyKey: mutation.idempotencyKey, status: 'CONFLICT', errorCode: 'CATALOG_CHANGED', message: 'Revisar precio actual' };
          receiptApplied = true; remoteStock += 13;
          return { idempotencyKey: mutation.idempotencyKey, status: 'APPLIED', result: { ...existingReceipt, syncStatus: 'SYNCED',
            lines: existingReceipt.lines.map(value => ({ ...value, priceDecision: 'REVIEW_REQUIRED',
              currentPricing: { cost: 2200, price: 3200, pricingMode: 'MARKUP', targetMarkupPercent: 30, costPending: false } })) } };
        }
        assert.equal(mutation.type, 'SALE'); assert.ok(receiptApplied, 'The sale waits for its receipt price proof');
        assert.equal(mutation.payload.items[0].unitPrice, 2400);
        assert.equal(mutation.payload.items[0].receiptPriceUuid, existingInput.uuid);
        remoteStock -= 1;
        return { idempotencyKey: mutation.idempotencyKey, status: 'APPLIED', cloudId: 502, result: { id: 502, totalAmount: 2400 } };
      });
      return { results, changes: [{ entityType: 'PRODUCT', entityId: 900, action: 'UPSERT', payload: {
        id: 900, name: 'Bebida existente', code: 'EXISTING', price: remotePrice, cost: remotePrice === 1300 ? 1000 : 2200,
        quantity: remoteStock, stockTracked: true, pricingMode: 'MARKUP', targetMarkupPercent: 30, costPending: false } }], hasMore: false };
    } };
    await new BundleSyncV2(catalogSync).sync({ uploadMutations: false });
    assert.equal(db.get('SELECT price FROM products WHERE id=900').price, 2400, 'An old catalog download preserves the pending local price');
    assert.equal(db.get('SELECT quantity FROM products WHERE id=900').quantity, 18);
    const pricedSale = await post('/sales', { items: [{ productId: 900, quantity: 1 }], payments: [{ paymentMethod: 'EFECTIVO', amount: 2400 }] });
    assert.equal(pricedSale.status, 201, JSON.stringify(pricedSale.body));
    const originalPriceReceipt = db.get('SELECT payload_json,payload_hash FROM sync_outbox WHERE idempotency_key=?', [existingInput.uuid]);
    remotePrice = 3200;
    await new BundleSyncV2(catalogSync).sync();
    assert.equal(receipts.get(db, scope, existingInput.uuid).syncStatus, 'REVIEW_REQUIRED');
    assert.equal(db.get('SELECT price FROM products WHERE id=900').price, 2400);
    reviewedConflict = true;
    db.run("UPDATE sync_outbox SET state='PENDING',next_retry_at=NULL WHERE idempotency_key=?", [existingInput.uuid]);
    assert.deepEqual(db.get('SELECT payload_json,payload_hash FROM sync_outbox WHERE idempotency_key=?', [existingInput.uuid]), originalPriceReceipt);
    await new BundleSyncV2(catalogSync).sync();
    assert.equal(remoteStock, 17); assert.equal(db.get('SELECT quantity FROM products WHERE id=900').quantity, 17);
    assert.equal(db.get('SELECT price FROM products WHERE id=900').price, 3200);
    assert.equal(db.get('SELECT COUNT(*) n FROM sync_outbox').n, 0);
    console.log('[PURCHASES] Precio pendiente, catálogo concurrente y precio histórico cobrado: OK');
    db.run("INSERT INTO products(id,client_id,sucursal_id,code,name,price,cost,quantity,cloud_quantity,stock_tracked,active,catalog_revision) VALUES(903,1,1,'LOST-EXISTING','Existente respuesta perdida',1800,1000,20,20,1,1,1)");
    const lostInput = request({ ...newLine('Existente respuesta perdida'), productId: 903, clientProductUuid: null, newProduct: null,
      invoiceQuantity: 4, expectedPricing: { cost: 1000, price: 1800, pricingMode: 'MANUAL', targetMarkupPercent: null, costPending: false } });
    const lostReceipt = receipts.confirm(db, scope, lostInput);
    assert.equal((await post('/sales', { items: [{ productId: 903, quantity: 2 }], payments: [{ paymentMethod: 'EFECTIVO', amount: 3600 }] })).status, 201);
    let lostExistingResponse = true, existingCloudStock = 20, existingRevision = 1;
    const existingLedger = new Map();
    const existingCloud = { clientId: 1, sucursalId: 1, syncBundle: async body => {
      const results = body.mutations.map(mutation => {
        if (existingLedger.has(mutation.idempotencyKey)) return { ...existingLedger.get(mutation.idempotencyKey), status: 'DUPLICATE' };
        let result;
        if (mutation.type === 'PURCHASE_RECEIPT') {
          existingCloudStock += 4; existingRevision++;
          result = { idempotencyKey: mutation.idempotencyKey, status: 'APPLIED', result: { ...lostReceipt,
            lines: lostReceipt.lines.map(value => ({ ...value, currentQuantity: existingCloudStock, currentCatalogRevision: existingRevision, currentPricing: lostInput.lines[0].expectedPricing })) } };
        } else {
          assert.equal(mutation.type, 'SALE'); existingCloudStock -= 2; existingRevision++;
          result = { idempotencyKey: mutation.idempotencyKey, status: 'APPLIED', cloudId: 503, result: { id: 503, totalAmount: 3600 } };
        }
        existingLedger.set(mutation.idempotencyKey, result); return result;
      });
      if (lostExistingResponse && body.mutations.length) { lostExistingResponse = false; throw new Error('Existing receipt response lost'); }
      return { results, changes: [{ entityType: 'PRODUCT', entityId: 903, action: 'UPSERT', payload: { id: 903, name: 'Existente respuesta perdida', code: 'LOST-EXISTING',
        price: 1800, cost: 1000, quantity: existingCloudStock, catalogRevision: existingRevision, stockTracked: true } }], hasMore: false };
    } };
    await assert.rejects(() => new BundleSyncV2(existingCloud).sync(), /response lost/);
    await new BundleSyncV2(existingCloud).sync({ uploadMutations: false });
    assert.equal(db.get('SELECT quantity FROM products WHERE id=903').quantity, 22, 'The downloaded cloud quantity must not count a committed receipt twice');
    db.run("UPDATE sync_outbox SET next_retry_at=NULL,state='PENDING'");
    await new BundleSyncV2(existingCloud).sync();
    assert.equal(existingCloudStock, 22); assert.equal(db.get('SELECT quantity FROM products WHERE id=903').quantity, 22);
    assert.equal(db.get('SELECT COUNT(*) n FROM sync_outbox').n, 0);
    console.log('[PURCHASES] Ingreso existente confirmado sin ACK y descarga anterior al reintento: OK');
    const openCartSale = await post('/sales', { items: [{ productId: localId, quantity: 1 }], payments: [{ paymentMethod: 'EFECTIVO', amount: 2500 }] });
    assert.equal(openCartSale.status, 201, JSON.stringify(openCartSale.body));
    const next = receipts.confirm(db, scope, request(newLine('Producto sin código', true)));
    assert.ok(next.lines[0].productId < localId, 'Negative identifiers are never reused after remapping');
    assert.equal(db.get('SELECT quantity FROM products WHERE id=?', [next.lines[0].productId]).quantity, 15);
    assert.equal(db.get('SELECT stock_tracked FROM products WHERE id=?', [next.lines[0].productId]).stock_tracked, 1);
    console.log('[PURCHASES] Persistencia, reintento, stock 15-3=12, referencias, importes y producto sin código: OK');
  } finally { await stopLocalServer(); database.closeDatabase(); app.quit(); }
}).catch(error => { console.error(error.stack); app.exit(1); });
