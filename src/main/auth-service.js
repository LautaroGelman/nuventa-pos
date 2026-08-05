// ============================================================
// Nuventa POS — Auth Service
// Handles login logic: local-first with remote fallback.
// On first login, credentials and branch data are downloaded.
// Supports 7-day offline grace period.
// ============================================================
const crypto = require('crypto');
const { getDb } = require('./database');
const { apiClient } = require('./api-client');
const { encryptToken, decryptToken } = require('./token-crypto');
const imageCache = require('./image-cache');

const OFFLINE_MAX_DAYS = 7;

// F05: estados de suscripción que bloquean la operación offline (mismo criterio que la nube).
const BLOCKED_SUBSCRIPTION_STATES = new Set(['SUSPENDED', 'BLOCKED', 'CANCELLED', 'CANCELED', 'INACTIVE']);

// ── Helpers ──────────────────────────────────────────────

// A03/D01: el hash de login offline pasa de SHA-256 de 1 iteración (fuerza bruta trivial con GPU) a
// PBKDF2-HMAC-SHA256 con costo alto. Se guarda con prefijo de esquema `pbkdf2$<iter>$<hex>` para poder
// distinguir del legacy y verificar ambos (migración sin expulsar usuarios offline existentes).
const PBKDF2_ITERATIONS = 200000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';

