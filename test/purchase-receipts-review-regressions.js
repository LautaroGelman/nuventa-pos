'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const receipts = require('../src/main/purchase-receipts');
const routes = require('../src/main/purchase-receipt-routes');
const pricing = require('../src/main/purchase-pricing');
const { BundleSyncV2 } = require('../src/main/sync-bundle-v2');

module.exports = async function reviewRegressions(database) {
  let db = database.getDb();
  const scope = { clientId: 97, branchId: 97, employeeId: 6, canPrice: true };
  const product = id => db.get('SELECT * FROM products WHERE id=?', [id]);
  const line = (id, amount = null) => ({ uuid: randomUUID(), productId: id, clientProductUuid: null, newProduct: null,
    decision: 'RECEIVE', invoiceQuantity: 2, unitsPerPack: 1, lineAmount: amount, priceDecision: 'KEEP',
    expectedPricing: pricing.snapshot(product(id)), reviewed: true, reviewedSalePrice: null, rememberMatch: false });
  const draft = lines => ({ uuid: randomUUID(), providerId: null, totalAmount: null, adjustmentAmount: null,
    adjustmentReason: null, notes: null, documentUuid: null, duplicateReviewed: false, lines });
  const remoteDraft = input => ({ ...input, clientId: 97, sucursalId: 97, employeeId: 6, state: 'DRAFT',
    version: 1, syncStatus: 'SYNCED', createdAt: '2026-09-09T12:00:00', draft: input });
  db.transaction(() => {
    db.run('INSERT OR REPLACE INTO app_config(key,value) VALUES (?,?)', [receipts.featureKey(scope), '{"enabled":true}']);
    for (const id of [1900, 1901, 1902, 1903]) db.run(`INSERT INTO products
      (id,client_id,sucursal_id,code,name,price,cost,cost_derived,quantity,cloud_quantity,stock_tracked,active,pricing_mode,catalog_revision)
      VALUES (?,97,97,?, ?,500,100,1,5,5,1,1,'MANUAL',1)`, [id, `REVIEW-${id}`, `Producto ${id}`]);
  });
  let downloaded;
  const read = async path => {
    let result;
    await routes.handle({ req: { method: 'GET' }, res: {}, body: {}, query: {}, subpath: path, db, scope, authEpoch: 1,
      apiClient: { baseUrl: 'https://example.invalid', token: 'synthetic-review-token', clientId: 97, sucursalId: 97,
        authEpoch: 1, _fetch: async () => path === '/purchase-receipts' ? { content: [downloaded], totalElements: 1 } : downloaded },
      jsonResponse: (_, status, body) => { assert.equal(status, 200, JSON.stringify(body)); result = body; } });
    return result;
  };
  const original = draft([line(1900)]);
  downloaded = remoteDraft(original);
  await read(`/purchase-receipts/${original.uuid}`);
  receipts.saveDraft(db, scope, original.uuid, { ...original });
  assert.equal(receipts.get(db, scope, original.uuid).syncStatus, 'SYNCED', 'A no-op autosave permits later remote updates');
  downloaded = { ...downloaded, version: 2, draft: { ...original, notes: 'Editado en web' } };
  assert.equal((await read(`/purchase-receipts/${original.uuid}`)).draft.notes, 'Editado en web');
  const edited = { ...downloaded.draft, notes: 'Editado en POS', lines: [{ ...original.lines[0], invoiceQuantity: 15 }] };
  receipts.saveDraft(db, scope, original.uuid, edited);
  assert.equal(receipts.get(db, scope, original.uuid).syncStatus, 'PENDING');
  await read('/purchase-receipts');
  assert.deepEqual((await read(`/purchase-receipts/${original.uuid}`)).draft, edited);
  database.closeDatabase(); await database.initDatabase(); db = database.getDb();
  assert.deepEqual((await read(`/purchase-receipts/${original.uuid}`)).draft, edited, 'Local edits survive restart and another cloud read');
  receipts.confirm(db, scope, edited);
  assert.equal(product(1900).quantity, 20, 'Confirmation uses the locally edited quantity');
  console.log('[PURCHASES REVIEW] Borrador web editado localmente, historial, detalle y reinicio: OK');

  const remoteInput = draft([line(1902)]);
  downloaded = remoteDraft(remoteInput); await read(`/purchase-receipts/${remoteInput.uuid}`);
  downloaded = { ...downloaded, state: 'CONFIRMED', version: 2, draft: null,
    lines: remoteInput.lines.map(value => ({ ...value, receivedUnits: 2 })) };
  await read('/purchase-receipts');
  assert.equal(db.get('SELECT state FROM purchase_receipts WHERE uuid=?', [remoteInput.uuid]).state, 'CONFIRMED');
  downloaded = remoteDraft(remoteInput);
  assert.equal((await read(`/purchase-receipts/${remoteInput.uuid}`)).state, 'CONFIRMED', 'An older download cannot reopen a confirmed receipt');
  assert.throws(() => receipts.saveDraft(db, scope, remoteInput.uuid, remoteInput), /confirmado/);
  const completed = receipts.complete(db, scope, remoteInput.uuid, { mutationUuid: randomUUID(), expectedVersion: 2, totalAmount: 200,
    lines: [{ lineUuid: remoteInput.lines[0].uuid, lineAmount: 200, priceDecision: 'KEEP', reviewed: true, expectedPricing: pricing.snapshot(product(1902)) }] });
  assert.equal(completed.totalAmount, 200);
  assert.equal(completed.state, 'CONFIRMED');
  console.log('[PURCHASES REVIEW] Confirmación remota actualiza estado y permite completar importes: OK');

  // Limit upload fixtures to this scenario; other receipts above stay durably queued.
  db.run("UPDATE sync_outbox SET next_retry_at=datetime('now','+1 day') WHERE client_id=97");
  const first = receipts.confirm(db, scope, draft([line(1901, 400)]));
  const second = receipts.confirm(db, scope, draft([line(1901, 600)]));
  const frozen = () => db.all('SELECT idempotency_key,payload_json,payload_hash FROM sync_outbox WHERE client_id=97 ORDER BY sequence');
  const before = frozen();
  let accepted = new Map();
  let changes = [];
  const cloud = { clientId: 97, sucursalId: 97, syncBundle: async body => ({ hasMore: false, changes,
    results: body.mutations.map(mutation => accepted.has(mutation.idempotencyKey)
      ? { idempotencyKey: mutation.idempotencyKey, status: 'APPLIED', result: accepted.get(mutation.idempotencyKey) }
      : { idempotencyKey: mutation.idempotencyKey, status: 'CONFLICT', errorCode: 'CATALOG_CHANGED' }) }) };
  const catalog = (id, cost, price, revision, costPending = false) => ({ entityType: 'PRODUCT', entityId: id, action: 'UPSERT',
    payload: { id, code: `REVIEW-${id}`, name: `Producto ${id}`, cost, price, costPending, costDerived: true,
      quantity: 5, stockTracked: true, pricingMode: 'MANUAL', catalogRevision: revision } });
  const ack = (receipt, cost, price, revision, costPending = false) => ({ ...receipt, syncStatus: 'SYNCED',
    lines: receipt.lines.map(value => ({ ...value, currentCatalogRevision: revision, currentQuantity: 9,
      currentPricing: { cost, price, costPending, pricingMode: 'MANUAL', targetMarkupPercent: null } })) });
  const sync = options => new BundleSyncV2(cloud).sync(options);
  changes = [catalog(1901, 100, 777, 2)];
  await sync({ uploadMutations: false });
  assert.equal(product(1901).cost, 300, 'KEEP retains the latest local cost');
  assert.equal(product(1901).cost_derived, 0);
  assert.equal(product(1901).cost_pending, 0);
  assert.equal(product(1901).price, 777, 'KEEP still permits an independent remote sale price');
  assert.deepEqual(frozen(), before, 'Catalog download leaves frozen messages and hashes unchanged');
  database.closeDatabase(); await database.initDatabase(); db = database.getDb();
  await sync({ uploadMutations: false });
  assert.equal(product(1901).cost, 300);
  accepted = new Map([[first.uuid, ack(first, 200, 777, 2)]]);
  await sync();
  assert.equal(product(1901).cost, 300, 'An earlier ACK cannot replace the second receipt cost');
  assert.equal(receipts.get(db, scope, second.uuid).syncStatus, 'REVIEW_REQUIRED');
  await sync({ uploadMutations: false });
  assert.equal(product(1901).cost, 300, 'A quarantined cost remains protected');
  db.run("UPDATE sync_outbox SET state='PENDING',next_retry_at=NULL WHERE idempotency_key=?", [second.uuid]);
  accepted.set(second.uuid, ack(second, 310, 777, 3)); changes = [];
  await sync();
  assert.equal(product(1901).cost, 310, 'The matching final ACK settles cost without replaying older catalog values');
  changes = [catalog(1901, 450, 900, 4)]; await sync({ uploadMutations: false });
  assert.equal(product(1901).cost, 450, 'A newer catalog is applied after settlement');
  assert.equal(product(1901).price, 900);
  console.log('[PURCHASES REVIEW] Costo con KEEP, catálogo, reinicio, ACK anterior y conflicto: OK');

  db.run('UPDATE products SET cost_pending=1 WHERE id=1903');
  const pending = receipts.confirm(db, scope, draft([line(1903)]));
  accepted.set(pending.uuid, ack(pending, 100, 500, 2, true)); changes = [];
  await sync();
  const amend = amount => {
    const request = { mutationUuid: randomUUID(), expectedVersion: receipts.get(db, scope, pending.uuid).version,
      lines: [{ lineUuid: pending.lines[0].uuid, lineAmount: amount, priceDecision: 'KEEP', reviewed: true, expectedPricing: pricing.snapshot(product(1903)) }] };
    return { request, receipt: receipts.complete(db, scope, pending.uuid, request) };
  };
  const amount1 = amend(400), amount2 = amend(600);
  const amountFrozen = frozen();
  changes = [catalog(1903, 100, 500, 2, true)];
  await sync({ uploadMutations: false });
  assert.equal(product(1903).cost, 300);
  assert.equal(product(1903).cost_pending, 0, 'A downloaded pending-cost flag cannot undo completed amounts');
  assert.equal(product(1903).cost_derived, 0);
  assert.deepEqual(frozen(), amountFrozen);
  database.closeDatabase(); await database.initDatabase(); db = database.getDb();
  accepted.set(amount1.request.mutationUuid, ack(amount1.receipt, 200, 500, 3));
  await sync();
  assert.equal(product(1903).cost, 300, 'Earlier amount ACK preserves the later local completion');
  db.run("UPDATE sync_outbox SET state='PENDING',next_retry_at=NULL WHERE idempotency_key=?", [amount2.request.mutationUuid]);
  accepted.set(amount2.request.mutationUuid, ack(amount2.receipt, 300, 500, 4)); changes = [];
  await sync();
  assert.equal(product(1903).cost, 300);
  assert.equal(receipts.get(db, scope, pending.uuid).syncStatus, 'SYNCED');
  changes = [catalog(1903, 350, 600, 5)]; await sync({ uploadMutations: false });
  assert.equal(product(1903).cost, 350);
  console.log('[PURCHASES REVIEW] Importes posteriores, costo pendiente y ACK de enmiendas consecutivas: OK');

  const clientProductUuid = randomUUID();
  const provisional = receipts.confirm(db, scope, draft([{ ...line(1903, 400), productId: null, clientProductUuid,
    newProduct: { clientProductUuid, name: 'Producto provisional con costo', code: null, noCode: true, price: 500 },
    expectedPricing: { cost: 0, price: 500, costPending: true, pricingMode: 'MANUAL', targetMarkupPercent: null } }]));
  const negativeId = provisional.lines[0].productId;
  const correction = { mutationUuid: randomUUID(), expectedVersion: provisional.version,
    lines: [{ lineUuid: provisional.lines[0].uuid, lineAmount: 600, priceDecision: 'KEEP', reviewed: true,
      expectedPricing: pricing.snapshot(product(negativeId)) }] };
  const corrected = receipts.complete(db, scope, provisional.uuid, correction);
  const originalAmendment = db.get('SELECT payload_json,payload_hash FROM sync_outbox WHERE idempotency_key=?', [correction.mutationUuid]);
  const remapped = receipt => ({ ...receipt, lines: receipt.lines.map(value => ({ ...value, productId: 1904 })) });
  accepted.set(provisional.uuid, ack(remapped(provisional), 200, 500, 2)); changes = [];
  await sync();
  assert.equal(product(negativeId), null);
  assert.equal(product(1904).cost, 300, 'Remapping a new product preserves its later local cost amendment');
  changes = [catalog(1904, 200, 500, 2)]; await sync({ uploadMutations: false });
  assert.equal(product(1904).cost, 300);
  assert.deepEqual(db.get('SELECT payload_json,payload_hash FROM sync_outbox WHERE idempotency_key=?', [correction.mutationUuid]), originalAmendment);
  db.run("UPDATE sync_outbox SET state='PENDING',next_retry_at=NULL WHERE idempotency_key=?", [correction.mutationUuid]);
  accepted.set(correction.mutationUuid, ack(remapped(corrected), 300, 500, 3)); changes = [];
  await sync();
  assert.equal(receipts.get(db, scope, provisional.uuid).syncStatus, 'SYNCED');
  assert.equal(product(1904).cost, 300);
  console.log('[PURCHASES REVIEW] Reasociación de producto provisional con un costo posterior pendiente: OK');
};
