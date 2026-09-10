'use strict';
const crypto = require('crypto');
const { canonicalJson, sha256 } = require('./sync-bundle-v2');
const pricing = require('./purchase-pricing');

function error(status, message) { const e = new Error(message); e.status = status; return e; }
function uuid(value) { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw error(400, 'UUID inválido'); }
function money(value, signed = false) {
  if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || (!signed && value < 0)
    || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(Math.round(value * 100) - value * 100) > 0.001)) throw error(400, 'Importe inválido');
}
function now() { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()).replace(' ', 'T'); }
function featureKey(scope) { return `receipt_capabilities:${scope.clientId}:${scope.branchId}`; }
function capabilities(db, scope) {
  try { return JSON.parse(db.get('SELECT value FROM app_config WHERE key=?', [featureKey(scope)])?.value || '{}'); } catch { return {}; }
}
function requireEnabled(db, scope) { if (!capabilities(db, scope).enabled) throw error(409, 'El ingreso ágil requiere una primera conexión con el negocio habilitado'); }
function find(db, scope, id) { uuid(id); return db.get('SELECT * FROM purchase_receipts WHERE client_id=? AND sucursal_id=? AND uuid=?', [scope.clientId, scope.branchId, id]); }
function view(row, db) {
  const result = JSON.parse(row.receipt_json);
  result.draft = row.draft_json ? JSON.parse(row.draft_json) : null;
  result.syncStatus = row.sync_status === 'synced' ? 'SYNCED' : row.sync_status === 'needs_review' ? 'REVIEW_REQUIRED' : 'PENDING';
  result.syncError = row.sync_error || null;
  const pending = db?.get("SELECT sync_status,sync_error FROM purchase_receipt_amendments WHERE receipt_local_id=? AND sync_status<>'synced' ORDER BY CASE WHEN sync_status='needs_review' THEN 0 ELSE 1 END,local_id LIMIT 1", [row.local_id]);
  if (pending) { result.syncStatus = pending.sync_status === 'needs_review' ? 'REVIEW_REQUIRED' : 'PENDING'; result.syncError = pending.sync_error || result.syncError; }
  return result;
}
function get(db, scope, id) { const row = find(db, scope, id); if (!row) throw error(404, 'Ingreso no encontrado'); return view(row, db); }
function list(db, scope, page = 0, size = 30) {
  const offset = Math.max(0, Math.trunc(Number(page) || 0)) * size;
  const total = db.get('SELECT COUNT(*) n FROM purchase_receipts WHERE client_id=? AND sucursal_id=?', [scope.clientId, scope.branchId]).n;
  return { content: db.all('SELECT * FROM purchase_receipts WHERE client_id=? AND sucursal_id=? ORDER BY created_at DESC,local_id DESC LIMIT ? OFFSET ?', [scope.clientId, scope.branchId, size, offset]).map(row => view(row, db)), totalPages: Math.ceil(total / size) };
}
function empty(scope, id) {
  return { uuid: id, version: 0, clientId: scope.clientId, sucursalId: scope.branchId, employeeId: scope.employeeId,
    providerId: null, providerName: null, state: 'DRAFT', amountStatus: 'AMOUNT_PENDING', costStatus: 'COSTS_PENDING',
    syncStatus: 'PENDING', receivedAt: null, createdAt: now(), totalAmount: null, adjustmentAmount: null, adjustmentReason: null,
    notes: null, documentUuid: null, expenseId: null, lines: [], draft: null };
}
function saveDraft(db, scope, id, draft) {
  uuid(id); requireEnabled(db, scope);
  if (!draft || draft.uuid !== id || JSON.stringify(draft).length > 500000) throw error(400, 'Borrador inválido');
  return db.transaction(() => {
    const previous = find(db, scope, id);
    if (previous?.state === 'CONFIRMED') throw error(409, 'El ingreso ya está confirmado');
    if (previous) db.run('UPDATE purchase_receipts SET draft_json=? WHERE local_id=?', [JSON.stringify(draft), previous.local_id]);
    else db.run(`INSERT INTO purchase_receipts(uuid,client_id,sucursal_id,employee_id,draft_json,receipt_json,created_at)
      VALUES (?,?,?,?,?,?,?)`, [id, scope.clientId, scope.branchId, scope.employeeId, JSON.stringify(draft), JSON.stringify(empty(scope, id)), now()]);
    return get(db, scope, id);
  });
}
function resolveProduct(db, scope, input) {
  let product;
  if (input.clientProductUuid) {
    uuid(input.clientProductUuid);
    const reference = db.get('SELECT local_product_id,remote_product_id FROM product_client_references WHERE client_id=? AND sucursal_id=? AND client_product_uuid=?', [scope.clientId, scope.branchId, input.clientProductUuid]);
    product = reference ? db.get('SELECT * FROM products WHERE id=? AND client_id=? AND sucursal_id=? AND active=1', [reference.remote_product_id || reference.local_product_id, scope.clientId, scope.branchId])
      : db.get('SELECT * FROM products WHERE client_product_uuid=? AND client_id=? AND sucursal_id=? AND active=1', [input.clientProductUuid, scope.clientId, scope.branchId]);
  }
  if (input.productId != null && !product) product = db.get('SELECT * FROM products WHERE id=? AND client_id=? AND sucursal_id=? AND active=1', [input.productId, scope.clientId, scope.branchId]);
  if (!product && input.newProduct) {
    const definition = input.newProduct;
    uuid(definition.clientProductUuid);
    if (definition.clientProductUuid !== input.clientProductUuid || typeof definition.name !== 'string' || !definition.name.trim() || definition.name.length > 255
      || (!definition.noCode && (typeof definition.code !== 'string' || !definition.code.trim() || definition.code.length > 128))) throw error(400, 'Revisá el nombre y código del producto nuevo');
    money(definition.price); if (definition.price == null) throw error(400, 'Falta el precio del producto nuevo');
    if (!definition.noCode && db.get('SELECT id FROM products WHERE client_id=? AND sucursal_id=? AND code=?', [scope.clientId, scope.branchId, definition.code.trim()])) throw error(409, 'El código ya existe en esta sucursal. Elegí el producto del inventario');
    const id = Math.min(0, Number(db.get('SELECT MIN(id) n FROM products').n || 0),
      Number(db.get('SELECT MIN(local_product_id) n FROM product_client_references').n || 0)) - 1;
    db.run(`INSERT INTO products(id,client_id,sucursal_id,client_product_uuid,code,no_code,stock_tracked,name,price,cost,cost_pending,quantity,cloud_quantity,active)
      VALUES (?,?,?,?,?,?,1,?,?,0,1,0,0,1)`, [id, scope.clientId, scope.branchId, definition.clientProductUuid, definition.noCode ? null : definition.code.trim(), definition.noCode ? 1 : 0, definition.name.trim(), definition.price]);
    db.run('INSERT INTO product_client_references(client_id,sucursal_id,client_product_uuid,local_product_id) VALUES (?,?,?,?)', [scope.clientId, scope.branchId, definition.clientProductUuid, id]);
    product = db.get('SELECT * FROM products WHERE id=?', [id]);
  }
  if (!product) throw error(409, 'Producto no disponible. Revisá su correspondencia');
  if (product.weighable || !product.stock_tracked) throw error(400, 'Este ingreso requiere productos con stock por unidades');
  return product;
}
function applyPrice(db, scope, product, cost, input) {
  const decision = input.priceDecision || 'KEEP';
  if (!['KEEP', 'ACCEPT', 'REVIEWED'].includes(decision)) throw error(400, 'Revisá la decisión de precio');
  if (cost == null) { if (decision !== 'KEEP') throw error(400, 'Falta el costo para aplicar un precio'); return; }
  if (!input.reviewed) throw error(400, 'Revisá los importes');
  if (canonicalJson(input.expectedPricing) !== canonicalJson(pricing.snapshot(product))) throw error(409, `El costo o precio de ${product.name} cambió. Revisá la propuesta`);
  let price = Number(product.price);
  if (decision !== 'KEEP') {
    if (!scope.canPrice) throw error(403, 'No tenés permisos para cambiar precios');
    price = decision === 'ACCEPT' ? pricing.propose(input.expectedPricing, cost) : input.reviewedSalePrice;
    money(price); if (price == null) throw error(400, 'El precio necesita una revisión específica');
    if (product.pricing_mode === 'MARKUP' && price !== pricing.roundedMarkupPrice(cost, product.target_markup_percent)) throw error(400, 'El precio debe respetar el porcentaje configurado');
  }
  db.run('UPDATE products SET cost=?,cost_pending=0,cost_derived=0,price=? WHERE id=?', [cost, price, product.id]);
  product.cost = cost; product.cost_pending = 0; product.price = price;
}
function reconcile(receipt) {
  money(receipt.totalAmount); money(receipt.adjustmentAmount, true);
  if (receipt.adjustmentAmount && !receipt.adjustmentReason?.trim()) throw error(400, 'Explicá el ajuste');
  const lines = receipt.lines.filter(line => line.decision === 'RECEIVE');
  receipt.amountStatus = receipt.totalAmount == null ? 'AMOUNT_PENDING' : 'COMPLETE';
  receipt.costStatus = lines.some(line => line.lineAmount == null || line.priceDecision === 'REVIEW_REQUIRED') ? 'COSTS_PENDING' : 'COMPLETE';
  if (receipt.totalAmount != null && lines.every(line => line.lineAmount != null)) {
    const sum = lines.reduce((n, line) => n + Math.round(line.lineAmount * 100), 0) + Math.round((receipt.adjustmentAmount || 0) * 100);
    if (sum !== Math.round(receipt.totalAmount * 100)) throw error(400, 'El total no coincide. Revisá el ajuste o dejá el importe pendiente');
  }
}
function wireReceipt(request, db, scope) {
  const copy = JSON.parse(JSON.stringify(request));
  for (const line of copy.lines) if (line.productId != null && Number(line.productId) < 0) {
    if (line.clientProductUuid) { uuid(line.clientProductUuid); line.productId = null; continue; }
    const product = db.get('SELECT client_product_uuid FROM products WHERE id=? AND client_id=? AND sucursal_id=?', [line.productId, scope.clientId, scope.branchId]);
    if (!product?.client_product_uuid) throw error(409, 'El producto local no tiene referencia estable');
    line.productId = null; line.clientProductUuid = product.client_product_uuid;
  }
  return copy;
}
function confirm(db, scope, request) {
  uuid(request?.uuid); requireEnabled(db, scope);
  if (!Array.isArray(request.lines) || !request.lines.length || request.lines.length > 500) throw error(400, 'Ingresá entre 1 y 500 líneas');
  return db.transaction(() => {
    const original = canonicalJson(request), hash = sha256(original);
    let row = find(db, scope, request.uuid);
    if (row?.state === 'CONFIRMED') {
      if (row.request_hash !== hash) throw error(409, 'Este ingreso ya confirmó otro contenido');
      return view(row, db);
    }
    const receipt = { ...empty(scope, request.uuid), ...request, clientId: scope.clientId, sucursalId: scope.branchId, employeeId: scope.employeeId,
      state: 'CONFIRMED', receivedAt: request.receivedAt || now(), lines: [] };
    const groups = new Map(), inputs = new Map();
    for (const input of request.lines) {
      uuid(input.uuid); if (inputs.has(input.uuid)) throw error(400, 'Línea repetida'); inputs.set(input.uuid, input); money(input.lineAmount);
      if (input.decision === 'EXCLUDE') {
        if (!input.exclusionReason?.trim()) throw error(400, 'Explicá las líneas excluidas');
        receipt.lines.push({ ...input, receivedUnits: null, productName: input.sourceDescription || '', unitCost: null }); continue;
      }
      if (input.decision !== 'RECEIVE' || !input.reviewed || !Number.isInteger(input.invoiceQuantity) || input.invoiceQuantity <= 0 || !Number.isInteger(input.unitsPerPack) || input.unitsPerPack <= 0
        || input.invoiceQuantity * input.unitsPerPack > 2147483647) throw error(400, 'Revisá el producto y sus cantidades enteras');
      const product = resolveProduct(db, scope, input);
      const line = { ...input, productId: product.id, clientProductUuid: input.clientProductUuid || product.client_product_uuid || null,
        productName: product.name, receivedUnits: input.invoiceQuantity * input.unitsPerPack,
        unitCost: pricing.unitCost(input.lineAmount, input.invoiceQuantity, input.unitsPerPack), previousCost: product.cost_pending ? null : product.cost,
        previousPrice: product.price, appliedPrice: product.price, markupPercent: null, stockBefore: null, stockAfter: null };
      receipt.lines.push(line);
      if (!groups.has(product.id)) groups.set(product.id, { product, lines: [] }); groups.get(product.id).lines.push(line);
    }
    if (!groups.size) throw error(400, 'Agregá al menos un producto');
    reconcile(receipt);
    for (const { product, lines } of groups.values()) {
      const input = inputs.get(lines[0].uuid);
      for (const line of lines) {
        const other = inputs.get(line.uuid);
        if (canonicalJson([other.priceDecision, other.expectedPricing, other.reviewedSalePrice]) !== canonicalJson([input.priceDecision, input.expectedPricing, input.reviewedSalePrice])) throw error(400, 'Unificá la decisión de precio para las líneas del mismo producto');
      }
      const units = lines.reduce((n, line) => n + line.receivedUnits, 0);
      if (!Number.isSafeInteger(units) || Number(product.quantity) + units > 2147483647) throw error(400, 'Cantidad fuera de rango');
      const cost = lines.some(line => line.lineAmount == null) ? null : pricing.unitCost(lines.reduce((n, line) => n + line.lineAmount, 0), units);
      applyPrice(db, scope, product, cost, input);
      if (input.newProduct || (input.priceDecision && input.priceDecision !== 'KEEP')) db.run('UPDATE products SET pending_price_receipt_uuid=? WHERE id=?', [request.uuid, product.id]);
      let running = Number(product.quantity);
      for (const line of lines) { line.stockBefore = running; running += line.receivedUnits; line.stockAfter = running; line.appliedPrice = product.price; }
      db.run('UPDATE products SET quantity=quantity+? WHERE id=? AND client_id=? AND sucursal_id=?', [units, product.id, scope.clientId, scope.branchId]);
    }
    if (!row) {
      const inserted = db.run('INSERT INTO purchase_receipts(uuid,client_id,sucursal_id,employee_id,receipt_json,created_at) VALUES (?,?,?,?,?,?)', [request.uuid, scope.clientId, scope.branchId, scope.employeeId, JSON.stringify(receipt), receipt.createdAt]);
      row = { local_id: inserted.lastId };
    }
    const wire = wireReceipt(request, db, scope);
    db.run("UPDATE purchase_receipts SET state='CONFIRMED',draft_json=NULL,request_json=?,request_hash=?,receipt_json=?,employee_id=?,sync_status='pending' WHERE local_id=?", [JSON.stringify(wire), hash, JSON.stringify(receipt), scope.employeeId, row.local_id]);
    for (const line of receipt.lines) if (line.decision === 'RECEIVE') db.run('INSERT INTO purchase_receipt_lines(receipt_local_id,uuid,product_id,client_product_uuid,quantity) VALUES (?,?,?,?,?)', [row.local_id, line.uuid, line.productId, line.clientProductUuid, line.receivedUnits]);
    const payload = canonicalJson({ employeeId: scope.employeeId, receipt: wire });
    db.run(`INSERT INTO sync_outbox(mutation_type,idempotency_key,source_table,source_id,occurred_at,client_id,sucursal_id,payload_json,payload_hash)
      VALUES ('PURCHASE_RECEIPT',?,'purchase_receipts',?,?,?,?,?,?)`, [request.uuid, row.local_id, receipt.receivedAt, scope.clientId, scope.branchId, payload, sha256(payload)]);
    return get(db, scope, request.uuid);
  });
}

