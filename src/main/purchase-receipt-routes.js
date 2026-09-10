'use strict';
const receipts = require('./purchase-receipts');
const { isOfflineSession } = require('./offline-session');

function cacheRemote(db, scope, receipt) {
  if (!receipt || Number(receipt.clientId) !== scope.clientId || Number(receipt.sucursalId) !== scope.branchId) throw receipts.error(403, 'Ingreso de otra sucursal');
  const row = db.get('SELECT * FROM purchase_receipts WHERE uuid=? AND client_id=? AND sucursal_id=?', [receipt.uuid, scope.clientId, scope.branchId]);
  if (row && (row.sync_status !== 'synced' || db.get("SELECT 1 FROM purchase_receipt_amendments WHERE receipt_local_id=? AND sync_status<>'synced' LIMIT 1", [row.local_id]))) return;
  db.transaction(() => {
    if (row) db.run('UPDATE purchase_receipts SET receipt_json=?,remote_version=?,draft_json=? WHERE local_id=?', [JSON.stringify(receipt), receipt.version, receipt.draft ? JSON.stringify(receipt.draft) : null, row.local_id]);
    else db.run(`INSERT INTO purchase_receipts(uuid,client_id,sucursal_id,employee_id,state,receipt_json,draft_json,sync_status,remote_version,created_at)
      VALUES (?,?,?,?,?,?,?,'synced',?,?)`, [receipt.uuid, scope.clientId, scope.branchId, receipt.employeeId, receipt.state, JSON.stringify(receipt), receipt.draft ? JSON.stringify(receipt.draft) : null, receipt.version, receipt.createdAt]);
  });
}
async function handle(context) {
  const { req, res, body, query, subpath, db, scope, apiClient, jsonResponse, proxyToCloud, authEpoch } = context;
  const base = `${apiClient.baseUrl}/api/client-panel/${scope.clientId}/sucursales/${scope.branchId}/purchase-receipts`;
  const online = () => apiClient.token && !isOfflineSession(apiClient.token);
  const sameIdentity = () => apiClient.authEpoch === authEpoch && Number(apiClient.clientId) === scope.clientId && Number(apiClient.sucursalId) === scope.branchId;
  const checkIdentity = () => { if (!sameIdentity()) throw receipts.error(409, 'La sesión o sucursal cambió. Volvé al ingreso original'); };
  const cloud = async (suffix, method = 'GET', value) => {
    if (!online()) throw receipts.error(503, 'Esta operación necesita conexión');
    const result = await apiClient._fetch(base + suffix, { method, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    checkIdentity(); return result;
  };
  try {
    if (!Number.isSafeInteger(scope.employeeId) || scope.employeeId <= 0) throw receipts.error(401, 'No hay un responsable identificado');
    if (subpath === '/purchase-receipts/capabilities' && req.method === 'GET') {
      try {
        const capabilities = await cloud('/capabilities');
        db.transaction(() => db.run('INSERT OR REPLACE INTO app_config(key,value) VALUES (?,?)', [receipts.featureKey(scope), JSON.stringify(capabilities)]));
      } catch (err) { if (err.status === 401 || err.status === 403) throw err; }
      checkIdentity(); return jsonResponse(res, 200, { enabled: false, contractVersion: 1, ...receipts.capabilities(db, scope) });
    }
    if (subpath === '/purchase-receipts' && req.method === 'GET') {
      try {
        const first = await cloud('?page=0&size=100'); for (const receipt of first.content || []) cacheRemote(db, scope, receipt);
        // Cache the requested older page too; local pending rows remain visible at the top.
        const wanted = Math.max(0, Math.floor(((Number(query.page) || 0) * 30 + 29) / 100));
        if (wanted > 0) for (let page = 1; page <= Math.min(wanted + 1, Number(first.totalPages) - 1); page++) {
          const result = await cloud(`?page=${page}&size=100`); for (const receipt of result.content || []) cacheRemote(db, scope, receipt);
        }
        const local = receipts.list(db, scope, query.page);
        local.totalPages = Math.max(local.totalPages, Math.ceil(Number(first.totalElements || 0) / 30));
        checkIdentity(); return jsonResponse(res, 200, local);
      }
      catch (err) { if (err.status === 401 || err.status === 403) throw err; }
      checkIdentity(); return jsonResponse(res, 200, receipts.list(db, scope, query.page));
    }
    if (subpath === '/purchase-receipts/confirm' && req.method === 'POST') {
      const prior = db.get('SELECT state FROM purchase_receipts WHERE uuid=? AND client_id=? AND sucursal_id=?', [body.uuid, scope.clientId, scope.branchId]);
      if (body.documentUuid && prior?.state !== 'CONFIRMED') {
        const document = await cloud(`/documents/${encodeURIComponent(body.documentUuid)}`);
        if (document.state !== 'READY') throw receipts.error(409, 'Completá la lectura o elegí ingresar a mano conservando la factura');
        const ids = new Set((body.lines || []).map(line => line.uuid));
        if ((document.extraction?.lines || []).some(line => !ids.has(line.uuid))) throw receipts.error(400, 'Revisá todas las líneas extraídas de la factura');
        if (document.possibleDuplicate && !body.duplicateReviewed) throw receipts.error(409, 'Revisá la posible factura duplicada');
        // Retain the document on the server before committing locally. The durable
        // confirmation intent survives a disconnected POS and a lost response.
        const localDraft = db.get('SELECT draft_json FROM purchase_receipts WHERE uuid=? AND client_id=? AND sucursal_id=?', [body.uuid, scope.clientId, scope.branchId]);
        const presentation = localDraft?.draft_json ? JSON.parse(localDraft.draft_json) : body;
        await cloud(`/${body.uuid}/draft`, 'PUT', { ...presentation, pendingConfirmation: body });
      }
      try { return jsonResponse(res, 200, receipts.confirm(db, scope, body)); }
      catch (error) {
        if (body.documentUuid && prior?.state !== 'CONFIRMED') {
          try { await cloud(`/${body.uuid}/draft`, 'PUT', body); } catch { /* Keep the intent for recovery if the connection was lost. */ }
        }
        throw error;
      }
    }
    const conflictMatch = subpath.match(/^\/purchase-receipts\/([0-9a-f-]+)\/(conflict|resolve-product|sync-review)$/);
    if (conflictMatch) {
      const receipt = receipts.get(db, scope, conflictMatch[1]);
      const original = db.get(`SELECT o.* FROM sync_outbox o WHERE o.client_id=? AND o.sucursal_id=?
        AND (o.idempotency_key=? AND o.mutation_type='PURCHASE_RECEIPT' OR o.mutation_type='PURCHASE_RECEIPT_AMOUNTS'
          AND o.source_id IN (SELECT a.local_id FROM purchase_receipt_amendments a JOIN purchase_receipts r ON r.local_id=a.receipt_local_id WHERE r.uuid=? AND r.client_id=? AND r.sucursal_id=?))
        ORDER BY o.sequence LIMIT 1`, [scope.clientId, scope.branchId, receipt.uuid, receipt.uuid, scope.clientId, scope.branchId]);
      if (!original) throw receipts.error(409, 'El mensaje original no está pendiente de sincronizar');
      const payload = JSON.parse(original.payload_json);
      if (req.method === 'GET' && conflictMatch[2] === 'conflict') {
        return jsonResponse(res, 200, { message: original.last_error, products: (payload.receipt?.lines || []).filter(line => line.newProduct).map(line => ({ ...line.newProduct })) });
      }
      if (conflictMatch[2] === 'sync-review' && ['GET', 'POST'].includes(req.method)) {
        if (original.state !== 'QUARANTINED') throw receipts.error(409, 'La operación no está en revisión');
        const device = db.get('SELECT device_id FROM sync_state WHERE client_id=? AND sucursal_id=?', [scope.clientId, scope.branchId]);
        const request = { payload, payloadHash: original.payload_hash, deviceId: device?.device_id,
          expectedVersion: body?.expectedVersion ?? null, products: body?.products ?? null };
        const result = await cloud(req.method === 'GET' ? '/sync-review/preview' : '/sync-review', 'POST', request);
        if (req.method === 'POST') db.transaction(() => {
          db.run("UPDATE sync_outbox SET state='PENDING',last_error=NULL,warning_code=NULL,next_retry_at=NULL WHERE sequence=?", [original.sequence]);
          if (original.mutation_type === 'PURCHASE_RECEIPT') db.run("UPDATE purchase_receipts SET sync_status='pending',sync_error=NULL WHERE local_id=?", [original.source_id]);
          else db.run("UPDATE purchase_receipt_amendments SET sync_status='pending',sync_error=NULL WHERE local_id=?", [original.source_id]);
        });
        return jsonResponse(res, 200, result);
      }
      if (req.method === 'POST' && conflictMatch[2] === 'resolve-product') {
        if (original.state !== 'QUARANTINED') throw receipts.error(409, 'El ingreso no está en revisión');
        const device = db.get('SELECT device_id FROM sync_state WHERE client_id=? AND sucursal_id=?', [scope.clientId, scope.branchId]);
        if (!device) throw receipts.error(409, 'Falta la identidad de sincronización');
        const resolution = await cloud('/resolve-product', 'POST', { payload, payloadHash: original.payload_hash, deviceId: device.device_id,
          clientProductUuid: body.clientProductUuid, productId: body.productId, expectedPricing: body.expectedPricing });
        if (resolution.clientProductUuid !== body.clientProductUuid || Number(resolution.productId) !== Number(body.productId)) throw receipts.error(409, 'La respuesta no coincide con la correspondencia elegida');
        db.transaction(() => {
          require('./purchase-receipt-sync').remapProduct(db, scope, resolution.clientProductUuid, Number(resolution.productId));
          db.run("UPDATE sync_outbox SET state='PENDING',last_error=NULL,warning_code=NULL,next_retry_at=NULL WHERE sequence=?", [original.sequence]);
          db.run("UPDATE purchase_receipts SET sync_status='pending',sync_error=NULL WHERE uuid=? AND client_id=? AND sucursal_id=?", [receipt.uuid, scope.clientId, scope.branchId]);
        });
        return jsonResponse(res, 200, resolution);
      }
      throw receipts.error(405, 'Método no permitido');
    }
    if (subpath === '/purchase-receipts/matches' || subpath.startsWith('/purchase-receipts/documents/'))
      return await proxyToCloud(req, res, req.method, req.url, body);
    const match = subpath.match(/^\/purchase-receipts\/([0-9a-f-]+)(?:\/(draft|amounts|document))?$/);
    if (!match) throw receipts.error(404, 'Operación de compra no encontrada');
    const id = match[1], action = match[2];
    if (action === 'draft' && req.method === 'PUT') return jsonResponse(res, 200, receipts.saveDraft(db, scope, id, body));
    if (action === 'amounts' && req.method === 'PATCH') return jsonResponse(res, 200, receipts.complete(db, scope, id, body));
    if (action === 'document' && req.method === 'POST') {
      const local = receipts.get(db, scope, id);
      if (!local.draft) throw receipts.error(409, 'El ingreso ya fue confirmado');
      await cloud(`/${id}/draft`, 'PUT', local.draft);
      return await proxyToCloud(req, res, req.method, req.url, body);
    }
    if (!action && req.method === 'GET') {
      try { cacheRemote(db, scope, await cloud(`/${id}`)); } catch (err) { if (err.status === 401 || err.status === 403) throw err; }
      checkIdentity(); return jsonResponse(res, 200, receipts.get(db, scope, id));
    }
    throw receipts.error(405, 'Método no permitido');
  } catch (err) {
    let message = err.message;
    try { const parsed = JSON.parse(err.responseBody); message = parsed.message || parsed.detail || parsed.error || message; } catch { /* local error */ }
    return jsonResponse(res, Number(err.status) || 500, { message });
  }
}
module.exports = { handle, cacheRemote };
