const crypto = require('crypto');
const { getDb } = require('./database');

const MAX_MUTATIONS = 50;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_PAGES_PER_CYCLE = 20;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function localDateTime(value) {
  if (!value) return new Date().toISOString().replace(/Z$/, '');
  return String(value).trim().replace(' ', 'T').replace(/Z$/, '');
}

function getSyncState(db, clientId, sucursalId) {
  let state = db.get('SELECT * FROM sync_state WHERE client_id=? AND sucursal_id=?',
    [clientId, sucursalId]);
  if (!state) {
    db.run(`INSERT INTO sync_state(client_id,sucursal_id,device_id,protocol_version)
            VALUES (?,?,?,2)`, [clientId, sucursalId, crypto.randomUUID()]);
    state = db.get('SELECT * FROM sync_state WHERE client_id=? AND sucursal_id=?',
      [clientId, sucursalId]);
  }
  return state;
}

function rowBelongsToScope(row, clientId, sucursalId) {
  return (row.client_id == null || Number(row.client_id) === Number(clientId))
    && (row.sucursal_id == null || Number(row.sucursal_id) === Number(sucursalId));
}

function salePayload(db, outbox, clientId, sucursalId) {
  const sale = db.get('SELECT * FROM sales WHERE local_id=?', [outbox.source_id]);
  if (!sale || !rowBelongsToScope(sale, clientId, sucursalId)) return null;
  const session = sale.cash_session_id
    ? db.get('SELECT client_session_uuid,cash_register_id FROM cash_sessions WHERE id=?', [sale.cash_session_id])
    : null;
  const items = db.all('SELECT * FROM sale_items WHERE sale_local_id=? ORDER BY id', [sale.local_id]);
  const payments = db.all('SELECT * FROM sale_payments WHERE sale_local_id=? ORDER BY id', [sale.local_id]);
  const discounts = db.all('SELECT * FROM sale_promotion_discounts WHERE sale_local_id=? ORDER BY id', [sale.local_id]);
  let invoice;
  try { invoice = sale.invoice_json ? JSON.parse(sale.invoice_json) : undefined; } catch { invoice = undefined; }
  return {
    clientSaleUuid: sale.client_sale_uuid,
    productPricingVersion: sale.product_pricing_version ?? undefined,
    clientSessionUuid: session?.client_session_uuid || undefined,
    saleDate: localDateTime(sale.sale_date),
    employeeId: sale.employee_id || undefined,
    status: sale.status || 'COMPLETED',
    cashRegisterId: sale.cash_register_id || session?.cash_register_id || undefined,
    items: items.map((item) => ({
      productId: item.product_id == null || Number(item.product_id) < 0 ? undefined : Number(item.product_id),
      clientProductUuid: item.client_product_uuid || undefined,
      costPendingAtSale: item.cost_pending ? true : undefined,
      receiptPriceUuid: item.receipt_price_uuid || undefined,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price),
      catalogRevision: item.catalog_revision == null ? undefined : Number(item.catalog_revision),
      priceProof: item.price_proof || undefined,
      wholesaleMinimumQuantity: item.wholesale_minimum_quantity ?? undefined,
      customName: item.product_id == null ? item.product_name : undefined,
    })),
    payments: payments.map((payment) => ({
      paymentMethod: payment.payment_method,
      amount: Number(payment.amount),
      externalReference: payment.external_ref || undefined,
    })),
    totalDiscount: Number(sale.total_discount || 0),
    originalTotal: sale.original_total == null ? undefined : Number(sale.original_total),
    finalTotal: sale.final_total == null ? undefined : Number(sale.final_total),
    invoice,
    promotionDiscounts: discounts.length ? discounts.map((discount) => ({
      promotionId: discount.promotion_id || undefined,
      promotionName: discount.promotion_name || undefined,
      discountAmount: Number(discount.discount_amount || 0),
    })) : undefined,
  };
}

function returnPayload(db, outbox, clientId, sucursalId) {
  const ret = db.get('SELECT * FROM returns WHERE local_id=?', [outbox.source_id]);
  if (!ret || !rowBelongsToScope(ret, clientId, sucursalId)) return null;
  const sale = ret.sale_local_id
    ? db.get('SELECT cloud_id,client_sale_uuid FROM sales WHERE local_id=?', [ret.sale_local_id])
    : null;
  const items = db.all('SELECT * FROM return_items WHERE return_local_id=? ORDER BY id', [ret.local_id]);
  return {
    saleId: ret.sale_cloud_id || sale?.cloud_id || undefined,
    employeeId: ret.employee_id,
    clientSessionUuid: db.get('SELECT client_session_uuid FROM cash_sessions WHERE id=?', [ret.cash_session_id])?.client_session_uuid,
    clientSaleUuid: sale?.client_sale_uuid || undefined,
    reason: ret.reason || 'Devolución desde POS',
    refundMethod: ret.refund_method || 'CASH',
    returnDate: localDateTime(ret.return_date),
    items: items.map((item) => ({
      // Local line IDs are not remote IDs. Resolve by product after the sale ACK.
      saleItemId: ret.sale_local_id ? undefined : item.sale_item_id || undefined,
      productId: item.product_id == null || Number(item.product_id) < 0 ? undefined : item.product_id,
      clientProductUuid: item.client_product_uuid || undefined,
      quantity: Number(item.quantity),
    })),
  };
}

