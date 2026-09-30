'use strict';

function remapProduct(db, scope, clientUuid, remoteId) {
  if (!clientUuid || !Number.isSafeInteger(remoteId) || remoteId <= 0) return;
  const reference = db.get('SELECT * FROM product_client_references WHERE client_id=? AND sucursal_id=? AND client_product_uuid=?', [scope.clientId, scope.branchId, clientUuid]);
  const provisionalId = reference?.local_product_id;
  if (provisionalId != null && provisionalId < 0) {
    const provisional = db.get('SELECT * FROM products WHERE id=? AND client_id=? AND sucursal_id=?', [provisionalId, scope.clientId, scope.branchId]);
    if (provisional) {
      const target = db.get('SELECT * FROM products WHERE id=?', [remoteId]);
      if (target && (target.client_id !== scope.clientId || target.sucursal_id !== scope.branchId)) throw new Error('El ACK intentó cruzar productos de otra sucursal');
      if (!target) {
        const columns = db.all('PRAGMA table_info(products)').map(column => column.name).filter(name => !['id', 'client_product_uuid'].includes(name));
        if (columns.some(name => !/^[a-z_]+$/.test(name))) throw new Error('Esquema local de productos inválido');
        db.run(`INSERT INTO products(id,${columns.join(',')}) SELECT ?,${columns.join(',')} FROM products WHERE id=?`, [remoteId, provisionalId]);
      } else db.run('UPDATE products SET quantity=quantity+? WHERE id=?', [provisional.quantity, remoteId]);
      for (const table of ['sale_items', 'return_items', 'purchase_receipt_lines']) db.run(`UPDATE ${table} SET product_id=? WHERE product_id=?`, [remoteId, provisionalId]);
      for (const movement of db.all('SELECT * FROM purchase_receipt_correction_deltas WHERE product_id=?', [provisionalId])) {
        db.run('INSERT INTO purchase_receipt_correction_deltas(amendment_id,product_id,client_product_uuid,delta) VALUES (?,?,?,?) ON CONFLICT(amendment_id,product_id) DO UPDATE SET delta=delta+excluded.delta', [movement.amendment_id,remoteId,clientUuid,movement.delta]);
      }
      db.run('DELETE FROM purchase_receipt_correction_deltas WHERE product_id=?', [provisionalId]);
      for (const row of db.all('SELECT local_id,receipt_json FROM purchase_receipts WHERE client_id=? AND sucursal_id=?', [scope.clientId,scope.branchId])) {
        const value = JSON.parse(row.receipt_json);
        const replace = node => { if (!node || typeof node !== 'object') return; if (node.productId === provisionalId) node.productId = remoteId; for (const v of Object.values(node)) replace(v); };
        replace(value);
        if (value.pricingEffects?.[provisionalId]) { value.pricingEffects[remoteId] = value.pricingEffects[provisionalId]; delete value.pricingEffects[provisionalId]; }
        db.run('UPDATE purchase_receipts SET receipt_json=? WHERE local_id=?', [JSON.stringify(value),row.local_id]);
      }
      db.run('DELETE FROM products WHERE id=?', [provisionalId]);
      if (!target) db.run('UPDATE products SET client_product_uuid=? WHERE id=?', [clientUuid, remoteId]);
    }
    db.run('UPDATE product_client_references SET remote_product_id=? WHERE client_id=? AND sucursal_id=? AND client_product_uuid=?', [remoteId, scope.clientId, scope.branchId, clientUuid]);
  } else db.run(`INSERT INTO product_client_references(client_id,sucursal_id,client_product_uuid,local_product_id,remote_product_id)
    VALUES (?,?,?,?,?) ON CONFLICT(client_id,sucursal_id,client_product_uuid) DO UPDATE SET remote_product_id=excluded.remote_product_id`, [scope.clientId, scope.branchId, clientUuid, remoteId, remoteId]);
}
function acknowledge(db, outbox, response) {
  const body = response.receipt || response;
  const corrections = outbox.mutation_type === 'PURCHASE_RECEIPT_CORRECTION';
  const affected = corrections ? response.products.map(p => ({ productId:p.productId,clientProductUuid:p.clientProductUuid,currentQuantity:p.quantityAfter,
    currentCatalogRevision:p.catalogRevision,currentPricing:p.applied.pricing,pricingRevision:p.applied.revision,costDerived:p.applied.costDerived })) : body.lines;

  const original = JSON.parse(outbox.payload_json);
  if (body?.uuid !== (original.receipt?.uuid || original.receiptUuid)) throw new Error('El ACK corresponde a otro ingreso');
  if (!body?.uuid || !Array.isArray(body.lines) || Number(body.clientId) !== Number(outbox.client_id) || Number(body.sucursalId) !== Number(outbox.sucursal_id)) throw new Error('Respuesta de recepción inválida');
  const scope = { clientId: Number(outbox.client_id), branchId: Number(outbox.sucursal_id) };
  for (const line of affected) remapProduct(db, scope, line.clientProductUuid, Number(line.productId));
  const pendingCosts = require('./purchase-receipt-pending').pendingReceiptCosts(db, scope.clientId, scope.branchId);
  for (const line of affected) {
    if (line.currentQuantity == null || !line.productId) continue;
    const local = db.get('SELECT catalog_revision FROM products WHERE id=? AND client_id=? AND sucursal_id=?', [line.productId, scope.clientId, scope.branchId]);
    const currentUnits = corrections ? Number(db.get('SELECT delta n FROM purchase_receipt_correction_deltas WHERE amendment_id=? AND product_id=?', [outbox.source_id,line.productId])?.n || 0) : outbox.mutation_type === 'PURCHASE_RECEIPT'
      ? Number(db.get('SELECT COALESCE(SUM(quantity),0) n FROM purchase_receipt_lines WHERE receipt_local_id=? AND product_id=?', [outbox.source_id, line.productId])?.n || 0) : 0;
    const pending = require('./sync-bundle-v2').pendingStockDelta(db, line.productId, scope.clientId, scope.branchId) - currentUnits;
    db.run('UPDATE products SET cloud_quantity=?,quantity=?,catalog_revision=? WHERE id=? AND client_id=? AND sucursal_id=?',
      [line.currentQuantity, Number(line.currentQuantity) + pending, Math.max(Number(local?.catalog_revision || 0), Number(line.currentCatalogRevision || local?.catalog_revision || 0)), line.productId, scope.clientId, scope.branchId]);
  }
  if (corrections) for (const movement of db.all('SELECT * FROM purchase_receipt_correction_deltas WHERE amendment_id=?', [outbox.source_id])) {
    if (affected.some(line => Number(line.productId) === movement.product_id)) continue;
    const pending = require('./sync-bundle-v2').pendingStockDelta(db,movement.product_id,scope.clientId,scope.branchId) - movement.delta;
    db.run('UPDATE products SET quantity=COALESCE(cloud_quantity,0)+? WHERE id=? AND client_id=? AND sucursal_id=?', [pending,movement.product_id,scope.clientId,scope.branchId]);
  }
  for (const line of affected) {
    if (!line.productId || !line.currentPricing) continue;
    const product = db.get('SELECT pending_price_receipt_uuid FROM products WHERE id=? AND client_id=? AND sucursal_id=?', [line.productId, scope.clientId, scope.branchId]);
    const later = product?.pending_price_receipt_uuid && product.pending_price_receipt_uuid !== outbox.idempotency_key
      && db.get('SELECT 1 FROM sync_outbox WHERE client_id=? AND sucursal_id=? AND idempotency_key=?', [scope.clientId, scope.branchId, product.pending_price_receipt_uuid]);
    if (!later) db.run('UPDATE products SET price=?,pricing_mode=?,target_markup_percent=?,pending_price_receipt_uuid=NULL WHERE id=? AND client_id=? AND sucursal_id=?',
      [line.currentPricing.price, line.currentPricing.pricingMode, line.currentPricing.targetMarkupPercent, line.productId, scope.clientId, scope.branchId]);
    const pendingCost = pendingCosts.get(Number(line.productId));
    if (!later && (!pendingCost || pendingCost.uuid === outbox.idempotency_key)) {
      db.run('UPDATE products SET cost=?,cost_pending=?,cost_derived=COALESCE(?,cost_derived) WHERE id=? AND client_id=? AND sucursal_id=?',
        [line.currentPricing.cost, line.currentPricing.costPending ? 1 : 0, line.costDerived == null ? null : line.costDerived ? 1 : 0, line.productId, scope.clientId, scope.branchId]);
      const revision = line.pricingRevision ?? body.pricingEffects?.[line.productId]?.applied?.revision;
      if (revision != null) db.run('UPDATE products SET pricing_revision=? WHERE id=? AND client_id=? AND sucursal_id=?', [revision,line.productId,scope.clientId,scope.branchId]);
    }
  }
  const row = db.get('SELECT * FROM purchase_receipts WHERE uuid=? AND client_id=? AND sucursal_id=?', [body.uuid, scope.clientId, scope.branchId]);
  if (!row) throw new Error('El ingreso local del ACK no existe');
  if (['PURCHASE_RECEIPT_AMOUNTS','PURCHASE_RECEIPT_CORRECTION'].includes(outbox.mutation_type)) db.run("UPDATE purchase_receipt_amendments SET sync_status='synced',sync_error=NULL WHERE local_id=?", [outbox.source_id]);
  const pending = db.get("SELECT 1 FROM purchase_receipt_amendments WHERE receipt_local_id=? AND sync_status<>'synced' LIMIT 1", [row.local_id]);
  let value = body;
  if (pending) {
    value = JSON.parse(row.receipt_json);
    for (const line of value.lines) {
      const remote = body.lines.find(item => item.uuid === line.uuid);
      if (remote && (!line.clientProductUuid || line.clientProductUuid === remote.clientProductUuid) && line.productId === remote.productId) line.productId = remote.productId;
      if (line.clientProductUuid) { const reference = db.get('SELECT remote_product_id FROM product_client_references WHERE client_id=? AND sucursal_id=? AND client_product_uuid=?', [scope.clientId,scope.branchId,line.clientProductUuid]); if (reference?.remote_product_id) line.productId = reference.remote_product_id; }
    }
    value.expenseId = body.expenseId;
  }
  db.run("UPDATE purchase_receipts SET receipt_json=?,remote_version=?,sync_status='synced',sync_error=NULL,synced_at=datetime('now') WHERE local_id=?",
    [JSON.stringify(value), body.version, row.local_id]);
}
module.exports = { acknowledge, remapProduct };
