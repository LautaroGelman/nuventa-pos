// ============================================================
// Durable receipt corrections. Original stock rows remain immutable.
// ============================================================
'use strict';
const pricing = require('./purchase-pricing');
const { canonicalJson, sha256 } = require('./sync-bundle-v2');
const error = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()).replace(' ', 'T');
const uuid = value => { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw error(400, 'UUID inválido'); };
const clone = value => JSON.parse(JSON.stringify(value));
function snapshot(product) { return { pricing: pricing.snapshot(product), costDerived: !!product.cost_derived, revision: Number(product.pricing_revision || 0) }; }
function recordPricing(db, receipt, id, before, initial, operationUuid, employeeId) {
  db.run('UPDATE products SET pricing_revision=pricing_revision+1 WHERE id=?', [id]);
  receipt.pricingEffects ||= {};
  const prior = receipt.pricingEffects[id];
  receipt.pricingEffects[id] = { baseline: prior ? prior.baseline : initial ? before : null,
    applied: snapshot(db.get('SELECT * FROM products WHERE id=?', [id])), pending: prior?.pending || null, reason: prior?.reason || null,
    applications: [...(prior?.applications || []), {before,after:snapshot(db.get('SELECT * FROM products WHERE id=?',[id])),operationUuid,employeeId,createdAt:now()}] };
}
function allocatedAmounts(receipt) {
  const lines = receipt.lines.filter(l => l.decision === 'RECEIVE');
  const amounts = lines.map(l => l.lineAmount);
  const total = amounts.reduce((n,a) => n + BigInt(Math.round((a || 0) * 100)), 0n);
  const adjustment = BigInt(Math.round((receipt.adjustmentAmount || 0) * 100));
  let cumulative = 0n, allocated = 0n;
  const enabled = receipt.includeAdjustmentInCost && total > 0n && amounts.every(a => a != null);
  if (enabled && total + adjustment < 0n) throw error(400, 'El descuento supera el importe de mercadería');
  return new Map(lines.map(line => {
    let value = line.lineAmount;
    if (enabled) {
      cumulative += BigInt(Math.round(value * 100)); const numerator = cumulative * adjustment;
      const next = (numerator < 0n ? -1n : 1n) * ((numerator < 0n ? -numerator : numerator) * 2n + total) / (total * 2n);
      value = Number(BigInt(Math.round(value * 100)) + next - allocated) / 100; allocated = next;
    }
    return [line.uuid, value];
  }));
}
function lineSnapshot(line) {
  return { uuid: line.uuid, productId: line.productId, clientProductUuid: line.clientProductUuid || null, productName: line.productName,
    invoiceQuantity: line.invoiceQuantity, unitsPerPack: line.unitsPerPack, receivedUnits: line.receivedUnits,
    stockState: line.stockState || 'ACTIVE', packSize: line.packSize || null, salePresentation: line.salePresentation || null };
}
function requestRow(db, scope, receiptUuid) {
  const row = db.get('SELECT * FROM purchase_receipts WHERE uuid=? AND client_id=? AND sucursal_id=?', [receiptUuid, scope.clientId, scope.branchId]);
  if (!row || row.state !== 'CONFIRMED') throw error(404, 'Ingreso confirmado no encontrado');
  return row;
}
function prepare(db, scope, receiptUuid, lineUuid, request) {
  uuid(receiptUuid); uuid(lineUuid); uuid(request?.mutationUuid);
  if (!require('./purchase-receipts').capabilities(db, scope).receiptCorrections) throw error(409, 'Conectate una vez con el backend compatible para habilitar las correcciones');
  if (!['UNDO', 'CORRECT', 'REVIEW_PRICING'].includes(request.action)) throw error(400, 'Elegí una corrección válida');
  if (request.note != null && (typeof request.note !== 'string' || request.note.length > 500)) throw error(400, 'Detalle inválido');
  const row = requestRow(db, scope, receiptUuid), receipt = require('./purchase-receipts').view(row, db);
  if (receipt.version !== request.expectedVersion) throw error(409, 'El ingreso cambió. Recargá su detalle');
  const line = receipt.lines.find(l => l.uuid === lineUuid && l.decision === 'RECEIVE');
  if (!line) throw error(404, 'Línea no encontrada');
  const beforeLine = lineSnapshot(line), afterLine = clone(beforeLine), effects = receipt.pricingEffects || {};
  const deltas = new Map(), ids = new Set(), review = request.action === 'REVIEW_PRICING';
  let destination = null;
  if (review) {
    if (!scope.canPrice) throw error(403, 'Un dueño o administrador debe revisar los precios');
    Object.entries(effects).filter(([,e]) => e.reason).forEach(([id]) => ids.add(Number(id)));
    if (!ids.size) throw error(409, 'No quedan costos o precios pendientes de revisión');
  } else {
    ids.add(line.productId); deltas.set(line.productId, line.stockState === 'REVERSED' ? 0 : -line.receivedUnits);
    if (request.action === 'UNDO') {
      if (line.stockState === 'REVERSED') throw error(409, 'Este renglón ya está deshecho');
      afterLine.stockState = 'REVERSED';
    } else {
      if (![request.invoiceQuantity, request.unitsPerPack].every(n => Number.isInteger(n) && n > 0) || request.invoiceQuantity * request.unitsPerPack > 2147483647) throw error(400, 'Cantidad y unidades por pack deben ser enteros positivos dentro de rango');
      if (request.packSize != null && (!Number.isInteger(request.packSize) || request.packSize < 1 || request.packSize > 10000)) throw error(400, 'Contenido del pack inválido');
      if (request.salePresentation != null && (!['UNIT', 'PACK'].includes(request.salePresentation) || request.packSize == null || request.unitsPerPack !== (request.salePresentation === 'PACK' ? 1 : request.packSize))) throw error(400, 'La presentación no coincide con las unidades por pack');
      destination = request.productId;
      if (request.clientProductUuid) {
        const ref = db.get('SELECT local_product_id,remote_product_id FROM product_client_references WHERE client_id=? AND sucursal_id=? AND client_product_uuid=?', [scope.clientId, scope.branchId, request.clientProductUuid]);
        const p = db.get('SELECT id FROM products WHERE client_id=? AND sucursal_id=? AND client_product_uuid=?', [scope.clientId, scope.branchId, request.clientProductUuid]);
        const resolved = ref?.remote_product_id || ref?.local_product_id || p?.id;
        if (resolved == null || (destination != null && destination !== resolved && destination !== ref?.local_product_id)) throw error(409, 'La referencia del producto necesita revisión');
        destination = resolved;
      }
      if (!Number.isInteger(destination) || !destination) throw error(400, 'Seleccioná el producto de destino');
      ids.add(destination); deltas.set(destination, (deltas.get(destination) || 0) + request.invoiceQuantity * request.unitsPerPack);
      Object.assign(afterLine, { productId: destination, invoiceQuantity: request.invoiceQuantity, unitsPerPack: request.unitsPerPack, receivedUnits: request.invoiceQuantity * request.unitsPerPack,
        stockState: 'ACTIVE', packSize: request.packSize || null, salePresentation: request.salePresentation || null });
    }
  }
  const products = new Map([...ids].sort((a,b) => a-b).map(id => {
    const p = db.get('SELECT * FROM products WHERE id=? AND client_id=? AND sucursal_id=?', [id, scope.clientId, scope.branchId]);
    if (!p) throw error(409, 'Producto no disponible en esta sucursal'); return [id,p];
  }));
  if (destination != null) {
    const p = products.get(destination);
    if (!p.active || p.weighable || !p.stock_tracked) throw error(400, 'El destino debe ser un producto activo con stock por unidades');
    afterLine.productName = p.name; afterLine.clientProductUuid = p.client_product_uuid || null;
  }
  const choices = new Map();
  for (const choice of request.choices || []) {
    if (!ids.has(choice.productId) || choices.has(choice.productId) || !['AUTO','KEEP','ACCEPT','REVIEWED','APPLY'].includes(choice.decision)) throw error(400, 'Revisión de producto inválida');
    choices.set(choice.productId, choice);
  }
  const amounts = allocatedAmounts(receipt), impacts = [];
  for (const p of products.values()) {
    const current = snapshot(p), effect = effects[p.id], choice = choices.get(p.id), decision = choice?.decision || 'AUTO';
    let proposed = current, applied = current, pending = false, reason = null;
    if (review) {
      if (!['KEEP','APPLY'].includes(decision)) throw error(400, 'Elegí aplicar o conservar cada costo/precio pendiente');
      if (decision === 'APPLY' && !effect.pending) throw error(400, 'No hay un valor anterior verificable; conservá el actual o corregilo desde inventario');
      proposed = decision === 'APPLY' ? effect.pending : current; applied = proposed;
    } else {
      const group = receipt.lines.filter(l => l.decision === 'RECEIVE').map(l => l.uuid === lineUuid ? afterLine : l).filter(l => l.stockState !== 'REVERSED' && l.productId === p.id);
      const complete = group.length && group.every(l => amounts.get(l.uuid) != null);
      const units = group.reduce((n,l) => n + l.receivedUnits, 0);
      if (units > 2147483647) throw error(400, 'La cantidad total excede el máximo permitido');
      const cost = complete ? pricing.unitCost(group.reduce((n,l) => n + amounts.get(l.uuid), 0), units) : null;
      const safe = effect && !effect.reason && canonicalJson(effect.applied) === canonicalJson(current);
      if (!group.length) proposed = effect?.baseline || null;
      else if (complete) proposed = { pricing: { ...current.pricing, cost, costPending: false }, costDerived: false, revision: current.revision };
      if (p.id !== destination && !safe) { pending = true; reason = 'El catálogo cambió después del ingreso o falta su trazabilidad; se conservaron los valores actuales.'; }
      else if (!proposed) { pending = true; reason = 'No hay una instantánea anterior verificable; revisá el costo y precio actuales.'; }
      else {
        if (group.length && complete && ['ACCEPT','REVIEWED'].includes(decision)) {
          if (!scope.canPrice) throw error(403, 'No tenés permisos para cambiar precios');
          const price = decision === 'ACCEPT' ? pricing.propose(current.pricing, cost) : choice.reviewedSalePrice;
          if (price == null || !Number.isFinite(price) || price < 0 || price >= 1e16 || Math.abs(price * 100 - Math.round(price * 100)) > .001) throw error(400, 'Indicá un precio revisado válido');
          if (current.pricing.pricingMode === 'MARKUP' && price !== pricing.roundedMarkupPrice(cost, current.pricing.targetMarkupPercent)) throw error(400, 'El precio debe respetar el margen configurado');
          proposed = { pricing: { ...current.pricing, cost, price, costPending: false }, costDerived: false, revision: current.revision };
        }
        applied = proposed;
        if (!scope.canPrice && (proposed.pricing.price !== current.pricing.price || proposed.pricing.pricingMode !== current.pricing.pricingMode || proposed.pricing.targetMarkupPercent !== current.pricing.targetMarkupPercent)) {
          applied = { ...proposed, pricing: { ...proposed.pricing, price: current.pricing.price, pricingMode: current.pricing.pricingMode, targetMarkupPercent: current.pricing.targetMarkupPercent } };
          pending = true; reason = 'Stock y costo corregidos. Un dueño o administrador debe revisar el precio.';
        }
      }
    }
    const delta = deltas.get(p.id) || 0, after = p.quantity + delta;
    if (!Number.isSafeInteger(after) || after < -2147483648 || after > 2147483647) throw error(400, 'El stock excede el máximo permitido');
    impacts.push({ productId: p.id, clientProductUuid: p.client_product_uuid || null, name: p.name, quantityBefore: p.quantity, quantityAfter: after, delta,
      before: current, proposed, applied, reviewRequired: pending, reason });
  }
  const previewHash = sha256(canonicalJson({ version: receipt.version, action: request.action, afterLine,
    pricing: impacts.map(p => [p.productId,p.before,p.proposed,p.applied,p.reviewRequired]) }));
  return { row, receipt, line, preview: { receiptUuid, lineUuid, version: receipt.version, action: request.action, previewHash, beforeLine, afterLine, products: impacts } };
}
function preview(db, scope, receiptUuid, lineUuid, request) { return prepare(db, scope, receiptUuid, lineUuid, request).preview; }
function correct(db, scope, receiptUuid, lineUuid, request) {
  uuid(request?.mutationUuid);
  return db.transaction(() => {
    const hash = sha256(canonicalJson({ receiptUuid, lineUuid, request }));
    const row = requestRow(db, scope, receiptUuid);
    const prior = db.get('SELECT * FROM purchase_receipt_amendments WHERE client_id=? AND sucursal_id=? AND uuid=?', [scope.clientId, scope.branchId, request.mutationUuid]);
    if (prior) {
      if (prior.payload_hash !== hash || prior.receipt_local_id !== row.local_id || prior.kind !== 'CORRECTION') throw error(409, 'El UUID de corrección ya tiene otro contenido');
      return { mutationUuid: request.mutationUuid, receipt: require('./purchase-receipts').view(row, db), products: JSON.parse(prior.result_json).products };
    }
    const work = prepare(db, scope, receiptUuid, lineUuid, request), { receipt, line } = work;
    if (request.previewHash !== work.preview.previewHash) throw error(409, 'El ingreso o sus precios cambiaron. Revisá nuevamente la corrección');
    const review = request.action === 'REVIEW_PRICING';
    if (!review) {
      line.original ||= work.preview.beforeLine;
      Object.assign(line, work.preview.afterLine);
      line.unitCost = pricing.unitCost(allocatedAmounts(receipt).get(line.uuid), line.invoiceQuantity, line.unitsPerPack);
    }
    receipt.pricingEffects ||= {};
    for (const impact of work.preview.products) {
      const before = receipt.pricingEffects[impact.productId], value = impact.applied;
      db.run('UPDATE products SET quantity=?,cost=?,price=?,cost_pending=?,cost_derived=?,pricing_mode=?,target_markup_percent=?,pending_price_receipt_uuid=? WHERE id=? AND client_id=? AND sucursal_id=?',
        [impact.quantityAfter,value.pricing.cost,value.pricing.price,value.pricing.costPending ? 1 : 0,value.costDerived ? 1 : 0,value.pricing.pricingMode,value.pricing.targetMarkupPercent,request.mutationUuid,impact.productId,scope.clientId,scope.branchId]);
      db.run('UPDATE products SET pricing_revision=pricing_revision+1 WHERE id=?', [impact.productId]);
      impact.applied = snapshot(db.get('SELECT * FROM products WHERE id=?', [impact.productId]));
      const previouslyActive = receipt.lines.some(candidate => { const prior = candidate.uuid === lineUuid ? work.preview.beforeLine : candidate; return prior.stockState !== 'REVERSED' && prior.productId === impact.productId; });
      receipt.pricingEffects[impact.productId] = { baseline: !review && request.action === 'CORRECT' && line.productId === impact.productId && !previouslyActive ? impact.before : before ? before.baseline : !review && request.action === 'CORRECT' && line.productId === impact.productId ? impact.before : null,
        applied: impact.applied, pending: impact.reviewRequired ? impact.proposed : null, reason: impact.reviewRequired ? impact.reason : null, applications: [...(before?.applications || []), {before:impact.before,after:impact.applied,operationUuid:request.mutationUuid,employeeId:scope.employeeId,createdAt:now()}] };
    }
    const history = { mutationUuid: request.mutationUuid, lineUuid, action: request.action, employeeId: scope.employeeId, createdAt: now(), note: request.note || null,
      beforeLine: work.preview.beforeLine, afterLine: work.preview.afterLine, products: work.preview.products };
    receipt.corrections = [...(receipt.corrections || []), history]; receipt.version += 1;
    receipt.costStatus = receipt.lines.some(l => l.decision === 'RECEIVE' && l.stockState !== 'REVERSED' && l.lineAmount == null) || Object.values(receipt.pricingEffects).some(e => e.reason) ? 'COSTS_PENDING' : 'COMPLETE';
    const predecessor = db.get("SELECT uuid FROM purchase_receipt_amendments WHERE receipt_local_id=? AND sync_status<>'synced' ORDER BY local_id DESC LIMIT 1", [row.local_id]);
    const amendment = db.run("INSERT INTO purchase_receipt_amendments(receipt_local_id,uuid,client_id,sucursal_id,employee_id,payload_json,payload_hash,created_at,kind,result_json) VALUES (?,?,?,?,?,?,?,?,'CORRECTION',?)",
      [row.local_id,request.mutationUuid,scope.clientId,scope.branchId,scope.employeeId,canonicalJson(request),hash,now(),JSON.stringify(history)]);
    for (const p of work.preview.products) db.run('INSERT INTO purchase_receipt_correction_deltas(amendment_id,product_id,client_product_uuid,delta) VALUES (?,?,?,?)', [amendment.lastId,p.productId,p.clientProductUuid,p.delta]);
    db.run('UPDATE purchase_receipts SET receipt_json=? WHERE local_id=?', [JSON.stringify(receipt),row.local_id]);
    const wire = clone(request);
    if (wire.productId < 0) { if (!wire.clientProductUuid) throw error(409, 'El producto de destino necesita una referencia estable'); wire.productId = null; }
    const payload = canonicalJson({ employeeId: scope.employeeId, receiptUuid, lineUuid, correction: wire, products: work.preview.products,
      baseMutationUuid: predecessor?.uuid || (row.sync_status !== 'synced' ? receiptUuid : undefined) });
    db.run("INSERT INTO sync_outbox(mutation_type,idempotency_key,source_table,source_id,occurred_at,client_id,sucursal_id,payload_json,payload_hash) VALUES ('PURCHASE_RECEIPT_CORRECTION',?,'purchase_receipt_amendments',?,?,?,?,?,?)",
      [request.mutationUuid,amendment.lastId,now(),scope.clientId,scope.branchId,payload,sha256(payload)]);
    return { mutationUuid: request.mutationUuid, receipt: require('./purchase-receipts').get(db, scope, receiptUuid), products: work.preview.products };
  });
}
module.exports = { snapshot, recordPricing, allocatedAmounts, preview, correct };