function movementPayload(db, outbox, clientId, sucursalId) {
  const movement = db.get('SELECT * FROM cash_movements WHERE local_id=?', [outbox.source_id]);
  if (!movement || !rowBelongsToScope(movement, clientId, sucursalId)) return null;
  return {
    scope: movement.scope || 'SESSION',
    employeeId: movement.employee_id,
    clientSessionUuid: db.get('SELECT client_session_uuid FROM cash_sessions WHERE id=?', [movement.cash_session_id])?.client_session_uuid,
    type: movement.type,
    amount: Number(movement.amount),
    note: movement.description || undefined,
    createdAt: localDateTime(movement.movement_date),
    expenseCategoryId: movement.expense_category_id || undefined,
  };
}

function sessionPayload(db, outbox, clientId, sucursalId) {
  const session = db.get('SELECT * FROM cash_sessions WHERE id=?', [outbox.source_id]);
  if (!session || !rowBelongsToScope(session, clientId, sucursalId)) return null;
  if (outbox.mutation_type === 'CASH_SESSION_OPEN') {
    return {
      employeeId: session.employee_id,
      previousSessionUuid: db.get(`SELECT client_session_uuid FROM cash_sessions
        WHERE client_id=? AND sucursal_id=? AND cash_register_id=? AND id<?
        ORDER BY id DESC LIMIT 1`, [clientId, sucursalId, session.cash_register_id, session.id])?.client_session_uuid || undefined,
      cashRegisterId: Number(session.cash_register_id),
      initialAmount: Number(session.initial_amount || 0),
      openedAt: localDateTime(session.opening_time),
    };
  }
  return {
    clientSessionUuid: session.client_session_uuid,
    employeeId: session.employee_id,
    countedAmount: Number(session.counted_amount || 0),
    floatLeftForNext: Number(session.float_left_for_next || 0),
    note: session.closing_note || 'Sincronizado desde POS offline',
    closedAt: localDateTime(session.closing_time),
  };
}

function materialize(db, outbox, clientId, sucursalId) {
  if (!rowBelongsToScope(outbox, clientId, sucursalId)) return null;
  if (outbox.payload_json && outbox.payload_hash) {
    return { payload: JSON.parse(outbox.payload_json), hash: outbox.payload_hash };
  }
  let payload;
  switch (outbox.mutation_type) {
    case 'SALE': payload = salePayload(db, outbox, clientId, sucursalId); break;
    case 'RETURN': payload = returnPayload(db, outbox, clientId, sucursalId); break;
    case 'CASH_MOVEMENT': payload = movementPayload(db, outbox, clientId, sucursalId); break;
    case 'CASH_SESSION_OPEN':
    case 'CASH_SESSION_CLOSE': payload = sessionPayload(db, outbox, clientId, sucursalId); break;
    default: payload = null;
  }
  if (!payload) return null;
  const json = canonicalJson(payload);
  const hash = sha256(json);
  db.run(`UPDATE sync_outbox SET payload_json=?,payload_hash=?,updated_at=datetime('now')
           WHERE sequence=?`, [json, hash, outbox.sequence]);
  return { payload: JSON.parse(json), hash };
}

function freezeNewMutations(db, previousSequence) {
  for (const row of db.all('SELECT * FROM sync_outbox WHERE sequence>?', [previousSequence])) {
    const frozen = materialize(db, row, row.client_id, row.sucursal_id);
    if (!frozen) throw new Error('No se pudo preparar la operación para sincronizar');
    if (Buffer.byteLength(JSON.stringify({ mutations: [{ payload: frozen.payload }] })) > MAX_REQUEST_BYTES - 8192) {
      throw new Error('La operación supera el tamaño permitido para sincronizar. Reducí la cantidad de líneas.');
    }
  }
}

function quarantine(db, row, message, code) {
  db.run("UPDATE sync_outbox SET state='QUARANTINED',last_error=?,warning_code=? WHERE sequence=?",
    [message, code, row.sequence]);
  const targets = { sales: 'local_id', returns: 'local_id', cash_movements: 'local_id', cash_sessions: 'id', purchase_receipts: 'local_id', purchase_receipt_amendments: 'local_id' };
  if (targets[row.source_table]) db.run(`UPDATE ${row.source_table} SET sync_status='needs_review',sync_error=? WHERE ${targets[row.source_table]}=?`,
    [message, row.source_id]);
}

