// ============================================================
// Nuventa POS — Background Sync Service
// Uploads pending sales and downloads products + registers
// ============================================================
const EventEmitter = require('events');
const { getDb } = require('./database');
const { apiClient } = require('./api-client');

// Full cloud↔local reconciliation every hour.
// If a sync fails (offline), a 5-minute retry fires until the
// connection is restored, then normal hourly cadence resumes.
const SYNC_INTERVAL_MS  = 3_600_000;   // 1 hour
const RETRY_INTERVAL_MS =   300_000;   // 5 minutes (when offline)
const BATCH_SIZE = 20;

// Tras este nº de reintentos transitorios, una fila se escala a 'needs_review' (dead-letter, C15)
// para que deje de reintentarse en silencio y aparezca para revisión manual.
const MAX_SYNC_RETRIES = 10;

// Clasificación de errores de sync (C02). El backend deduplica por idempotencia (C01) y devuelve
// 2xx con la entidad existente, así que NINGÚN error se marca ya 'synced'. Distinguimos:
//   - 'permanent': HTTP 4xx (400/401/403/404/409/422) → el dato NO se persistió en la nube y un
//                  reintento idéntico volverá a fallar → 'needs_review' (visible), nunca 'synced'.
//   - 'transient': error de red/timeout o HTTP 5xx/408/429 → se mantiene 'pending' y se reintenta.
function classifySyncError(err) {
  const msg = (err && err.message) || '';
  const m = msg.match(/HTTP (\d{3})/);
  if (!m) return 'transient';                       // red / timeout / abort
  const status = parseInt(m[1], 10);
  if (status >= 500 || status === 408 || status === 429) return 'transient';
  // R4-#10: 401/403 durante el upload es típicamente AUTH transitoria (JWT vencido, sesión aún no
  // renovada), NO un rechazo de datos. Antes se marcaba 'permanent' → ventas/devoluciones válidas
  // caían en needs_review para siempre por un simple vencimiento de token. Se trata como transitorio
  // (un re-login lo resuelve); el backstop MAX_SYNC_RETRIES evita reintentos infinitos en silencio.
  if (status === 401 || status === 403) return 'transient';
  if (status >= 400) return 'permanent';            // 4xx de validación/conflicto real
  return 'transient';
}

class SyncService extends EventEmitter {
  constructor() {
    super();
    this._timer      = null;   // main hourly interval
    this._retryTimer = null;   // short retry when offline
    this._running    = false;
    this._lastOnline = null;   // last observed connectivity (real, not derived from _running)
  }

  start() {
    if (this._timer) return;
    console.log('[SYNC] Service started — hourly sync, 5-min retry on offline');
    this._timer = setInterval(() => this._tick(), SYNC_INTERVAL_MS);
    // First run a few seconds after startup
    setTimeout(() => this._tick(), 3000);
  }

  stop() {
    if (this._timer)      { clearInterval(this._timer);      this._timer      = null; }
    if (this._retryTimer) { clearTimeout(this._retryTimer);  this._retryTimer = null; }
    console.log('[SYNC] Service stopped');
  }