function hashPassword(password, salt) {
  const derived = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
  return `pbkdf2$${PBKDF2_ITERATIONS}$${derived}`;
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Verifica una contraseña contra el hash almacenado. Soporta el esquema nuevo (PBKDF2, prefijo
 * `pbkdf2$`) y el legacy (SHA-256 hex). Los hashes legacy se re-hashean a PBKDF2 en el próximo login
 * online (que llama hashPassword). Comparación en tiempo constante.
 */
function verifyPassword(password, salt, storedHash) {
  if (!storedHash) return false;
  if (storedHash.startsWith('pbkdf2$')) {
    const parts = storedHash.split('$');
    const iterations = parseInt(parts[1], 10) || PBKDF2_ITERATIONS;
    const derived = crypto.pbkdf2Sync(password, salt, iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
    return timingSafeEqualHex(derived, parts[2]);
  }
  // Legacy SHA-256 (1 iteración): se acepta para no expulsar usuarios offline; se migra al re-login online.
  const legacy = crypto.createHash('sha256').update(salt + password).digest('hex');
  return timingSafeEqualHex(legacy, storedHash);
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function parseJwt(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
  } catch { return null; }
}

// ── Auth Service ─────────────────────────────────────────

class AuthService {
  constructor() {
    this._currentUser = null;
  }

  /**
   * Main login flow:
   * 1. Check if user exists in local DB
   * 2. If yes + online  → remote login, update local data
   * 3. If yes + offline → local login (within 7-day window)
   * 4. If no  + online  → remote login, create local user
   * 5. If no  + offline → error (must connect for first login)
   *
   * @returns {{ success, user, token, needsSync, error, isOffline }}
   */
  async login(email, password, { onStatus } = {}) {
    const db = getDb();
    const notify = onStatus || (() => {});

    // Step 1: Check if user exists locally
    const localUser = db.get('SELECT * FROM users WHERE email = ?', [email]);
    const isOnline = await this._checkOnline();

    if (localUser) {
      // ── User exists locally ──
      if (isOnline) {
        notify({ step: 'remote-login', message: 'Verificando credenciales en la nube...' });
        return await this._remoteLoginAndUpdate(email, password, localUser, notify);
      } else {
        notify({ step: 'offline-login', message: 'Sin conexión. Verificando credenciales locales...' });
        return this._offlineLogin(email, password, localUser);
      }
    } else {
      // ── User NOT in local DB ──
      if (isOnline) {
        notify({ step: 'first-login', message: 'Primer inicio de sesión. Conectando al servidor...' });
        return await this._firstRemoteLogin(email, password, notify);
      } else {
        return {
          success: false,
          error: 'Sin conexión a internet. La primera vez que iniciás sesión necesitás estar conectado para descargar los datos.',
          isOffline: true,
        };
      }
    }
  }

  /**
   * Remote login + update existing local user data.
   */
  async _remoteLoginAndUpdate(email, password, localUser, notify) {
    try {
      let result = await apiClient.login(email, password);

      // Handle 403 responses from backend
      if (result && result._httpStatus === 403) {
        return this._handle403(result);
      }

      // Handle 409 active session conflict — force logout and retry
      if (result && result._httpStatus === 409) {
        const forceResult = await this._handleActiveSessionConflict(email, password, localUser, notify);
        if (forceResult.success === false) return forceResult;
        result = forceResult; // Use the successful retry result
      }

      if (!result || !result.token) {
        return { success: false, error: 'Respuesta inesperada del servidor.' };
      }

      notify({ step: 'saving', message: 'Actualizando datos locales...' });

      // Update local user with fresh data
      const jwt = parseJwt(result.token);
      this._saveUserLocally(email, password, result, jwt);
      this._configureApiClient(result, jwt);

      // Check if branch data needs sync
      const needsSync = await this._checkBranchDataStatus(result.sucursalId, result.clientId, notify);

      this._currentUser = this._buildUserObject(result, jwt, email);

      return {
        success: true,
        user: this._currentUser,
        token: result.token,
        needsSync,
        isOffline: false,
      };
    } catch (err) {
      // Network error — fall back to offline login
      console.warn('[AUTH] Remote login failed, falling back to offline:', err.message);
      notify({ step: 'offline-fallback', message: 'Error de conexión. Usando credenciales locales...' });
      return this._offlineLogin(email, password, localUser);
    }
  }

  /**
   * First-time remote login — user doesn't exist locally yet.
   */
  async _firstRemoteLogin(email, password, notify) {
    try {
      let result = await apiClient.login(email, password);

      // Handle 403 responses from backend
      if (result && result._httpStatus === 403) {
        return this._handle403(result);
      }

      // Handle 409 active session conflict — force logout and retry
      if (result && result._httpStatus === 409) {
        const forceResult = await this._handleActiveSessionConflict(email, password, null, notify);
        if (forceResult.success === false) return forceResult;
        result = forceResult;
      }

      if (!result || !result.token) {
        return { success: false, error: 'Respuesta inesperada del servidor.' };
      }

      notify({ step: 'saving', message: 'Guardando credenciales...' });

      const jwt = parseJwt(result.token);
      this._saveUserLocally(email, password, result, jwt);
      this._configureApiClient(result, jwt);

      // First login — always need to check/download branch data
      notify({ step: 'checking-branch', message: 'Verificando datos de la sucursal...' });
      const needsSync = await this._checkBranchDataStatus(result.sucursalId, result.clientId, notify);

      this._currentUser = this._buildUserObject(result, jwt, email);

      return {
        success: true,
        user: this._currentUser,
        token: result.token,
        needsSync,
        isOffline: false,
      };
    } catch (err) {
      if (err.message && err.message.includes('HTTP 401')) {
        return { success: false, error: 'Email o contraseña incorrectos.' };
      }
      return {
        success: false,
        error: `Error al conectar con el servidor: ${err.message}`,
      };
    }
  }

  /**
   * Offline login — verify credentials against local DB.
   */
  _offlineLogin(email, password, localUser) {
    if (!localUser) {
      return {
        success: false,
        error: 'Sin conexión. El usuario no tiene datos guardados localmente.',
        isOffline: true,
      };
    }

    const db = getDb();

    // Check 7-day offline window. P2-01: el sync de fondo actualiza app_config.last_online_at en
    // cada tick online, pero users.last_online_at SOLO se escribe al hacer login online. Tomamos el
    // máximo de ambos para no bloquear a un cajero cuyo equipo sí estuvo online (vía sync) aunque no
    // haya vuelto a loguearse en 7 días.
    const cfgOnline = db.get("SELECT value FROM app_config WHERE key = 'last_online_at'");
    const onlineCandidates = [localUser.last_online_at, cfgOnline && cfgOnline.value]
      .filter(Boolean)
      .map((s) => new Date(s).getTime())
      .filter((t) => !Number.isNaN(t));
    const lastOnlineMs = onlineCandidates.length ? Math.max(...onlineCandidates) : null;
    if (lastOnlineMs) {
      const daysSinceOnline = (Date.now() - lastOnlineMs) / (1000 * 60 * 60 * 24);
      if (daysSinceOnline > OFFLINE_MAX_DAYS) {
        return {
          success: false,
          error: `Sin conexión por más de ${OFFLINE_MAX_DAYS} días. Necesitás reconectarte a internet para continuar.`,
          isOffline: true,
        };
      }
    }

    // P2-04: lockout de fuerza bruta del login offline. Sin esto, un atacante con la notebook puede
    // probar contraseñas a su ritmo (el PBKDF2 encarece cada intento pero no hay tope). Tras 5 fallos
    // consecutivos se bloquea 60s. El contador se persiste en app_config y se limpia al loguear OK.
    const failKey = `offline_login_fails_${email}`;
    let failState = { count: 0, lockedUntil: 0 };
    const failRow = db.get('SELECT value FROM app_config WHERE key = ?', [failKey]);
    if (failRow && failRow.value) { try { failState = JSON.parse(failRow.value); } catch (_) { /* corrupto → reset */ } }
    if (failState.lockedUntil && Date.now() < failState.lockedUntil) {
      const secs = Math.ceil((failState.lockedUntil - Date.now()) / 1000);
      return { success: false, error: `Demasiados intentos fallidos. Esperá ${secs}s antes de reintentar.`, isOffline: true };
    }

    // Verify password (A03: soporta PBKDF2 nuevo y SHA-256 legacy, en tiempo constante)
    if (!verifyPassword(password, localUser.pw_salt, localUser.pw_hash)) {
      failState.count = (failState.count || 0) + 1;
      if (failState.count >= 5) { failState.lockedUntil = Date.now() + 60000; failState.count = 0; }
      db.run('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)', [failKey, JSON.stringify(failState)]);
      db.save();
      return { success: false, error: 'Contraseña incorrecta.' };
    }
    // Login offline OK → limpiar el contador de fallos
    db.run('DELETE FROM app_config WHERE key = ?', [failKey]);

    // F05: gating de suscripción TAMBIÉN offline. La autoridad vive en la nube, pero un comercio
    // moroso no debe poder evitar reconectar y seguir vendiendo hasta 7 días. Si el último estado
    // conocido es SUSPENDED/BLOCKED/CANCELLED, se bloquea el login offline.
    const subStatus = String(localUser.subscription_status || 'ACTIVE').toUpperCase();
    if (BLOCKED_SUBSCRIPTION_STATES.has(subStatus)) {
      return {
        success: false,
        error: 'Tu suscripción no está activa (' + subStatus + '). Reconectate a internet para regularizar el estado de la cuenta.',
        subscriptionBlocked: true,
        subscriptionStatus: subStatus,
        isOffline: true,
      };
    }

    // Configure API client with cached data
    const token = localUser.last_token ? decryptToken(localUser.last_token) : 'offline-session-token';
    apiClient.setAuth({
      token,
      clientId: localUser.client_id,
      sucursalId: localUser.sucursal_id,
      employeeId: localUser.employee_id,
    });

    const roles = this._parseRoles(localUser.roles);
    this._currentUser = {
      email,
      token,
      clientId: localUser.client_id,
      sucursalId: localUser.sucursal_id,
      employeeId: localUser.employee_id,
      employeeName: localUser.employee_name,
      clientName: localUser.client_name,
      roles,
      subscriptionStatus: localUser.subscription_status || 'ACTIVE',
      offlineMode: true,
    };

    return {
      success: true,
      user: this._currentUser,
      token,
      needsSync: false,
      isOffline: true,
    };
  }

  /**
   * Handle 403 responses from the backend.
   */
  _handle403(result) {
    if (result.emailPending) {
      return {
        success: false,
        error: result.message || 'Debés confirmar tu email antes de iniciar sesión.',
        emailPending: true,
      };
    }
    if (result.deviceVerificationRequired) {
      return {
        success: false,
        error: result.message || 'Se requiere verificación del dispositivo.',
        deviceVerification: true,
        email: result.email,
      };
    }
    if (result.blocked) {
      return {
        success: false,
        error: result.message || 'La cuenta está bloqueada.',
        blocked: true,
      };
    }
    return {
      success: false,
      error: result.message || result.error || 'Acceso denegado.',
    };
  }

  /**
   * Handle 409 active session conflict — auto-retry with forceLogout.
   */
  async _handleActiveSessionConflict(email, password, localUser, notify) {
    notify({ step: 'force-login', message: 'Sesión activa en otro dispositivo. Cerrando sesión anterior...' });
    try {
      const result = await apiClient.login(email, password, true); // forceLogout = true
      if (result && result._httpStatus === 403) return this._handle403(result);
      if (result && result._httpStatus === 409) {
        return { success: false, error: 'No se pudo cerrar la sesión anterior. Intentá de nuevo.' };
      }
      if (!result || !result.token) {
        return { success: false, error: 'Respuesta inesperada del servidor.' };
      }
      return result;
    } catch (err) {
      return { success: false, error: `Error al reconectar: ${err.message}` };
    }
  }

  /**
   * Save or update user in local SQLite.
   */
  _saveUserLocally(email, password, loginResult, jwt) {
    const db = getDb();
    const salt = generateSalt();
    const pwHash = hashPassword(password, salt);
    const roles = Array.isArray(loginResult.roles) ? loginResult.roles
      : typeof loginResult.roles === 'string' ? [loginResult.roles] : [];
    const now = new Date().toISOString();

    db.run(`
      INSERT INTO users (email, pw_hash, pw_salt, client_id, sucursal_id,
        employee_id, employee_name, client_name, roles, subscription_status,
        last_token, last_login_at, last_online_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      ON CONFLICT(email) DO UPDATE SET
        pw_hash = ?2, pw_salt = ?3, client_id = ?4, sucursal_id = ?5,
        employee_id = ?6, employee_name = ?7, client_name = ?8,
        roles = ?9, subscription_status = ?10,
        last_token = ?11, last_login_at = ?12, last_online_at = ?13
    `, [
      email, pwHash, salt,
      loginResult.clientId || jwt?.clientId || null,
      loginResult.sucursalId || jwt?.sucursalId || null,
      loginResult.employeeId || jwt?.employeeId || null,
      loginResult.employeeName || jwt?.employeeName || '',
      loginResult.clientName || jwt?.clientName || '',
      JSON.stringify(roles),
      loginResult.subscriptionStatus || 'ACTIVE',
      encryptToken(loginResult.token),
      now, now,
    ]);

    // Also update app_config for backwards compatibility with local-server
    const set = (k, v) => db.run(
      'INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)', [k, v]
    );
    set('auth_token', encryptToken(loginResult.token));
    set('client_id', String(loginResult.clientId || jwt?.clientId || ''));
    set('sucursal_id', String(loginResult.sucursalId || jwt?.sucursalId || ''));
    set('employee_id', String(loginResult.employeeId || jwt?.employeeId || ''));
    set('employee_name', loginResult.employeeName || jwt?.employeeName || '');
    set('client_name', loginResult.clientName || jwt?.clientName || '');
    set('roles', JSON.stringify(roles));
    set('last_online_at', now);
    set('offline_email', email);
    set('offline_pw_hash', pwHash);
    set('offline_pw_salt', salt);
    set('cloud_session_revoked', '0'); // A02: un login online exitoso limpia el bloqueo por revocación

    db.save();
    console.log('[AUTH] User saved locally:', email);
  }

  /**
   * Configure the API client with login response data.
   */
  _configureApiClient(loginResult, jwt) {
    apiClient.setAuth({
      token: loginResult.token,
      clientId: loginResult.clientId || jwt?.clientId,
      sucursalId: loginResult.sucursalId || jwt?.sucursalId,
      employeeId: loginResult.employeeId || jwt?.employeeId,
    });
  }

  /**
   * Check if branch data exists locally.
   * If not, download products and registers.
   * Returns true if a full sync was needed.
   */
  async _checkBranchDataStatus(sucursalId, clientId, notify) {
    if (!sucursalId) return false;

    const db = getDb();
    const branchStatus = db.get(
      'SELECT * FROM branch_data_status WHERE sucursal_id = ?',
      [sucursalId]
    );

    if (branchStatus && branchStatus.full_sync_completed) {
      // Branch data exists — trigger background update
      notify({ step: 'updating', message: 'Actualizando datos de la sucursal...' });
      await this._downloadBranchData(sucursalId, clientId, notify);
      return false;
    } else {
      // First time for this branch — full download
      notify({ step: 'downloading', message: 'Descargando productos e inventario de la sucursal...' });
      await this._downloadBranchData(sucursalId, clientId, notify);
      // Mark branch as synced
      db.run(`
        INSERT INTO branch_data_status (sucursal_id, client_id, full_sync_completed)
        VALUES (?, ?, 1)
        ON CONFLICT(sucursal_id) DO UPDATE SET
          client_id = ?, full_sync_completed = 1
      `, [sucursalId, clientId, clientId]);
      db.save();
      return true;
    }
  }

  /**
   * Download products and registers for a branch.
   */
  async _downloadBranchData(sucursalId, clientId, notify) {
    try {
      // Download products
      notify({ step: 'products', message: 'Descargando productos...' });
      const products = await apiClient.getProducts();
      if (Array.isArray(products)) {
        const db = getDb();
        const now = new Date().toISOString();

        // R7-#52: NO pisar el quantity local de productos con ventas/devoluciones aún NO
        // sincronizadas: este download corre en cada login y, sin esta guarda, tras un re-login
        // offline el cajero vería el stock como si la venta nunca hubiera ocurrido → sobreventa.
        // Mismo set 'pendingProductIds' que sync-service.js (sólo 'pending', que SÍ van a subir).
        // R8-#99: filtrar product_id IS NOT NULL para no meter null en el Set (ítems independientes).
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

        // R7-#17: Atomic catalog swap — el deactivate-all + repoblación debe ser todo-o-nada.
        // Sin transacción, un crash/cierre/caída de red a mitad del loop persiste todos los
        // productos con active=0 y repoblación parcial → el cajero queda sin catálogo hasta el
        // próximo sync OK. Mismo patrón que sync-service.js (db.transaction commitea y persiste a
        // disco de forma síncrona; un error revierte todo).
        db.transaction(() => {
          // Deactivate all existing products (for this branch's data)
          db.exec('UPDATE products SET active = 0');

          for (const p of products) {
            // R7-#52: si el producto tiene movimientos locales pendientes, NO pisar su quantity
            // (fragmento fijo, no entrada de usuario → seguro interpolar).
            const qtyClause = pendingProductIds.has(p.id) ? '' : 'quantity=excluded.quantity,';
            // R7-#53: incluir subcategory_ids en INSERT y ON CONFLICT; antes se omitía y cada login
            // dejaba los productos con subcategory_ids='[]' (default) hasta el primer sync horario.
            db.run(`
              INSERT INTO products (id, code, no_code, name, description, price, cost,
                cost_derived, quantity, low_stock_threshold, reorder_qty_default,
                preferred_provider_id, preferred_provider_name,
                category_ids, subcategory_ids, provider_ids, image_url, thumbnail_url, active, synced_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
              ON CONFLICT(id) DO UPDATE SET
                code=excluded.code, no_code=excluded.no_code, name=excluded.name,
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
              p.id, p.code || null, p.noCode ? 1 : 0, p.name, p.description || null,
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

          // Update branch data status
          db.run(`
            UPDATE branch_data_status
            SET products_synced_at = ?
            WHERE sucursal_id = ?
          `, [now, sucursalId]);
        }); // commit + persist síncrono a disco

        imageCache.reconcileProducts(products);

        console.log(`[AUTH] Products synced: ${products.length} items`);
        notify({ step: 'products-done', message: `${products.length} productos descargados.` });
      }
    } catch (err) {
      console.error('[AUTH] Product download failed:', err.message);
      notify({ step: 'products-error', message: `Error descargando productos: ${err.message}` });
    }

    try {
      // Download cash registers
      notify({ step: 'registers', message: 'Descargando cajas registradoras...' });
      const registers = await apiClient.listRegisters(false);
      if (Array.isArray(registers)) {
        const db = getDb();
        const now = new Date().toISOString();

        // R8-#71: envolver en transacción atómica — igual que sync-service._downloadRegisters
        // (R4-#60). Un cierre abrupto a mitad del loop dejaba cash_registers parcialmente
        // actualizada, bloqueando la apertura de sesión en el próximo arranque.
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
              r.clientId || clientId, r.sucursalId || sucursalId,
              r.externalPosId || null, r.qrUrl || null,
              r.pointDeviceId || null, r.createdAt || null, now,
            ]);
          }

          // Update branch data status inside the same transaction
          db.run(`
            UPDATE branch_data_status
            SET registers_synced_at = ?
            WHERE sucursal_id = ?
          `, [now, sucursalId]);
        }); // transaction() commits + persists síncrono a disco

        db.save();
        console.log(`[AUTH] Cash registers synced: ${registers.length}`);
        notify({ step: 'registers-done', message: `${registers.length} cajas registradoras descargadas.` });
      }
    } catch (err) {
      console.error('[AUTH] Register download failed:', err.message);
      notify({ step: 'registers-error', message: `Error descargando cajas: ${err.message}` });
    }
  }

  /**
   * Check if the backend is reachable.
   */
  async _checkOnline() {
    try {
      return await apiClient.isOnline();
    } catch {
      return false;
    }
  }

  /**
   * Build a user object from login response.
   */
  _buildUserObject(loginResult, jwt, email) {
    const roles = Array.isArray(loginResult.roles) ? loginResult.roles
      : typeof loginResult.roles === 'string' ? [loginResult.roles] : [];
    return {
      email,
      token: loginResult.token,
      clientId: loginResult.clientId || jwt?.clientId,
      sucursalId: loginResult.sucursalId || jwt?.sucursalId,
      employeeId: loginResult.employeeId || jwt?.employeeId,
      employeeName: loginResult.employeeName || jwt?.employeeName || '',
      clientName: loginResult.clientName || jwt?.clientName || '',
      roles,
      subscriptionStatus: loginResult.subscriptionStatus || 'ACTIVE',
      offlineMode: false,
    };
  }

  /**
   * Parse roles from stored JSON string.
   */
  _parseRoles(rolesStr) {
    try {
      return rolesStr ? JSON.parse(rolesStr) : [];
    } catch {
      return [];
    }
  }

  /**
   * Get the currently logged-in user.
   */
  getCurrentUser() {
    return this._currentUser;
  }

  /**
   * Clear current session.
   */
  logout() {
    this._currentUser = null;
    apiClient.clearAuth();
  }
}

const authService = new AuthService();

module.exports = { authService, AuthService };