function dueMutations(db, clientId, sucursalId, baseRequest, urgentBatch = null) {
  db.run(`UPDATE sync_outbox SET state='PENDING',updated_at=datetime('now')
           WHERE state='IN_FLIGHT' AND updated_at < datetime('now','-10 minutes')`);
  const rows = db.all(`SELECT * FROM sync_outbox
     WHERE state IN ('PENDING','QUARANTINED','IN_FLIGHT')
       AND (client_id IS NULL OR client_id=?) AND (sucursal_id IS NULL OR sucursal_id=?)
     ORDER BY sequence`, [clientId, sucursalId]);
  const mutations = [];
  const selected = [];
  const blockedSessions = new Set();
  for (const row of rows) {
    if (urgentBatch && Number(row.sequence) > urgentBatch.maxSequence) continue;
    const frozen = materialize(db, row, clientId, sucursalId);
    if (!frozen) continue;
    const dependencies = (frozen.payload.items || frozen.payload.receipt?.lines || [])
      .filter(item => item.clientProductUuid && !item.newProduct);
    const pendingProduct = dependencies.some(item => !db.get(`SELECT 1 FROM product_client_references
      WHERE client_id=? AND sucursal_id=? AND client_product_uuid=? AND remote_product_id IS NOT NULL`,
      [clientId, sucursalId, item.clientProductUuid]) && !db.get(`SELECT 1 FROM products
      WHERE client_id=? AND sucursal_id=? AND client_product_uuid=? AND id>0`, [clientId, sucursalId, item.clientProductUuid]));
    const pendingReceipt = row.mutation_type === 'PURCHASE_RECEIPT_AMOUNTS' && db.get(`SELECT 1 FROM purchase_receipts
      WHERE client_id=? AND sucursal_id=? AND uuid=? AND sync_status<>'synced'`, [clientId, sucursalId, frozen.payload.receiptUuid]);
    const pendingPrice = (frozen.payload.items || []).some(item => item.receiptPriceUuid && db.get('SELECT 1 FROM sync_outbox WHERE client_id=? AND sucursal_id=? AND idempotency_key=?', [clientId, sucursalId, item.receiptPriceUuid]));
    if (pendingProduct || pendingReceipt || pendingPrice) {
      if (frozen.payload.clientSessionUuid) blockedSessions.add(frozen.payload.clientSessionUuid);
      continue;
    }
    const sessionKey = row.mutation_type === 'CASH_SESSION_OPEN'
      ? row.idempotency_key : frozen.payload.clientSessionUuid;
    const retryAt = row.next_retry_at ? Date.parse(row.next_retry_at.replace(' ', 'T') + 'Z') : 0;
    if (row.state !== 'PENDING' || (!urgentBatch && retryAt > Date.now())
        || urgentBatch?.attempted.has(Number(row.sequence))
        || (urgentBatch?.cashStateOnly && row.mutation_type !== 'CASH_SESSION_OPEN') || blockedSessions.has(sessionKey)
        || blockedSessions.has(frozen.payload.previousSessionUuid)) {
      if (sessionKey) blockedSessions.add(sessionKey);
      continue;
    }
    const mutation = {
      sequence: Number(row.sequence),
      type: row.mutation_type,
      idempotencyKey: row.idempotency_key,
      occurredAt: localDateTime(row.occurred_at),
      payload: frozen.payload,
      payloadHash: frozen.hash,
    };
    const candidate = { ...baseRequest, mutations: [...mutations, mutation] };
    if (Buffer.byteLength(JSON.stringify({ ...baseRequest, mutations: [mutation] })) > MAX_REQUEST_BYTES) {
      quarantine(db, row, 'La operación supera el límite del servidor y requiere revisión.', 'PAYLOAD_TOO_LARGE');
      if (sessionKey) blockedSessions.add(sessionKey);
      continue;
    }
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_REQUEST_BYTES) break;
    mutations.push(mutation);
    selected.push(Number(row.sequence));
    if (mutations.length === MAX_MUTATIONS) break;
  }
  return { mutations, selected };
}

