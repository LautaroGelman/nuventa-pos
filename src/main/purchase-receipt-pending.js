// ============================================================
// Pending purchase costs, derived from the durable outbox.
// Works with already queued v16 operations without changing their payloads.
// ============================================================
'use strict';

function pendingReceiptCosts(db, clientId, branchId) {
  const pending = new Map();
  const rows = db.all(`SELECT o.sequence,o.idempotency_key,o.payload_json,r.receipt_json
    FROM sync_outbox o JOIN purchase_receipts r ON r.client_id=o.client_id AND r.sucursal_id=o.sucursal_id
      AND r.uuid=COALESCE(json_extract(o.payload_json,'$.receipt.uuid'),json_extract(o.payload_json,'$.receiptUuid'))
    WHERE o.client_id=? AND o.sucursal_id=? AND o.mutation_type IN ('PURCHASE_RECEIPT','PURCHASE_RECEIPT_AMOUNTS','PURCHASE_RECEIPT_CORRECTION')
    ORDER BY o.sequence`, [clientId, branchId]);
  if (!rows.length) return pending;
  const references = new Map(db.all('SELECT client_product_uuid,local_product_id,remote_product_id FROM product_client_references WHERE client_id=? AND sucursal_id=?',
    [clientId, branchId]).map(row => [row.client_product_uuid, row.remote_product_id || row.local_product_id]));
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json);
    const receipt = JSON.parse(row.receipt_json);
    if (payload.correction) {
      for (const product of payload.products || []) {
        const productId = references.get(product.clientProductUuid) ?? product.productId;
        if (productId != null) pending.set(Number(productId), { uuid: row.idempotency_key });
      }
      continue;
    }
    const localLines = new Map(receipt.lines.map(line => [line.uuid, line]));
    const changed = payload.amounts ? new Set((payload.amounts.lines || []).map(line => line.lineUuid)) : null;
    const groups = new Map();
    for (const line of payload.receipt?.lines || receipt.lines || []) {
      if (line.decision !== 'RECEIVE') continue;
      const localLine = localLines.get(line.uuid);
      const productId = references.get(line.clientProductUuid) ?? line.productId ?? localLine?.productId;
      if (productId == null) continue;
      if (!groups.has(productId)) groups.set(productId, []);
      groups.get(productId).push(line);
    }
    for (const [productId, lines] of groups) {
      if (lines.some(line => line.lineAmount == null) || (changed && !lines.some(line => changed.has(line.uuid)))) continue;
      // Keep the latest local cost operation, including messages under review.
      pending.set(Number(productId), { uuid: row.idempotency_key });
    }
  }
  return pending;
}

module.exports = { pendingReceiptCosts };