function complete(db, scope, receiptUuid, request) {
  uuid(request?.mutationUuid);
  return db.transaction(() => {
    const row = find(db, scope, receiptUuid); if (!row || row.state !== 'CONFIRMED') throw error(404, 'Ingreso confirmado no encontrado');
    const canonical = canonicalJson(request), hash = sha256(canonical);
    const previous = db.get('SELECT * FROM purchase_receipt_amendments WHERE client_id=? AND sucursal_id=? AND uuid=?', [scope.clientId, scope.branchId, request.mutationUuid]);
    if (previous) { if (previous.payload_hash !== hash || previous.receipt_local_id !== row.local_id) throw error(409, 'El UUID de actualización ya tiene otro contenido'); return view(row, db); }
    const receipt = view(row, db);
    if (receipt.version !== request.expectedVersion) throw error(409, 'El ingreso cambió. Recargá antes de completar importes');
    money(request.totalAmount); money(request.adjustmentAmount, true);
    if (request.totalAmount != null) receipt.totalAmount = request.totalAmount;
    if (request.adjustmentAmount != null) { receipt.adjustmentAmount = request.adjustmentAmount; receipt.adjustmentReason = request.adjustmentReason; }
    if (request.providerId != null) receipt.providerId = request.providerId;
    const changes = new Map();
    for (const change of request.lines || []) {
      const line = receipt.lines.find(item => item.uuid === change.lineUuid && item.decision === 'RECEIVE');
      if (!line || changes.has(change.lineUuid)) throw error(400, 'Línea ajena al ingreso o repetida');
      money(change.lineAmount); if (change.lineAmount == null) throw error(400, 'Falta el importe de la línea');
      line.lineAmount = change.lineAmount; line.unitCost = pricing.unitCost(change.lineAmount, line.invoiceQuantity, line.unitsPerPack); changes.set(change.lineUuid, change);
    }
    const productIds = [...new Set(receipt.lines.filter(line => changes.has(line.uuid)).map(line => line.productId))];
    for (const productId of productIds) {
      const lines = receipt.lines.filter(line => line.productId === productId && line.decision === 'RECEIVE');
      const input = changes.get(lines.find(line => changes.has(line.uuid)).uuid);
      for (const line of lines) {
        const other = changes.get(line.uuid);
        if (other && canonicalJson([other.priceDecision, other.expectedPricing, other.reviewedSalePrice]) !== canonicalJson([input.priceDecision, input.expectedPricing, input.reviewedSalePrice])) throw error(400, 'Unificá la revisión de precio del producto');
      }
      const units = lines.reduce((n, line) => n + line.receivedUnits, 0);
      const cost = lines.some(line => line.lineAmount == null) ? null : pricing.unitCost(lines.reduce((n, line) => n + line.lineAmount, 0), units);
      const product = db.get('SELECT * FROM products WHERE id=? AND client_id=? AND sucursal_id=? AND active=1', [productId, scope.clientId, scope.branchId]);
      if (!product) throw error(409, 'El producto ya no está activo. Revisá sus importes');
      applyPrice(db, scope, product, cost, input);
      if (input.priceDecision && input.priceDecision !== 'KEEP') db.run('UPDATE products SET pending_price_receipt_uuid=? WHERE id=?', [request.mutationUuid, product.id]);
      for (const line of lines) { line.priceDecision = input.priceDecision || 'KEEP'; line.appliedPrice = product.price; }
    }
    reconcile(receipt); receipt.version += 1;
    db.run('UPDATE purchase_receipts SET receipt_json=? WHERE local_id=?', [JSON.stringify(receipt), row.local_id]);
    const amendment = db.run('INSERT INTO purchase_receipt_amendments(receipt_local_id,uuid,client_id,sucursal_id,employee_id,payload_json,payload_hash,created_at) VALUES (?,?,?,?,?,?,?,?)', [row.local_id, request.mutationUuid, scope.clientId, scope.branchId, scope.employeeId, canonical, hash, now()]);
    const predecessor = db.get("SELECT uuid FROM purchase_receipt_amendments WHERE receipt_local_id=? AND local_id<? AND sync_status<>'synced' ORDER BY local_id DESC LIMIT 1", [row.local_id, amendment.lastId]);
    const payload = canonicalJson({ employeeId: scope.employeeId, receiptUuid, amounts: request,
      baseMutationUuid: predecessor?.uuid || (row.sync_status !== 'synced' ? receiptUuid : undefined) });
    db.run(`INSERT INTO sync_outbox(mutation_type,idempotency_key,source_table,source_id,occurred_at,client_id,sucursal_id,payload_json,payload_hash)
      VALUES ('PURCHASE_RECEIPT_AMOUNTS',?,'purchase_receipt_amendments',?,?,?,?,?,?)`, [request.mutationUuid, amendment.lastId, now(), scope.clientId, scope.branchId, payload, sha256(payload)]);
    return get(db, scope, receiptUuid);
  });
}
module.exports = { capabilities, featureKey, get, list, saveDraft, confirm, complete, view, error };