function pendingStockDelta(db, productId, clientId, sucursalId) {
  const sold = db.get(`SELECT COALESCE(SUM(si.quantity),0) value
      FROM sync_outbox o JOIN sale_items si ON o.source_table='sales'
       AND o.source_id=si.sale_local_id
     WHERE o.mutation_type='SALE' AND si.product_id=?
       AND (o.client_id IS NULL OR o.client_id=?)
       AND (o.sucursal_id IS NULL OR o.sucursal_id=?)`,
  [productId, clientId, sucursalId])?.value || 0;
  const returned = db.get(`SELECT COALESCE(SUM(ri.quantity),0) value
      FROM sync_outbox o JOIN return_items ri ON o.source_table='returns'
       AND o.source_id=ri.return_local_id
     WHERE o.mutation_type='RETURN' AND ri.product_id=?
       AND (o.client_id IS NULL OR o.client_id=?)
       AND (o.sucursal_id IS NULL OR o.sucursal_id=?)`,
  [productId, clientId, sucursalId])?.value || 0;
  const received = db.get(`SELECT COALESCE(SUM(l.quantity),0) value
      FROM sync_outbox o JOIN purchase_receipt_lines l ON o.source_table='purchase_receipts' AND o.source_id=l.receipt_local_id
      WHERE o.mutation_type='PURCHASE_RECEIPT' AND l.product_id=? AND o.client_id=? AND o.sucursal_id=?`, [productId, clientId, sucursalId])?.value || 0;
  return Number(received) + Number(returned) - Number(sold);
}

function pendingReceiptQuantity(db, productId, clientId, sucursalId) {
  return Number(db.get(`SELECT COALESCE(SUM(l.quantity),0) value FROM purchase_receipt_lines l
    JOIN sync_outbox o ON o.source_table='purchase_receipts' AND o.source_id=l.receipt_local_id
    WHERE o.mutation_type='PURCHASE_RECEIPT' AND l.product_id=? AND o.client_id=? AND o.sucursal_id=?`, [productId, clientId, sucursalId])?.value || 0);
}
function applyProduct(db, change, now, clientId, sucursalId) {
  if (change.action === 'DELETE' || !change.payload) {
    db.run('UPDATE products SET active=0,synced_at=? WHERE id=? AND client_id=? AND sucursal_id=?',
      [now, change.entityId, clientId, sucursalId]);
    return;
  }
  const product = change.payload;
  if (product.clientProductUuid && db.get('SELECT 1 FROM products WHERE client_id=? AND sucursal_id=? AND client_product_uuid=? AND id<0', [clientId, sucursalId, product.clientProductUuid])) {
    // A catalog download can see the cloud commit before a lost receipt ACK is retried.
    // Keep the provisional stock until the original operation is acknowledged.
    db.run('INSERT OR REPLACE INTO app_config(key,value) VALUES (?,?)',
      [`deferred_receipt_product:${clientId}:${sucursalId}:${product.id}`, JSON.stringify(change)]);
    return;
  }
  let cloudQuantity = Number(product.cloudQuantity ?? product.quantity ?? 0);
  const local = db.get('SELECT * FROM products WHERE id=? AND client_id=? AND sucursal_id=?', [product.id, clientId, sucursalId]);
  const revision = product.catalogRevision ?? change.revision;
  if (revision != null && local && Number(local.catalog_revision) > Number(revision)) return;
  const pendingReceipt = local && pendingReceiptQuantity(db, product.id, clientId, sucursalId) > 0;
  const pendingPrice = local?.pending_price_receipt_uuid && db.get('SELECT 1 FROM sync_outbox WHERE client_id=? AND sucursal_id=? AND idempotency_key=?', [clientId, sucursalId, local.pending_price_receipt_uuid]);
  const tracksStock = !product.weighable && product.stockTracked !== false;
  let effectiveQuantity = cloudQuantity
    + (tracksStock ? pendingStockDelta(db, Number(product.id), clientId, sucursalId) : 0);
  if (pendingReceipt) {
    // Until the ACK, the cloud quantity may already contain this receipt.
    // Keep the local stock instead of applying the same received units twice.
    effectiveQuantity = local.quantity; cloudQuantity = local.cloud_quantity;
  }
  db.run(`INSERT INTO products
    (id,code,no_code,stock_tracked,weighable,max_unit_price,name,description,price,cost,
     cost_derived,quantity,cloud_quantity,catalog_revision,price_proof,low_stock_threshold,
     reorder_qty_default,preferred_provider_id,preferred_provider_name,category_ids,
     subcategory_ids,provider_ids,image_url,thumbnail_url,client_id,sucursal_id,active,synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
    ON CONFLICT(id) DO UPDATE SET
     code=excluded.code,no_code=excluded.no_code,stock_tracked=excluded.stock_tracked,
     weighable=excluded.weighable,max_unit_price=excluded.max_unit_price,name=excluded.name,
     description=excluded.description,price=excluded.price,cost=excluded.cost,
     cost_derived=excluded.cost_derived,quantity=excluded.quantity,
     cloud_quantity=excluded.cloud_quantity,catalog_revision=excluded.catalog_revision,
     price_proof=excluded.price_proof,low_stock_threshold=excluded.low_stock_threshold,
     reorder_qty_default=excluded.reorder_qty_default,
     preferred_provider_id=excluded.preferred_provider_id,
     preferred_provider_name=excluded.preferred_provider_name,
     category_ids=excluded.category_ids,subcategory_ids=excluded.subcategory_ids,
      provider_ids=excluded.provider_ids,image_url=excluded.image_url,
      thumbnail_url=excluded.thumbnail_url,client_id=excluded.client_id,
      sucursal_id=excluded.sucursal_id,active=1,synced_at=excluded.synced_at`, [
    product.id, product.code || null, product.noCode ? 1 : 0, product.stockTracked === false ? 0 : 1,
    product.weighable ? 1 : 0, product.maxUnitPrice ?? null, product.name,
    product.description || null, Number(product.price || 0), product.cost ?? null,
    product.costDerived ? 1 : 0, effectiveQuantity, cloudQuantity,
    Number(product.catalogRevision || change.revision || 0), product.priceProof || null,
    product.lowStockThreshold ?? null, product.reorderQtyDefault ?? null,
    product.preferredProviderId ?? null, product.preferredProviderName || null,
    JSON.stringify(product.categoryIds || []), JSON.stringify(product.subcategoryIds || []),
    JSON.stringify(product.providerIds || []), product.imageUrl || null,
    product.thumbnailUrl || null, clientId, sucursalId, now,
  ]);
  db.run(`UPDATE products SET wholesale_enabled=?,wholesale_configured=?,wholesale_price=?,wholesale_minimum_quantity=?,wholesale_price_proof=?
    WHERE id=? AND client_id=? AND sucursal_id=?`, [product.wholesaleEnabled ? 1 : 0, product.wholesaleConfigured ? 1 : 0,
    product.wholesalePrice ?? null, product.wholesaleMinimumQuantity ?? null, product.wholesalePriceProof || null, product.id, clientId, sucursalId]);
  db.run('UPDATE products SET client_product_uuid=?,cost_pending=?,pricing_mode=?,target_markup_percent=? WHERE id=? AND client_id=? AND sucursal_id=?',
    [product.clientProductUuid || null, product.costPending ? 1 : 0, product.pricingMode || 'MANUAL', product.targetMarkupPercent ?? null, product.id, clientId, sucursalId]);
  if (pendingPrice || pendingReceipt) {
    db.run('INSERT OR REPLACE INTO app_config(key,value) VALUES (?,?)', [`deferred_receipt_product:${clientId}:${sucursalId}:${product.id}`, JSON.stringify(change)]);
  }
  if (pendingPrice) {
    db.run('UPDATE products SET price=?,cost=?,cost_pending=?,pricing_mode=?,target_markup_percent=?,price_proof=NULL WHERE id=?',
      [local.price, local.cost, local.cost_pending, local.pricing_mode, local.target_markup_percent, product.id]);
  } else db.run('UPDATE products SET pending_price_receipt_uuid=NULL WHERE id=?', [product.id]);
}