  // R4-#42: esperar a que un _tick en vuelo termine (hasta maxMs) antes de cerrar la DB. Evita que
  // window-all-closed cierre la DB mientras un upload está esperando la respuesta de la nube (la venta
  // se creaba en cloud pero el marcado local 'synced' se perdía / lanzaba sobre db=null).
  async drain(maxMs = 3000) {
    const start = Date.now();
    while (this._running && (Date.now() - start) < maxMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return !this._running;
  }

  // ── Schedule a 5-minute retry (replaces any existing one) ──
  _scheduleRetry() {
    if (this._retryTimer) return; // already waiting
    console.log('[SYNC] Offline — will retry in 5 minutes');
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._tick();
    }, RETRY_INTERVAL_MS);
  }

  // ── Cancel any pending retry (called after a successful sync) ──
  _cancelRetry() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
  }

  async _tick() {
    if (this._running) return;
    this._running = true;

    try {
      const online = await apiClient.isOnline();
      this._lastOnline = online;
      this.emit('sync-status', { online, syncing: online });

      if (!online) {
        // Invisible to cashier — session continues from local DB.
        // Schedule a short retry so we reconnect ASAP.
        this._scheduleRetry();
        this._running = false;
        return;
      }

      // Online — cancel any pending retry; we're connected.
      this._cancelRetry();

      // R4-#38: capturar el epoch de identidad al INICIO del ciclo. apiClient es un singleton mutable;
      // si el usuario hace logout o re-login (posiblemente como OTRO tenant/sucursal) en medio del
      // ciclo, quedaría re-apuntado y un pendiente del tenant A se subiría al branch del tenant B.
      // Abortamos el resto del ciclo en cuanto detectamos el cambio.
      const epoch = apiClient.authEpoch;
      const stillSameAuth = () => apiClient.authEpoch === epoch;

      const db = getDb();
      // R4-#33: solo refrescar la ventana de gracia offline si el heartbeat fue AUTENTICADO (2xx). Un
      // 401 (token revocado / suscripción morosa / empleado dado de baja) NO debe extender los 7 días.
      if (apiClient.lastHeartbeatAuthed) {
        db.run(
          "INSERT OR REPLACE INTO app_config (key, value) VALUES ('last_online_at', ?)",
          [new Date().toISOString()]
        );
        db.save();
      }

      // 1. Upload pending sales (local → cloud)
      const salesSynced = await this._uploadPendingSales();

      // 2. Upload pending returns (local → cloud)
      const returnsSynced = stillSameAuth() ? await this._uploadPendingReturns() : 0;

      // 3. Upload pending cash movements (local → cloud)
      const movementsSynced = stillSameAuth() ? await this._uploadPendingCashMovements() : 0;

      // 4. Upload pending cash sessions (local → cloud)
      const sessionsSynced = stillSameAuth() ? await this._uploadPendingCashSessions() : 0;

      // 5. Download product catalog + registers (cloud → local)
      if (stillSameAuth() && apiClient.token) {
        await this._downloadProducts();
        await this._downloadRegisters();
      }

      if (!stillSameAuth()) {
        console.warn('[SYNC] La identidad de sesión cambió durante el ciclo — se abortó el resto para no cruzar tenants.');
      }

      const totalSynced = salesSynced + returnsSynced + movementsSynced + sessionsSynced;
      if (totalSynced > 0) {
        this.emit('sync-complete', {
          sales: salesSynced,
          returns: returnsSynced,
          movements: movementsSynced,
          sessions: sessionsSynced,
          total: totalSynced,
        });
      }

      this.emit('sync-status', { online: true, syncing: false });
    } catch (err) {
      console.error('[SYNC] Tick error:', err.message);
      this.emit('sync-status', { online: false, syncing: false });
      this._scheduleRetry();
    } finally {
      this._running = false;
    }
  }

  async forceSync() {
    // A cycle may already be running (hourly tick or retry). Surface that
    // instead of silently doing nothing, so the "Forzar sincronización"
    // button always gives feedback.
    if (this._running) {
      this.emit('sync-status', { online: this._lastOnline, syncing: true });
      return;
    }
    this._cancelRetry();
    await this._tick();
  }

  getStatus() {
    const db = getDb();
    const pendingSales = db.get("SELECT COUNT(*) as cnt FROM sales WHERE sync_status = 'pending'");
    const pendingReturns = db.get("SELECT COUNT(*) as cnt FROM returns WHERE sync_status = 'pending'");
    const pendingMovements = db.get("SELECT COUNT(*) as cnt FROM cash_movements WHERE sync_status = 'pending'");
    const pendingSessions = db.get("SELECT COUNT(*) as cnt FROM cash_sessions WHERE sync_status = 'pending' AND status = 'CLOSED'");
    const lastSync = db.get("SELECT value FROM app_config WHERE key = 'last_product_sync'");

    // C02/C15: filas que el sync NO pudo subir (4xx o dead-letter). Visibles para revisión manual;
    // nunca se cuentan como 'synced'.
    const reviewSales = db.get("SELECT COUNT(*) as cnt FROM sales WHERE sync_status = 'needs_review'");
    const reviewReturns = db.get("SELECT COUNT(*) as cnt FROM returns WHERE sync_status = 'needs_review'");
    const reviewMovements = db.get("SELECT COUNT(*) as cnt FROM cash_movements WHERE sync_status = 'needs_review'");
    const reviewSessions = db.get("SELECT COUNT(*) as cnt FROM cash_sessions WHERE sync_status = 'needs_review'");
    const needsReview = (reviewSales?.cnt || 0) + (reviewReturns?.cnt || 0)
      + (reviewMovements?.cnt || 0) + (reviewSessions?.cnt || 0);

    return {
      online: !this._running ? null : true,
      syncing: this._running,
      pendingSales: pendingSales?.cnt || 0,
      pendingReturns: pendingReturns?.cnt || 0,
      pendingMovements: pendingMovements?.cnt || 0,
      pendingSessions: pendingSessions?.cnt || 0,
      pendingTotal: (pendingSales?.cnt || 0) + (pendingReturns?.cnt || 0) + (pendingMovements?.cnt || 0) + (pendingSessions?.cnt || 0),
      needsReview,
      needsReviewSales: reviewSales?.cnt || 0,
      needsReviewReturns: reviewReturns?.cnt || 0,
      needsReviewMovements: reviewMovements?.cnt || 0,
      needsReviewSessions: reviewSessions?.cnt || 0,
      lastSyncAt: lastSync?.value || null,
    };
  }

  // ── Upload pending sales ────────────────────────────

  async _uploadPendingSales() {
    const db = getDb();
    const pendingSales = db.all(
      "SELECT * FROM sales WHERE sync_status = 'pending' ORDER BY created_at ASC LIMIT ?",
      [BATCH_SIZE]
    );

    if (pendingSales.length === 0) return 0;
    console.log(`[SYNC] Uploading ${pendingSales.length} pending sale(s)…`);
    let synced = 0;

    for (const sale of pendingSales) {
      if (!this._rowMatchesCurrentAuth(sale)) continue; // R4-#40: no subir a otra sucursal/tenant
      try {
        const items = db.all(
          'SELECT * FROM sale_items WHERE sale_local_id = ?', [sale.local_id]
        );
        const payments = db.all(
          'SELECT * FROM sale_payments WHERE sale_local_id = ?', [sale.local_id]
        );
        const promoDiscounts = db.all(
          'SELECT * FROM sale_promotion_discounts WHERE sale_local_id = ?', [sale.local_id]
        );

        // R4-#5 p3: reenviar la intención de factura de la venta offline para que el backend la emita.
        let saleInvoice;
        try { saleInvoice = sale.invoice_json ? JSON.parse(sale.invoice_json) : undefined; } catch (_) { saleInvoice = undefined; }

        // R4-#9/#28: enviar el uuid de la sesión local para que el backend vincule la venta a UNA sesión
        // cloud idempotente (find-or-create por uuid) en vez de auto-abrir una sesión huérfana por batch.
        const sessRow = sale.cash_session_id
          ? db.get('SELECT client_session_uuid FROM cash_sessions WHERE id = ?', [sale.cash_session_id])
          : null;

        const payload = {
          clientSaleUuid: sale.client_sale_uuid || undefined,
          clientSessionUuid: (sessRow && sessRow.client_session_uuid) || undefined,
          saleDate: sale.sale_date,
          employeeId: sale.employee_id,
          status: sale.status || 'COMPLETED',
          cashRegisterId: sale.cash_register_id || undefined,
          items: items.map((i) => ({
            productId: i.product_id,
            quantity: i.quantity,
            // Sólo el precio que MANDÓ el cliente (pesable/independiente). `unit_price` puede ser un
            // precio resuelto del catálogo LOCAL, y reenviarlo activaría el guard de precio de
            // SalesService: si el catálogo cambió en la nube entre el cacheo y el sync, un CAJERO se
            // comería un 403 y la venta caería en needs_review. Omitirlo deja que el backend recalcule
            // desde su catálogo, que es exactamente lo que ya venía pasando (antes llegaba un 0 que el
            // guard `> 0` descartaba). Ver la nota de client_unit_price en database.js (v6).
            unitPrice: i.client_unit_price != null ? i.client_unit_price : undefined,
            // R4-#8: ítem INDEPENDIENTE (sin productId) → enviar el nombre libre (persistido en
            // product_name) como customName; el backend lo exige no-blank para esos ítems, si no la
            // venta independiente offline quedaba atrapada en needs_review.
            customName: i.product_id == null ? i.product_name : undefined,
          })),
          payments: payments.map((p) => ({
            paymentMethod: p.payment_method,
            amount: p.amount,
            externalReference: p.external_ref || undefined,
          })),
          totalDiscount: sale.total_discount || 0,
          originalTotal: sale.original_total || undefined,
          finalTotal: sale.final_total || undefined,
          invoice: saleInvoice, // R4-#5 p3: el backend emite la factura al recibir la venta sincronizada

          promotionDiscounts: promoDiscounts.length > 0
            ? promoDiscounts.map((d) => ({
                promotionId: d.promotion_id,
                promotionName: d.promotion_name,
                discountAmount: d.discount_amount,
              }))
            : undefined,
        };

        const result = await apiClient.createSale(payload);

        db.run(`
          UPDATE sales
          SET sync_status  = 'synced',
              cloud_id     = ?,
              total_amount = ?,
              synced_at    = datetime('now','localtime'),
              sync_error   = NULL
          WHERE local_id = ?
        `, [
          result.id || result.saleId || null,
          // R4-#26/#43: reconciliar el total con el AUTORITATIVO del backend (recalcula con el precio de
          // BD). Si el precio de catálogo cambió entre el cacheo offline y el sync, el revenue local
          // queda alineado con la nube. Si el backend no lo devuelve, se conserva el local. NO se toca
          // expected_amount (arqueo de efectivo: refleja el efectivo REAL cobrado, no se recalcula acá).
          (result && typeof result.totalAmount === 'number') ? result.totalAmount : sale.total_amount,
          sale.local_id,
        ]);

        this._log('UPLOAD_SALE', `local_id=${sale.local_id} → cloud_id=${result.id}`, 'ok');
        console.log(`[SYNC] Sale ${sale.local_id} uploaded → cloud ${result.id}`);
        synced++;
      } catch (err) {
        // C02: ya NO se marca 'synced' ante 400/409. La idempotencia (C01) hace que un duplicado
        // real devuelva 2xx con la venta existente; cualquier error queda 'needs_review' o 'pending'.
        const prevStatus = sale.sync_status;
        this._handleUploadError(db, 'sales', 'local_id', sale.local_id, err, 'UPLOAD_SALE');
        // R8-#38: si la venta acaba de pasar a needs_review, restaurar el stock local que se
        // descontó al crearla. _downloadProducts no la excluye (sólo excluye 'pending'), así que
        // el próximo sync de productos pisos el stock con el valor autoritativo del backend
        // (que nunca la procesó), causando una re-venta del mismo artículo. Reintegrar acá, al
        // momento de la transición, es la guarda más localizada y de menor riesgo.
        const afterRow = db.get('SELECT sync_status FROM sales WHERE local_id = ?', [sale.local_id]);
        if (afterRow && afterRow.sync_status === 'needs_review' && prevStatus !== 'needs_review') {
          const saleItems = db.all('SELECT product_id, quantity FROM sale_items WHERE sale_local_id = ? AND product_id IS NOT NULL', [sale.local_id]);
          for (const si of saleItems) {
            // weighable = 0: a un pesable no se le descontó stock al crear la venta, así que
            // reintegrarlo acá lo inflaría (mismo criterio que el descuento en local-server).
            db.run('UPDATE products SET quantity = quantity + ? WHERE id = ? AND no_code = 0 AND weighable = 0', [si.quantity, si.product_id]);
          }
          if (saleItems.length > 0) {
            console.log(`[SYNC] R8-#38: stock reintegrado por ${saleItems.length} ítem(s) de venta ${sale.local_id} → needs_review`);
          }
        }
      }
    }
    db.save();
    return synced;
  }

  // ── Upload pending returns ──────────────────────────

  async _uploadPendingReturns() {
    const db = getDb();
    const pendingReturns = db.all(
      "SELECT * FROM returns WHERE sync_status = 'pending' ORDER BY created_at ASC LIMIT ?",
      [BATCH_SIZE]
    );

    if (pendingReturns.length === 0) return 0;
    console.log(`[SYNC] Uploading ${pendingReturns.length} pending return(s)…`);
    let synced = 0;

    for (const ret of pendingReturns) {
      if (!this._rowMatchesCurrentAuth(ret)) continue; // R4-#40
      try {
        const items = db.all(
          'SELECT * FROM return_items WHERE return_local_id = ?', [ret.local_id]
        );

        // Resolve the cloud sale ID for the return
        let saleCloudId = ret.sale_cloud_id;
        if (!saleCloudId && ret.sale_local_id) {
          const sale = db.get('SELECT cloud_id FROM sales WHERE local_id = ?', [ret.sale_local_id]);
          saleCloudId = sale ? sale.cloud_id : null;
        }

        if (!saleCloudId) {
          // If the original sale will never get a cloud_id (it landed in
          // needs_review or no longer exists), the return can never reference
          // it. Escalate it to needs_review instead of skipping forever — a
          // silent `continue` here never increments retry_count, so it would
          // be reattempted indefinitely and never surface for manual review.
          const origin = ret.sale_local_id
            ? db.get('SELECT sync_status FROM sales WHERE local_id = ?', [ret.sale_local_id])
            : null;
          if (!origin || origin.sync_status === 'needs_review') {
            db.run(
              "UPDATE returns SET sync_status = 'needs_review', sync_error = ? WHERE local_id = ?",
              ['Venta original no sincronizable (needs_review o inexistente)', ret.local_id]
            );
            this._log('UPLOAD_RETURN', `local_id=${ret.local_id} needs_review: venta original no sincronizable`, 'error');
            console.warn(`[SYNC] Return ${ret.local_id} → needs_review: venta original no sincronizable`);
            continue;
          }
          console.warn(`[SYNC] Return ${ret.local_id} skipped — sale not yet synced`);
          continue; // Sale still pending; will retry next cycle
        }

        const payload = {
          clientReturnUuid: ret.client_return_uuid || undefined,
          saleId: saleCloudId,
          // Backend requires a non-blank reason (@NotBlank). Sending undefined
          // produces a 400 that classifies as 'permanent' → the return is stuck
          // in needs_review forever and never reaches the cloud. Default it.
          reason: ret.reason || 'Devolución desde POS',
          returnDate: ret.return_date || undefined, // F07: fecha real de la devolución (no la del sync)
          refundMethod: ret.refund_method || 'CASH', // B01: canónico backend (RefundMethod.CASH)
          items: items.map((i) => ({
            saleItemId: i.sale_item_id || undefined,
            productId: i.product_id,
            quantity: i.quantity,
          })),
        };

        const result = await apiClient.createReturn(payload);

        db.run(`
          UPDATE returns
          SET sync_status  = 'synced',
              cloud_id     = ?,
              sale_cloud_id = ?,
              synced_at    = datetime('now','localtime'),
              sync_error   = NULL
          WHERE local_id = ?
        `, [result.id || null, saleCloudId, ret.local_id]);

        this._log('UPLOAD_RETURN', `local_id=${ret.local_id} → cloud_id=${result.id}`, 'ok');
        console.log(`[SYNC] Return ${ret.local_id} uploaded → cloud ${result.id}`);
        synced++;
      } catch (err) {
        // C02: sin marcar 'synced' ante 4xx. Idempotencia (C01) cubre el duplicado real con 2xx.
        this._handleUploadError(db, 'returns', 'local_id', ret.local_id, err, 'UPLOAD_RETURN');
      }
    }
    db.save();
    return synced;
  }

  // ── Upload pending cash movements ───────────────────

  async _uploadPendingCashMovements() {
    const db = getDb();
    const pendingMovements = db.all(
      "SELECT * FROM cash_movements WHERE sync_status = 'pending' ORDER BY created_at ASC LIMIT ?",
      [BATCH_SIZE]
    );

    if (pendingMovements.length === 0) return 0;
    console.log(`[SYNC] Uploading ${pendingMovements.length} pending cash movement(s)…`);
    let synced = 0;

    for (const mov of pendingMovements) {
      if (!this._rowMatchesCurrentAuth(mov)) continue; // R4-#40
      try {
        // C04/B09: el backend (CreateCashMovementRequest) espera `note` y `createdAt`, NO
        // `description`/`movementDate` (que se ignoraban → note=null, createdAt=now). Además propaga
        // `expenseCategoryId` (obligatorio para type=EXPENSE).
        const payload = {
          clientMovementUuid: mov.client_movement_uuid || undefined,
          type: mov.type,
          scope: mov.scope,
          amount: mov.amount,
          note: mov.description || undefined,
          createdAt: mov.movement_date,
          expenseCategoryId: mov.expense_category_id || undefined,
        };

        const result = await apiClient.createCashMovement(payload);

        db.run(`
          UPDATE cash_movements
          SET sync_status = 'synced',
              cloud_id    = ?,
              synced_at   = datetime('now','localtime'),
              sync_error  = NULL
          WHERE local_id = ?
        `, [result.id || null, mov.local_id]);

        this._log('UPLOAD_CASH_MOVEMENT', `local_id=${mov.local_id} → cloud_id=${result.id}`, 'ok');
        console.log(`[SYNC] Cash movement ${mov.local_id} uploaded → cloud ${result.id}`);
        synced++;
      } catch (err) {
        // C02: sin marcar 'synced' ante 4xx. Idempotencia (C01/C04) cubre el duplicado real con 2xx.
        this._handleUploadError(db, 'cash_movements', 'local_id', mov.local_id, err, 'UPLOAD_CASH_MOVEMENT');
      }
    }
    db.save();
    return synced;
  }

  // ── Upload pending cash sessions ────────────────────

  async _uploadPendingCashSessions() {
    const db = getDb();
    // Only sync CLOSED sessions — open sessions sync on close
    const pendingSessions = db.all(
      "SELECT * FROM cash_sessions WHERE sync_status = 'pending' AND status = 'CLOSED' ORDER BY opening_time ASC LIMIT ?",
      [BATCH_SIZE]
    );

    if (pendingSessions.length === 0) return 0;
    console.log(`[SYNC] Uploading ${pendingSessions.length} pending cash session(s)…`);
    let synced = 0;

    for (const sess of pendingSessions) {
      if (!this._rowMatchesCurrentAuth(sess)) continue; // R7-#55: no imputar el arqueo a otra sucursal/tenant
      try {
        // Reuse the cloud id if a previous cycle already opened the session but
        // failed before closing it. Re-opening would create a DUPLICATE orphan
        // session in the cloud, because the backend currently ignores
        // clientSessionUuid on open. Persist the cloud id immediately after a
        // successful open so a later failure only re-attempts the close.
        let cloudSessionId = sess.cloud_id || null;

        if (!cloudSessionId) {
          const openResult = await apiClient.openSession({
            clientSessionUuid: sess.client_session_uuid || undefined,
            cashRegisterId: sess.cash_register_id,
            initialAmount: sess.initial_amount,
          });
          cloudSessionId = (openResult && (openResult.id || openResult.sessionId)) || null;
          // R4-#30: si el backend respondió 2xx pero SIN id usable, NO seguir y marcar 'synced' con
          // cloud_id NULL — eso dejaba una sesión OPEN huérfana e invisible que bloquea el cierre
          // diario. Tratarlo como error → needs_review/pending visible.
          if (!cloudSessionId) {
            throw new Error('openSession devolvió 2xx sin id de sesión usable');
          }
          db.run('UPDATE cash_sessions SET cloud_id = ? WHERE id = ?', [cloudSessionId, sess.id]);
          db.save();
        }

        // Then close it with the recorded counts.
        try {
          await apiClient.closeSession(cloudSessionId, {
            countedAmount: sess.counted_amount,
            floatLeftForNext: sess.float_left_for_next || 0,
            note: sess.closing_note || 'Sincronizado desde POS offline',
          });
        } catch (closeErr) {
          // R4-#39: la sesión YA está abierta en la nube (cloud_id seteado). Mandar la fila a
          // needs_review ante un 4xx de close (lo que haría _handleUploadError) dejaría una sesión
          // OPEN huérfana que bloquea la caja y NUNCA se reintenta. En su lugar:
          //  - si el backend dice que ya está cerrada → dar por sincronizada;
          //  - si no → mantener 'pending' y reintentar SOLO el close (el open se saltea por cloud_id),
          //    escalando a needs_review recién tras MAX_SYNC_RETRIES.
          const alreadyClosed = /already closed|ya\s+(est[aá]\s+)?cerrad|\bCLOSED\b|HTTP 409/i.test(closeErr.message || '');
          if (alreadyClosed) {
            db.run("UPDATE cash_sessions SET sync_status='synced', synced_at=datetime('now','localtime'), sync_error=NULL WHERE id = ?", [sess.id]);
            this._log('UPLOAD_CASH_SESSION', `id=${sess.id} ya cerrada en la nube → synced`, 'ok');
            synced++;
            continue;
          }
          db.run('UPDATE cash_sessions SET retry_count = COALESCE(retry_count,0)+1, sync_error = ? WHERE id = ?', [closeErr.message, sess.id]);
          const cr = db.get('SELECT retry_count FROM cash_sessions WHERE id = ?', [sess.id]);
          if (cr && cr.retry_count >= MAX_SYNC_RETRIES) {
            db.run("UPDATE cash_sessions SET sync_status='needs_review' WHERE id = ?", [sess.id]);
            this._log('UPLOAD_CASH_SESSION_CLOSE', `id=${sess.id} dead-letter tras ${cr.retry_count} intentos de cierre`, 'error');
          } else {
            this._log('UPLOAD_CASH_SESSION_CLOSE', `id=${sess.id} cierre falló (se reintenta el close): ${closeErr.message}`, 'error');
          }
          continue;
        }

        db.run(`
          UPDATE cash_sessions
          SET sync_status = 'synced',
              cloud_id    = ?,
              synced_at   = datetime('now','localtime'),
              sync_error  = NULL
          WHERE id = ?
        `, [cloudSessionId, sess.id]);

        this._log('UPLOAD_CASH_SESSION', `id=${sess.id} → cloud_id=${cloudSessionId}`, 'ok');
        console.log(`[SYNC] Cash session ${sess.id} uploaded → cloud ${cloudSessionId}`);
        synced++;
      } catch (err) {
        // open falló (o 2xx sin id): no se creó/abrió sesión cloud → needs_review (4xx) o pending.
        this._handleUploadError(db, 'cash_sessions', 'id', sess.id, err, 'UPLOAD_CASH_SESSION');
      }
    }
    db.save();
    return synced;
  }

  // ── Download & cache product catalog ────────────────

  async _downloadProducts() {
    try {
      const cloudProducts = await apiClient.getProducts();
      if (!Array.isArray(cloudProducts)) {
        console.warn('[SYNC] Unexpected product response, skipping');
        return;
      }

      const db = getDb();
      const now = new Date().toISOString();

      // Fuente única de stock = backend (autoritativo). PERO no pisar el quantity local de productos
      // con ventas/devoluciones aún NO sincronizadas: perderíamos el decremento/reintegro local y el
      // cajero sobrevendería. Para esos productos preservamos el quantity local hasta que su
      // movimiento suba a la nube (y el próximo download ya refleje el valor real).
      // R4-#32: SOLO 'pending' (movimientos que SÍ van a subir). Antes también se excluía
      // 'needs_review', pero esas filas NO se sincronizan solas → el stock de sus productos quedaba
      // CONGELADO para siempre, divergiendo del autoritativo de la nube de forma invisible. Una vez
      // que el operador resuelve/descarta la fila needs_review, el próximo download ya reconcilia.
      // R8-#99: filtrar product_id IS NOT NULL en ambas ramas del UNION. Los ítems independientes
      // (product_id=NULL) no tienen stock que preservar; incluirlos metía null en el Set y, aunque
      // has(numericId) nunca matchea null, el null es basura que puede confundir lógica futura.
      const pendingRows = db.all(`
        SELECT DISTINCT si.product_id AS pid
          FROM sale_items si JOIN sales s ON s.local_id = si.sale_local_id
         WHERE s.sync_status = 'pending' AND si.product_id IS NOT NULL
        UNION
        SELECT DISTINCT ri.product_id AS pid
          FROM return_items ri JOIN returns r ON r.local_id = ri.return_local_id
         WHERE r.sync_status = 'pending' AND ri.product_id IS NOT NULL
      `);
      const pendingProductIds = new Set(pendingRows.map((r) => r.pid));

      // Atomic catalog swap: deactivate-all + repopulate must be all-or-nothing.
      // Without a transaction, a crash/close mid-loop leaves live products marked
      // active=0 → they vanish from the cashier's catalog until the next OK sync.
      db.transaction(() => {
      db.exec('UPDATE products SET active = 0');

      for (const p of cloudProducts) {
        // Si el producto tiene movimientos locales pendientes, NO pisar su quantity (fragmento fijo,
        // no entrada de usuario → seguro interpolar).
        const qtyClause = pendingProductIds.has(p.id) ? '' : 'quantity=excluded.quantity,';
        db.run(`
          INSERT INTO products (id, code, no_code, weighable, max_unit_price, name, description, price, cost,
            cost_derived, quantity, low_stock_threshold, reorder_qty_default,
            preferred_provider_id, preferred_provider_name,
            category_ids, subcategory_ids, provider_ids, image_url, thumbnail_url, active, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(id) DO UPDATE SET
            code=excluded.code, no_code=excluded.no_code,
            weighable=excluded.weighable, max_unit_price=excluded.max_unit_price,
            name=excluded.name,
            description=excluded.description, price=excluded.price, cost=excluded.cost,
            cost_derived=excluded.cost_derived, ${qtyClause}
            low_stock_threshold=excluded.low_stock_threshold,
            reorder_qty_default=excluded.reorder_qty_default,
            preferred_provider_id=excluded.preferred_provider_id,
            preferred_provider_name=excluded.preferred_provider_name,
            category_ids=excluded.category_ids, subcategory_ids=excluded.subcategory_ids,
            provider_ids=excluded.provider_ids,
            image_url=excluded.image_url, thumbnail_url=excluded.thumbnail_url,
            active=1, synced_at=excluded.synced_at
        `, [
          p.id, p.code || null, p.noCode ? 1 : 0,
          p.weighable ? 1 : 0, p.maxUnitPrice ?? null,
          p.name, p.description || null,
          p.price, p.cost || null, p.costDerived ? 1 : 0, p.quantity ?? 0,
          p.lowStockThreshold || null, p.reorderQtyDefault || null,
          p.preferredProviderId || null, p.preferredProviderName || null,
          JSON.stringify(p.categoryIds || []), JSON.stringify(p.subcategoryIds || []),
          JSON.stringify(p.providerIds || []),
          p.imageUrl || null, p.thumbnailUrl || null,
          now,
        ]);
      }

      db.run(
        "INSERT OR REPLACE INTO app_config (key, value) VALUES ('last_product_sync', ?)",
        [now]
      );
      }); // transaction() commits and persists to disk synchronously

      this._log('DOWNLOAD_PRODUCTS', `${cloudProducts.length} products synced`, 'ok');
      console.log(`[SYNC] Products synced: ${cloudProducts.length} items`);
      this.emit('products-updated');
    } catch (err) {
      this._log('DOWNLOAD_PRODUCTS', err.message, 'error');
      console.error('[SYNC] Product download failed:', err.message);
    }

    // La config de balanza viaja con el catálogo: sin ella el POS no sabe decodificar la etiqueta.
    // Va aparte del try/catch de arriba para que un fallo acá no cancele el sync de productos.
    await this._downloadScaleSettings();
  }

  // ── Download & cache scale (balanza) settings ───────
  //
  // Se cachea en app_config porque la caja la consulta LOCAL: un cajero offline no puede pedirla a
  // la nube, y sin máscara la lectura de etiquetas queda muerta justo cuando más se la necesita.

  async _downloadScaleSettings() {
    try {
      const settings = await apiClient.getScaleSettings();
      if (!settings || typeof settings !== 'object') return;

      const db = getDb();
      db.run(
        "INSERT OR REPLACE INTO app_config (key, value) VALUES ('scale_settings', ?)",
        [JSON.stringify({
          enabled: !!settings.enabled,
          prefix: String(settings.prefix ?? '2'),
          mask: String(settings.mask ?? 'PPPPPIIIIII'),
          priceInCents: !!settings.priceInCents,
        })]
      );
      db.save();
    } catch (err) {
      // Silencioso a propósito: un backend viejo sin el endpoint devuelve 404 y no es un error de
      // sync. La config cacheada anterior (o el default deshabilitado) sigue vigente.
      console.warn('[SYNC] Scale settings download skipped:', err.message);
    }
  }

  // ── Download & cache cash registers ─────────────────

  async _downloadRegisters() {
    try {
      const registers = await apiClient.listRegisters(false); // all registers
      if (!Array.isArray(registers)) return;

      const db = getDb();
      const now = new Date().toISOString();

      // R4-#60: swap atómico (igual que _downloadProducts). Sin transacción, un crash/cierre a mitad
      // del loop dejaba la mitad de las cajas actualizadas y la otra con datos viejos.
      db.transaction(() => {
      for (const r of registers) {
        db.run(`
          INSERT INTO cash_registers (id, code, name, active, default_opening_float,
            blind_count_enabled, client_id, sucursal_id, external_pos_id, qr_url,
            point_device_id, created_at, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            code=excluded.code, name=excluded.name, active=excluded.active,
            default_opening_float=excluded.default_opening_float,
            blind_count_enabled=excluded.blind_count_enabled,
            external_pos_id=excluded.external_pos_id, qr_url=excluded.qr_url,
            point_device_id=excluded.point_device_id,
            synced_at=excluded.synced_at
        `, [
          r.id, r.code || null, r.name, r.active ? 1 : 0,
          r.defaultOpeningFloat || 0, r.blindCountEnabled ? 1 : 0,
          r.clientId || apiClient.clientId, r.sucursalId || apiClient.sucursalId,
          r.externalPosId || null, r.qrUrl || null,
          r.pointDeviceId || null, r.createdAt || null, now,
        ]);
      }
      }); // transaction() commits and persists synchronously

      this._log('DOWNLOAD_REGISTERS', `${registers.length} registers synced`, 'ok');
      console.log(`[SYNC] Cash registers synced: ${registers.length}`);
    } catch (err) {
      this._log('DOWNLOAD_REGISTERS', err.message, 'error');
      console.error('[SYNC] Register download failed:', err.message);
    }
  }

  // ── Upload error handler (C02/C14/C15) ──────────────
  // NUNCA marca 'synced' ante un error: el éxito (2xx) es el único camino a 'synced', y como el
  // backend deduplica por idempotencia (C01) ese 2xx ya trae el cloud_id real. Aquí solo decidimos
  // entre 'needs_review' (permanente, visible) y mantener 'pending' (transitorio, reintenta).
  // `table`/`idCol` son literales fijos del caller (no entrada de usuario) → seguro interpolar.
  // R4-#40: solo subir un pendiente si su tenant/sucursal de ORIGEN coincide con el usuario autenticado
  // AHORA. Si no, se deja 'pending' (lo subirá el usuario correcto) en vez de cargarlo en otra sucursal
  // /tenant. Filas viejas sin client_id/sucursal_id (null) no se bloquean (compatibilidad).
  _rowMatchesCurrentAuth(row) {
    if (row.client_id != null && apiClient.clientId != null && Number(row.client_id) !== Number(apiClient.clientId)) return false;
    if (row.sucursal_id != null && apiClient.sucursalId != null && Number(row.sucursal_id) !== Number(apiClient.sucursalId)) return false;
    return true;
  }

  _handleUploadError(db, table, idCol, idVal, err, action) {
    // R4-#42: si la DB se cerró (app cerrándose durante un sync en vuelo), NO intentar escribir el
    // estado de error — eso lanzaba un TypeError secundario sobre db=null que ocultaba la causa real.
    // La fila queda 'pending' y se reintenta de forma idempotente (por uuid) en el próximo arranque.
    try { db.get('SELECT 1'); } catch (_) {
      console.warn(`[SYNC] ${action} ${idVal}: DB no disponible (app cerrándose) — se reintentará al reabrir.`);
      return;
    }
    const kind = classifySyncError(err);
    if (kind === 'permanent') {
      db.run(`UPDATE ${table} SET sync_status = 'needs_review', sync_error = ? WHERE ${idCol} = ?`,
        [err.message, idVal]);
      this._log(action, `${idCol}=${idVal} needs_review (4xx): ${err.message}`, 'error');
      console.error(`[SYNC] ${action} ${idVal} → needs_review:`, err.message);
      return;
    }
    // transitorio: se mantiene 'pending' y se reintenta; se escala a dead-letter tras MAX reintentos.
    db.run(`UPDATE ${table} SET retry_count = COALESCE(retry_count, 0) + 1, sync_error = ? WHERE ${idCol} = ?`,
      [err.message, idVal]);
    const row = db.get(`SELECT retry_count FROM ${table} WHERE ${idCol} = ?`, [idVal]);
    if (row && row.retry_count >= MAX_SYNC_RETRIES) {
      db.run(`UPDATE ${table} SET sync_status = 'needs_review' WHERE ${idCol} = ?`, [idVal]);
      this._log(action, `${idCol}=${idVal} dead-letter tras ${row.retry_count} reintentos`, 'error');
    } else {
      this._log(action, `${idCol}=${idVal} error transitorio (intento ${row ? row.retry_count : '?'}): ${err.message}`, 'error');
    }
    console.error(`[SYNC] ${action} ${idVal} transitorio:`, err.message);
  }

  // ── Log helper ──────────────────────────────────────

  _log(action, detail, status) {
    try {
      const db = getDb();
      db.run(
        'INSERT INTO sync_log (action, detail, status) VALUES (?, ?, ?)',
        [action, detail, status]
      );
    } catch { /* ignore log failures */ }
  }
}

module.exports = { SyncService };