function applyRegister(db, change, now, clientId, sucursalId) {
  if (change.action === 'DELETE' || !change.payload) {
    db.run('UPDATE cash_registers SET active=0,synced_at=? WHERE id=? AND client_id=? AND sucursal_id=?',
      [now, change.entityId, clientId, sucursalId]);
    return;
  }
  const register = change.payload;
  db.run(`INSERT INTO cash_registers
    (id,code,name,active,default_opening_float,blind_count_enabled,client_id,sucursal_id,
     external_pos_id,qr_url,point_device_id,created_at,synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,active=excluded.active,
      default_opening_float=excluded.default_opening_float,
      blind_count_enabled=excluded.blind_count_enabled,external_pos_id=excluded.external_pos_id,
      qr_url=excluded.qr_url,point_device_id=excluded.point_device_id,synced_at=excluded.synced_at`, [
    register.id, register.code || null, register.name, register.active === false ? 0 : 1,
    Number(register.defaultOpeningFloat || 0), register.blindCountEnabled ? 1 : 0,
    register.clientId || clientId, register.sucursalId || sucursalId, register.externalPosId || null,
    register.qrUrl || null, register.pointDeviceId || null, register.createdAt || null, now,
  ]);
}

function applyAck(db, outbox, result) {
  const body = result.result || {};
  const cloudId = result.cloudId || body.id || body.saleId || body.saleReturnId || null;
  switch (outbox.mutation_type) {
    case 'PURCHASE_RECEIPT':
    case 'PURCHASE_RECEIPT_AMOUNTS':
      require('./purchase-receipt-sync').acknowledge(db, outbox, body);
      break;
    case 'SALE': {
      const invoice = body.invoice || {};
      db.run(`UPDATE sales SET sync_status='synced',cloud_id=?,total_amount=COALESCE(?,total_amount),
        synced_at=datetime('now','localtime'),sync_error=NULL WHERE local_id=?`,
      [cloudId, typeof body.totalAmount === 'number' ? body.totalAmount : null, outbox.source_id]);
      if (invoice.emitida && invoice.cae && invoice.invoiceId) {
        return { invoiceId: invoice.invoiceId, numero: invoice.numeroFormateado || '', saleId: cloudId };
      }
      break;
    }
    case 'RETURN': {
      const fiscal = body.fiscalDocument || {};
      db.run(`UPDATE returns SET sync_status='synced',cloud_id=?,sale_cloud_id=COALESCE(sale_cloud_id,?),
        fiscal_status=?,fiscal_message=?,fiscal_invoice_id=?,fiscal_type=?,fiscal_number=?,
        fiscal_cae=?,fiscal_cae_expiration=?,fiscal_updated_at=?,fiscal_retryable=?,
        synced_at=datetime('now','localtime'),sync_error=NULL WHERE local_id=?`, [
        cloudId, body.saleId || null, fiscal.status || 'FAILED', fiscal.message || null,
        fiscal.invoiceId || null, fiscal.type || null, fiscal.number || null, fiscal.cae || null,
        fiscal.caeExpiration || null, fiscal.updatedAt || null, fiscal.retryable ? 1 : 0,
        outbox.source_id,
      ]);
      break;
    }
    case 'CASH_MOVEMENT':
      db.run(`UPDATE cash_movements SET sync_status='synced',cloud_id=?,
        synced_at=datetime('now','localtime'),sync_error=NULL WHERE local_id=?`,
      [cloudId, outbox.source_id]);
      break;
    case 'CASH_SESSION_OPEN':
      db.run(`UPDATE cash_sessions SET cloud_id=?,sync_status=CASE WHEN status='OPEN' THEN 'synced'
        ELSE sync_status END,sync_error=NULL WHERE id=?`, [cloudId, outbox.source_id]);
      break;
    case 'CASH_SESSION_CLOSE':
      db.run(`UPDATE cash_sessions SET cloud_id=COALESCE(?,cloud_id),sync_status='synced',
        synced_at=datetime('now','localtime'),sync_error=NULL WHERE id=?`,
      [cloudId, outbox.source_id]);
      break;
    default: break;
  }
  return null;
}

function retryDelaySeconds(attempts) {
  const base = Math.min(300, 15 * (2 ** Math.min(Math.max(0, attempts), 5)));
  return Math.min(300, Math.max(15, Math.round(base * (0.75 + Math.random() * 0.5))));
}

function applyResponse(db, response, clientId, sucursalId) {
  const delayedInvoices = [];
  const byKey = new Map(db.all(`SELECT * FROM sync_outbox
    WHERE (client_id IS NULL OR client_id=?) AND (sucursal_id IS NULL OR sucursal_id=?)`,
  [clientId, sucursalId]).map((row) => [row.idempotency_key, row]));
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const result of response.results || []) {
      const outbox = byKey.get(result.idempotencyKey);
      if (!outbox) continue;
      if (['APPLIED', 'APPLIED_WITH_WARNING', 'DUPLICATE'].includes(result.status)) {
        const delayed = applyAck(db, outbox, result);
        if (delayed) delayedInvoices.push(delayed);
        db.run(`INSERT INTO sync_log(action,detail,status) VALUES ('BUNDLE_ACK',?,?)`,
          [`${outbox.mutation_type}:${outbox.idempotency_key}:${result.warningCode || ''}`, 'ok']);
        db.run('DELETE FROM sync_outbox WHERE sequence=?', [outbox.sequence]);
      } else if (result.status === 'CONFLICT') {
        db.run(`UPDATE sync_outbox SET state='QUARANTINED',attempts=attempts+1,last_error=?,
          warning_code=?,updated_at=datetime('now') WHERE sequence=?`,
        [result.message || result.errorCode || 'Conflicto', result.errorCode || null, outbox.sequence]);
        const conflictTargets = {
          sales: ['sales', 'local_id'], returns: ['returns', 'local_id'],
          cash_movements: ['cash_movements', 'local_id'], cash_sessions: ['cash_sessions', 'id'],
          purchase_receipts: ['purchase_receipts', 'local_id'], purchase_receipt_amendments: ['purchase_receipt_amendments', 'local_id'],
        };
        const target = conflictTargets[outbox.source_table];
        if (target) db.run(`UPDATE ${target[0]} SET sync_status='needs_review',sync_error=?
          WHERE ${target[1]}=?`, [result.message || result.errorCode || 'Conflicto', outbox.source_id]);
      } else {
        const attempts = Number(outbox.attempts || 1);
        const delay = retryDelaySeconds(attempts - 1);
        db.run(`UPDATE sync_outbox SET state='PENDING',attempts=?,last_error=?,
          next_retry_at=datetime('now',?),updated_at=datetime('now') WHERE sequence=?`,
        [attempts, result.message || result.errorCode || 'Error transitorio', `+${delay} seconds`, outbox.sequence]);
      }
    }

    for (const deferred of db.all('SELECT key,value FROM app_config WHERE key LIKE ?', [`deferred_receipt_product:${clientId}:${sucursalId}:%`])) {
      const change = JSON.parse(deferred.value);
      const priceReference = db.get('SELECT pending_price_receipt_uuid FROM products WHERE id=? AND client_id=? AND sucursal_id=?', [change.payload.id, clientId, sucursalId])?.pending_price_receipt_uuid;
      if (!db.get('SELECT 1 FROM products WHERE client_id=? AND sucursal_id=? AND client_product_uuid=? AND id<0', [clientId, sucursalId, change.payload.clientProductUuid || null])
          && !pendingReceiptQuantity(db, change.payload.id, clientId, sucursalId)
          && (!priceReference || !db.get('SELECT 1 FROM sync_outbox WHERE client_id=? AND sucursal_id=? AND idempotency_key=?', [clientId, sucursalId, priceReference]))) {
        applyProduct(db, change, now, clientId, sucursalId); db.run('DELETE FROM app_config WHERE key=?', [deferred.key]);
      }
    }
    if (response.resetRequired) {
      db.run('DELETE FROM sync_snapshot_changes WHERE client_id=? AND sucursal_id=?', [clientId, sucursalId]);
      db.run('UPDATE sync_state SET snapshot_in_progress=1 WHERE client_id=? AND sucursal_id=?', [clientId, sucursalId]);
    }
    const snapshot = db.get('SELECT snapshot_in_progress FROM sync_state WHERE client_id=? AND sucursal_id=?', [clientId, sucursalId])?.snapshot_in_progress;
    let changes = response.changes || [];
    if (snapshot) {
      for (const change of changes) db.run(`INSERT OR REPLACE INTO sync_snapshot_changes
        (client_id,sucursal_id,entity_type,entity_id,change_json) VALUES (?,?,?,?,?)`,
      [clientId, sucursalId, change.entityType, change.entityId, JSON.stringify(change)]);
      changes = [];
    }
    if (snapshot && !response.hasMore) {
      changes = db.all('SELECT change_json FROM sync_snapshot_changes WHERE client_id=? AND sucursal_id=?',
        [clientId, sucursalId]).map((row) => JSON.parse(row.change_json));
      db.run('UPDATE products SET active=0 WHERE client_id=? AND sucursal_id=? AND id>0', [clientId, sucursalId]);
      db.run('UPDATE cash_registers SET active=0 WHERE client_id=? AND sucursal_id=?', [clientId, sucursalId]);
      db.run('UPDATE expense_categories SET active=0 WHERE client_id=? AND sucursal_id=?', [clientId, sucursalId]);
      db.run('DELETE FROM sync_snapshot_changes WHERE client_id=? AND sucursal_id=?', [clientId, sucursalId]);
      db.run('UPDATE sync_state SET snapshot_in_progress=0 WHERE client_id=? AND sucursal_id=?', [clientId, sucursalId]);
    }
    for (const change of changes) {
      if (change.entityType === 'PRODUCT') applyProduct(db, change, now, clientId, sucursalId);
      else if (change.entityType === 'REGISTER') applyRegister(db, change, now, clientId, sucursalId);
      else if (change.entityType === 'SCALE_SETTINGS' && change.payload) {
        db.run('INSERT OR REPLACE INTO app_config(key,value) VALUES (?,?)',
          [`scale_settings:${clientId}:${sucursalId}`, JSON.stringify(change.payload)]);
      } else if (change.entityType === 'EXPENSE_CATEGORIES' && change.payload) {
        db.run('UPDATE expense_categories SET active=0 WHERE client_id=? AND sucursal_id=?', [clientId, sucursalId]);
        for (const category of change.payload) db.run(`INSERT OR REPLACE INTO expense_categories
          (id,client_id,sucursal_id,name,active) VALUES (?,?,?,?,?)`,
        [category.id, clientId, sucursalId, category.name, category.active === false ? 0 : 1]);
      }
    }
    db.run(`UPDATE sync_state SET cursor=?,last_success_at=?,last_error=NULL
             WHERE client_id=? AND sucursal_id=?`,
    [response.nextCursor || null, now, clientId, sucursalId]);
    db.run("INSERT OR REPLACE INTO app_config(key,value) VALUES ('last_product_sync',?)", [now]);
  });
  return delayedInvoices;
}

class BundleSyncV2 {
  constructor(apiClient) {
    this.apiClient = apiClient;
  }

  async sync({ uploadMutations = true, urgent = false, cashStateOnly = false } = {}) {
    const db = getDb();
    const clientId = Number(this.apiClient.clientId);
    const sucursalId = Number(this.apiClient.sucursalId);
    const token = this.apiClient.token;
    const epoch = this.apiClient.authEpoch;
    const assertIdentity = () => {
      if (epoch !== this.apiClient.authEpoch || token !== this.apiClient.token
          || clientId !== Number(this.apiClient.clientId) || sucursalId !== Number(this.apiClient.sucursalId)) {
        const error = new Error('La identidad cambió durante la sincronización');
        error.code = 'SYNC_IDENTITY_CHANGED';
        throw error;
      }
    };
    const state = getSyncState(db, clientId, sucursalId);
    let cursor = state.cursor || null;
    let mutationCount = 0;
    let changeCount = 0;
    let delayedInvoices = [];
    let catalogHasMore = false;
    let lastBatchSize = 0;
    const pending = (urgent || cashStateOnly) && uploadMutations ? db.get(`SELECT MAX(sequence) max_sequence, COUNT(*) count
      FROM sync_outbox WHERE (client_id IS NULL OR client_id=?) AND (sucursal_id IS NULL OR sucursal_id=?)`, [clientId, sucursalId]) : null;
    const urgentBatch = pending ? { maxSequence: Number(pending.max_sequence || 0), attempted: new Set(), cashStateOnly } : null;
    // A close drains the original queue, even beyond 20 batches. Each row is attempted only
    // once per cycle, so a retryable error cannot cause an unbounded busy loop.
    const maxPages = MAX_PAGES_PER_CYCLE + Number(pending?.count || 0);

    for (let page = 0; page < maxPages; page++) {
      assertIdentity();
      const base = {
        protocolVersion: 2,
        deviceId: state.device_id,
        requestId: crypto.randomUUID(),
        cursor,
      };
      const batch = uploadMutations ? dueMutations(db, clientId, sucursalId, base, urgentBatch) : { mutations: [], selected: [] };
      for (const sequence of batch.selected) urgentBatch?.attempted.add(sequence);
      lastBatchSize = batch.mutations.length;
      if (batch.selected.length) {
        db.transaction(() => {
          for (const sequence of batch.selected) {
            db.run(`UPDATE sync_outbox SET state='IN_FLIGHT',attempts=attempts+1,
              updated_at=datetime('now') WHERE sequence=?`, [sequence]);
          }
        });
      }

      let response;
      try {
        response = await this.apiClient.syncBundle({ ...base, mutations: batch.mutations });
        assertIdentity();
      } catch (error) {
        if (batch.selected.length) {
          db.transaction(() => {
            for (const sequence of batch.selected) {
              const row = db.get('SELECT attempts FROM sync_outbox WHERE sequence=?', [sequence]);
              const delay = retryDelaySeconds(Number(row?.attempts || 1) - 1);
              db.run(`UPDATE sync_outbox SET state='PENDING',last_error=?,next_retry_at=datetime('now',?),
                updated_at=datetime('now') WHERE sequence=?`,
              [String(error.message || 'Error de red').slice(0, 1000), `+${delay} seconds`, sequence]);
            }
          });
        }
        throw error;
      }
      // An omitted result is not an ACK. Return it to the durable retry queue.
      const returnedKeys = new Set((response.results || []).map((r) => r.idempotencyKey));
      response.results = [...(response.results || []), ...batch.mutations
        .filter((m) => !returnedKeys.has(m.idempotencyKey))
        .map((m) => ({ idempotencyKey: m.idempotencyKey, status: 'RETRYABLE', errorCode: 'ACK_MISSING' }))];
      delayedInvoices = delayedInvoices.concat(applyResponse(db, response, clientId, sucursalId));
      mutationCount += (response.results || []).filter((r) =>
        ['APPLIED', 'APPLIED_WITH_WARNING', 'DUPLICATE'].includes(r.status)).length;
      changeCount += (response.changes || []).length;
      cursor = response.nextCursor || cursor;
      catalogHasMore = !!response.hasMore;
      if (!catalogHasMore && !batch.mutations.length) break;
      if (!catalogHasMore && !dueMutations(db, clientId, sucursalId, base, urgentBatch).mutations.length) break;
    }
    const next = db.get(`SELECT COUNT(*) n,
      MIN(CASE WHEN next_retry_at IS NULL THEN datetime('now','+1 seconds') ELSE next_retry_at END) retry_at
      FROM sync_outbox WHERE state='PENDING' AND client_id=? AND sucursal_id=?`, [clientId, sucursalId]);
    const retryDelayMs = catalogHasMore ? 1000 : next?.n
      ? Math.max(lastBatchSize ? 1000 : 30000, Math.min(300000, Date.parse(next.retry_at.replace(' ', 'T') + 'Z') - Date.now())) : null;
    return { mutationCount, changeCount, delayedInvoices, retryDelayMs, clientId, sucursalId };
  }
}

module.exports = {
  BundleSyncV2,
  canonicalJson,
  sha256,
  retryDelaySeconds,
  MAX_MUTATIONS,
  MAX_REQUEST_BYTES,
  freezeNewMutations,
  pendingStockDelta,
};
