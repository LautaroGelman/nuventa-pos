// ============================================================
// Nuventa POS — SQLite Database Layer (sql.js / WASM)
// Enhanced for offline-first: products, sales, cash registers,
// cash sessions, auth cache, sync tracking
// ============================================================
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

let db = null;
let dbPath = null;
let _saveTimer = null;
let _dbKey = null; // clave AES-256 para cifrar la DB en reposo (derivada del safeStorage del SO)
let _warnedNoPersist = false;     // R4-#7: avisar una sola vez del modo solo-memoria
let _loadedLegacyPlaintext = false; // R4-#55: la DB cargada estaba en texto plano (migración pendiente)

// ── Cifrado en reposo de la DB (sin dependencia nueva: node:crypto + Electron safeStorage) ──
// Antes el .sqlite quedaba en TEXTO PLANO en disco (hashes, emails, ventas, etc.). Ahora se cifra
// con AES-256-GCM; la clave vive cifrada por el SO (DPAPI en Windows) en un sidecar `nuventa-pos.dbkey`.
const DB_ENC_MAGIC = Buffer.from('NVENC1'); // marca al inicio del archivo cuando está cifrado

function getKeyPath() {
  return path.join(app.getPath('userData'), 'nuventa-pos.dbkey');
}

// Clave AES-256 (Buffer 32B) persistida cifrada con safeStorage. Null si no hay safeStorage.
function getOrCreateDbKey() {
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
  const keyPath = getKeyPath();
  try {
    if (fs.existsSync(keyPath)) {
      const b64 = safeStorage.decryptString(fs.readFileSync(keyPath));
      return Buffer.from(b64, 'base64');
    }
    const key = crypto.randomBytes(32);
    // R4-#53: permisos restrictivos (solo propietario) en POSIX; en Windows el modo se ignora.
    fs.writeFileSync(keyPath, safeStorage.encryptString(key.toString('base64')), { mode: 0o600 });
    return key;
  } catch (e) {
    console.error('[DB] No se pudo obtener/crear la clave de cifrado:', e.message);
    return null;
  }
}

function _isEncrypted(buf) {
  return buf.length >= DB_ENC_MAGIC.length && buf.subarray(0, DB_ENC_MAGIC.length).equals(DB_ENC_MAGIC);
}

function _encryptDb(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _dbKey, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([DB_ENC_MAGIC, iv, cipher.getAuthTag(), ct]);
}

function _decryptDb(file) {
  const off = DB_ENC_MAGIC.length;
  const iv = file.subarray(off, off + 12);
  const tag = file.subarray(off + 12, off + 28);
  const ct = file.subarray(off + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', _dbKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function getDbPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'nuventa-pos.db');
}

async function initDatabase() {
  dbPath = getDbPath();
  console.log('[DB] Opening database at', dbPath);

  const wasmPath = path.join(
    __dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'
  );

  const SQL = await initSqlJs({ locateFile: () => wasmPath });

  // #6: cifrado de la DB en reposo. La clave vive cifrada por el SO (safeStorage/DPAPI).
  _dbKey = getOrCreateDbKey();
  if (!_dbKey) {
    // R4-#7: sin clave NO se persiste en texto plano (ver _persist). Modo solo-memoria esta sesión.
    console.error('[DB] safeStorage NO disponible — modo SOLO-MEMORIA: la base no se persiste en disco para evitar texto plano.');
  }

  if (fs.existsSync(dbPath)) {
    let buf = fs.readFileSync(dbPath);
    if (_isEncrypted(buf)) {
      if (!_dbKey) {
        // R4-#41: hay DB cifrada pero no podemos descifrarla (safeStorage/DPAPI no disponible, o clave
        // perdida: cambio de password de Windows/SID, restore de userData en otra máquina). NO bloquear
        // el arranque: apartar la base ilegible y arrancar una nueva (el catálogo se re-descarga del
        // cloud y se exige re-login). Mejor degradar que dejar la app inutilizable para siempre.
        const aside = dbPath + '.unreadable-' + Date.now();
        try { fs.renameSync(dbPath, aside); } catch (_) { /* best-effort */ }
        console.error('[DB] DB cifrada pero sin clave para descifrarla: se apartó en ' + aside + ' y se arranca una base nueva (resync requerido).');
        db = new SQL.Database();
      } else {
        try {
          buf = _decryptDb(buf);
          db = new SQL.Database(buf);
        } catch (e) {
          // R4-#23: archivo cifrado corrupto/truncado (corte a mitad de escritura → falla el auth tag
          // GCM). Intentar el backup .bak; si no, arrancar fresca en vez de bloquear.
          console.error('[DB] No se pudo descifrar la base (' + e.message + '); intentando backup .bak…');
          db = _loadFromBakOrFresh(SQL);
        }
      }
    } else {
      // DB legacy en texto plano → se carga tal cual; el _persist() de abajo la reescribe cifrada.
      _loadedLegacyPlaintext = true;
      db = new SQL.Database(buf);
    }
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON;');
  runMigrations();
  _persist();
  console.log('[DB] Database initialized successfully');
}

function _persist() {
  if (!db || !dbPath) return;
  // R4-#7: sin clave del SO NO se escribe la DB en TEXTO PLANO (mismo criterio que token-crypto).
  // Se opera en memoria esta sesión: preferible perder persistencia a filtrar PII/hashes/ventas a disco.
  if (!_dbKey) {
    if (!_warnedNoPersist) {
      console.error('[DB] safeStorage no disponible — la base NO se persiste (modo solo-memoria) para evitar texto plano.');
      _warnedNoPersist = true;
    }
    return;
  }
  try {
    const out = _encryptDb(Buffer.from(db.export())); // #6: cifrado en reposo (siempre, ya hay clave)
    // R4-#23: escritura atómica (write-temp + rename) — un corte a mitad de un writeFileSync directo
    // dejaba la base truncada e irrecuperable (un solo byte faltante invalida el auth tag GCM).
    const tmp = dbPath + '.tmp';
    fs.writeFileSync(tmp, out, { mode: 0o600 }); // R4-#53: permisos restrictivos (ignorado en Windows)
    // R4-#23/#55: respaldar el anterior SOLO si ya estaba cifrado. Nunca respaldar una DB legacy en
    // texto plano (filtraría justo los datos que estamos migrando a cifrado).
    try {
      if (fs.existsSync(dbPath)) {
        const existing = fs.readFileSync(dbPath);
        if (_isEncrypted(existing)) fs.copyFileSync(dbPath, dbPath + '.bak');
      }
    } catch (_) { /* backup best-effort */ }
    fs.renameSync(tmp, dbPath); // rename atómico (mismo volumen) — reemplaza el contenido anterior
    if (_loadedLegacyPlaintext) {
      // R4-#55: ya reescribimos cifrado encima del legacy plano; quitar cualquier .bak heredado que
      // pudiera contener texto plano y dar por completada la migración.
      try { if (fs.existsSync(dbPath + '.bak')) fs.unlinkSync(dbPath + '.bak'); } catch (_) {}
      _loadedLegacyPlaintext = false;
      console.log('[DB] Migración a cifrado en reposo completada (legacy plano reemplazado).');
    }
  } catch (e) {
    console.error('[DB] persist error:', e.message);
  }
}

// R4-#23/#41: recuperar desde el backup .bak si la base principal no se pudo descifrar; si tampoco
// hay backup utilizable, arrancar una base nueva (resync desde el cloud) en vez de bloquear la app.
function _loadFromBakOrFresh(SQL) {
  const bak = dbPath + '.bak';
  try {
    if (fs.existsSync(bak)) {
      let bbuf = fs.readFileSync(bak);
      if (_isEncrypted(bbuf)) bbuf = _decryptDb(bbuf);
      console.error('[DB] Base recuperada desde backup .bak.');
      return new SQL.Database(bbuf);
    }
  } catch (e) {
    console.error('[DB] Backup .bak también ilegible: ' + e.message);
  }
  console.error('[DB] Sin backup utilizable: se arranca una base nueva (resync requerido).');
  return new SQL.Database();
}

// R4-#57: barrido único de tokens legacy en texto plano. Si hay safeStorage, se re-cifran; si no,
// se anulan (NULL) para no dejar el JWT legible en la DB hasta el próximo login online.
function _purgeLegacyPlaintextTokens() {
  let encryptToken;
  try { ({ encryptToken } = require('./token-crypto')); } catch (_) { return; }
  try {
    const rows = all("SELECT id, last_token FROM users WHERE last_token IS NOT NULL AND last_token NOT LIKE 'enc:%'");
    for (const r of rows) {
      db.run('UPDATE users SET last_token = ? WHERE id = ?', [encryptToken(r.last_token), r.id]);
    }
  } catch (_) { /* tabla/columna puede no existir aún en DBs muy viejas */ }
  try {
    const row = get("SELECT value FROM app_config WHERE key = 'auth_token'");
    if (row && row.value && !String(row.value).startsWith('enc:')) {
      db.run("UPDATE app_config SET value = ? WHERE key = 'auth_token'", [encryptToken(row.value)]);
    }
  } catch (_) { /* noop */ }
}

function saveSoon() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; _persist(); }, 500);
}

// ── Migrations ──────────────────────────────────────────

function runMigrations() {
  // Key-value config store
  db.run(`CREATE TABLE IF NOT EXISTS app_config (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`);

  // Products (cached from server)
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id                      INTEGER PRIMARY KEY,
    code                    TEXT,
    no_code                 INTEGER DEFAULT 0,
    -- Pesable: la columna code guarda el PLU de balanza y el precio de venta lo fija
    -- la etiqueta. No se le descuenta stock (ver local-server.js).
    weighable               INTEGER DEFAULT 0,
    max_unit_price          REAL,
    name                    TEXT NOT NULL,
    description             TEXT,
    price                   REAL NOT NULL,
    cost                    REAL,
    cost_derived            INTEGER DEFAULT 0,
    quantity                INTEGER DEFAULT 0,
    low_stock_threshold     INTEGER,
    reorder_qty_default     INTEGER,
    preferred_provider_id   INTEGER,
    preferred_provider_name TEXT,
    category_ids            TEXT,
    subcategory_ids         TEXT DEFAULT '[]',
    provider_ids            TEXT,
    image_url               TEXT,
    thumbnail_url           TEXT,
    active                  INTEGER DEFAULT 1,
    synced_at               TEXT
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_products_code   ON products(code)');
  db.run('CREATE INDEX IF NOT EXISTS idx_products_name   ON products(name)');
  db.run('CREATE INDEX IF NOT EXISTS idx_products_active ON products(active)');

  // Sales (created locally, synced to cloud)
  db.run(`CREATE TABLE IF NOT EXISTS sales (
    local_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    cloud_id          INTEGER,
    client_sale_uuid  TEXT,
    sale_date         TEXT NOT NULL,
    employee_id       INTEGER,
    employee_name     TEXT,
    status            TEXT DEFAULT 'COMPLETED',
    total_amount      REAL NOT NULL,
    total_discount    REAL DEFAULT 0,
    original_total    REAL,
    final_total       REAL,
    cash_register_id  INTEGER,
    cash_session_id   INTEGER,
    sync_status       TEXT DEFAULT 'pending',
    sync_error        TEXT,
    retry_count       INTEGER DEFAULT 0,
    created_at        TEXT DEFAULT (datetime('now','localtime')),
    synced_at         TEXT
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_sales_sync ON sales(sync_status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date)');

  db.run(`CREATE TABLE IF NOT EXISTS sale_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_local_id INTEGER NOT NULL REFERENCES sales(local_id) ON DELETE CASCADE,
    product_id    INTEGER NOT NULL,
    product_name  TEXT NOT NULL,
    product_code  TEXT,
    quantity      INTEGER NOT NULL,
    unit_price    REAL NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_local_id)');

  db.run(`CREATE TABLE IF NOT EXISTS sale_payments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_local_id  INTEGER NOT NULL REFERENCES sales(local_id) ON DELETE CASCADE,
    payment_method TEXT NOT NULL,
    amount         REAL NOT NULL,
    external_ref   TEXT
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_local_id)');

  db.run(`CREATE TABLE IF NOT EXISTS sale_promotion_discounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_local_id   INTEGER NOT NULL REFERENCES sales(local_id) ON DELETE CASCADE,
    promotion_id    INTEGER,
    promotion_name  TEXT,
    discount_amount REAL
  )`);

  // Cash Registers (cached from server)
  db.run(`CREATE TABLE IF NOT EXISTS cash_registers (
    id                      INTEGER PRIMARY KEY,
    code                    TEXT,
    name                    TEXT NOT NULL,
    active                  INTEGER DEFAULT 1,
    default_opening_float   REAL DEFAULT 0,
    blind_count_enabled     INTEGER DEFAULT 0,
    client_id               INTEGER,
    sucursal_id             INTEGER,
    external_pos_id         TEXT,
    qr_url                  TEXT,
    point_device_id         TEXT,
    created_at              TEXT,
    synced_at               TEXT
  )`);

  // Cash Sessions (tracked locally)
  db.run(`CREATE TABLE IF NOT EXISTS cash_sessions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    cloud_id            INTEGER,
    client_session_uuid TEXT,
    client_id           INTEGER,
    sucursal_id         INTEGER,
    employee_id         INTEGER,
    employee_name       TEXT,
    status              TEXT DEFAULT 'OPEN',
    business_date       TEXT,
    opening_time        TEXT,
    closing_time        TEXT,
    initial_amount      REAL DEFAULT 0,
    expected_amount     REAL DEFAULT 0,
    counted_amount      REAL,
    difference          REAL,
    cash_register_id    INTEGER,
    cash_register_name  TEXT,
    cash_register_code  TEXT,
    closing_note        TEXT,
    float_left_for_next REAL,
    sync_status         TEXT DEFAULT 'pending',
    sync_error          TEXT,
    retry_count         INTEGER DEFAULT 0,
    synced_at           TEXT
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_cash_sessions_status ON cash_sessions(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_cash_sessions_sync   ON cash_sessions(sync_status)');

  // Returns (created locally, synced to cloud)
  db.run(`CREATE TABLE IF NOT EXISTS returns (
    local_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    cloud_id            INTEGER,
    client_return_uuid  TEXT,
    sale_local_id       INTEGER,
    sale_cloud_id       INTEGER,
    return_date         TEXT NOT NULL,
    reason              TEXT,
    refund_method       TEXT,
    total_refund_amount REAL NOT NULL DEFAULT 0,
    employee_id         INTEGER,
    employee_name       TEXT,
    cash_session_id     INTEGER,
    sync_status         TEXT DEFAULT 'pending',
    sync_error          TEXT,
    retry_count         INTEGER DEFAULT 0,
    created_at          TEXT DEFAULT (datetime('now','localtime')),
    synced_at           TEXT
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_returns_sync       ON returns(sync_status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_returns_sale_local ON returns(sale_local_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_returns_date       ON returns(return_date)');

  db.run(`CREATE TABLE IF NOT EXISTS return_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    return_local_id  INTEGER NOT NULL REFERENCES returns(local_id) ON DELETE CASCADE,
    sale_item_id     INTEGER,
    product_id       INTEGER NOT NULL,
    product_name     TEXT,
    product_code     TEXT,
    quantity         INTEGER NOT NULL,
    unit_price       REAL NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items(return_local_id)');

  // Cash Movements (injections, withdrawals, expenses — created locally, synced to cloud)
  db.run(`CREATE TABLE IF NOT EXISTS cash_movements (
    local_id             INTEGER PRIMARY KEY AUTOINCREMENT,
    cloud_id             INTEGER,
    client_movement_uuid TEXT,
    type            TEXT NOT NULL,
    scope           TEXT DEFAULT 'SESSION',
    amount          REAL NOT NULL,
    description     TEXT,
    expense_category_id INTEGER,
    employee_id     INTEGER,
    employee_name   TEXT,
    cash_session_id INTEGER,
    movement_date   TEXT NOT NULL,
    sync_status     TEXT DEFAULT 'pending',
    sync_error      TEXT,
    retry_count     INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now','localtime')),
    synced_at       TEXT
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_cash_movements_sync    ON cash_movements(sync_status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(cash_session_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_cash_movements_type    ON cash_movements(type)');

  // Users (for offline-first auth — stores credentials per user)
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    email               TEXT UNIQUE NOT NULL,
    pw_hash             TEXT NOT NULL,
    pw_salt             TEXT NOT NULL,
    client_id           INTEGER,
    sucursal_id         INTEGER,
    employee_id         INTEGER,
    employee_name       TEXT,
    client_name         TEXT,
    roles               TEXT,
    subscription_status TEXT,
    last_token          TEXT,
    last_login_at       TEXT,
    last_online_at      TEXT,
    created_at          TEXT DEFAULT (datetime('now','localtime'))
  )`);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)');

  // Branch data status (tracks which branches have been synced)
  db.run(`CREATE TABLE IF NOT EXISTS branch_data_status (
    sucursal_id          INTEGER PRIMARY KEY,
    client_id            INTEGER,
    products_synced_at   TEXT,
    registers_synced_at  TEXT,
    full_sync_completed  INTEGER DEFAULT 0
  )`);

  // Sync log
  db.run(`CREATE TABLE IF NOT EXISTS sync_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    action     TEXT NOT NULL,
    detail     TEXT,
    status     TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── v2: add subcategory_ids to products (safe for existing DBs) ──
  try {
    db.run("ALTER TABLE products ADD COLUMN subcategory_ids TEXT DEFAULT '[]'");
  } catch (_) { /* column already exists */ }

  // ── v3: idempotencia de sync + dead-letter (C01/C02/C14/C15) ──
  // Clave de idempotencia generada en el POS (se envía en cada reintento, el backend deduplica)
  // y contador de reintentos para escalar a 'needs_review' cuando un error transitorio persiste.
  // Guardado en try/catch por columna: en DBs preexistentes algunas ya existen.
  const v3Columns = [
    "ALTER TABLE sales          ADD COLUMN client_sale_uuid     TEXT",
    "ALTER TABLE sales          ADD COLUMN retry_count          INTEGER DEFAULT 0",
    "ALTER TABLE returns        ADD COLUMN client_return_uuid   TEXT",
    "ALTER TABLE returns        ADD COLUMN retry_count          INTEGER DEFAULT 0",
    "ALTER TABLE cash_movements ADD COLUMN client_movement_uuid TEXT",
    "ALTER TABLE cash_movements ADD COLUMN retry_count          INTEGER DEFAULT 0",
    "ALTER TABLE cash_movements ADD COLUMN expense_category_id  INTEGER",
    "ALTER TABLE cash_sessions  ADD COLUMN client_session_uuid  TEXT",
    "ALTER TABLE cash_sessions  ADD COLUMN retry_count          INTEGER DEFAULT 0",
  ];
  for (const stmt of v3Columns) {
    try { db.run(stmt); } catch (_) { /* column already exists */ }
  }

  // ── v4: client_id/sucursal_id por fila pendiente (R4-#40) para subir al tenant/sucursal de ORIGEN,
  //        no al del usuario logueado al momento del sync. ──
  const v4Columns = [
    "ALTER TABLE sales          ADD COLUMN client_id   INTEGER",
    "ALTER TABLE sales          ADD COLUMN sucursal_id INTEGER",
    "ALTER TABLE returns        ADD COLUMN client_id   INTEGER",
    "ALTER TABLE returns        ADD COLUMN sucursal_id INTEGER",
    "ALTER TABLE cash_movements ADD COLUMN client_id   INTEGER",
    "ALTER TABLE cash_movements ADD COLUMN sucursal_id INTEGER",
    // R4-#5 p3: persistir la intención de facturar de una venta offline para reenviarla al sync
    // (antes el POS la descartaba en silencio y el cajero creía que había facturado).
    "ALTER TABLE sales          ADD COLUMN invoice_json TEXT",
  ];
  for (const stmt of v4Columns) {
    try { db.run(stmt); } catch (_) { /* column already exists */ }
  }

  // ── v5: productos PESABLES (balanza etiquetadora) ──
  // El cajero escanea la etiqueta que imprime la balanza: un EAN-13 con el PLU y el importe ya
  // calculado. El POS necesita saber qué productos son pesables para resolver el PLU y para NO
  // descontarles stock (se venden por kilo y quantity es entero).
  const v5Columns = [
    "ALTER TABLE products ADD COLUMN weighable      INTEGER DEFAULT 0",
    "ALTER TABLE products ADD COLUMN max_unit_price REAL",
  ];
  for (const stmt of v5Columns) {
    try { db.run(stmt); } catch (_) { /* column already exists */ }
  }

  // ── v6: precio EFECTIVO vs. precio ENVIADO por el cliente en un ítem de venta ──
  // `unit_price` pasa a ser siempre el precio efectivo de la línea (resuelto del catálogo local
  // cuando el frontend no lo manda). `client_unit_price` conserva sólo el precio que SÍ mandó el
  // cliente — pesable (importe de la etiqueta) o ítem independiente (precio libre) — porque es el
  // único que el sync debe reenviar a la nube: ver el comentario en POST /sales (local-server.js).
  try {
    db.run('ALTER TABLE sale_items ADD COLUMN client_unit_price REAL');
    // El ALTER no lanzó → la columna acaba de crearse, o sea que esta DB tiene filas anteriores al
    // fix. En ellas un unit_price > 0 sólo puede venir de un precio enviado por el cliente (las de
    // catálogo quedaron en 0: ése era el bug), así que sembrarlas con ese criterio preserva el
    // payload de sync de las ventas que quedaron pendientes de antes. Corre UNA sola vez.
    db.run('UPDATE sale_items SET client_unit_price = unit_price WHERE unit_price > 0');

    // Backfill de las filas que arrastran el bug (unit_price = 0 en ítems de catálogo). Se usa el
    // precio del catálogo local ACTUAL, que puede haber derivado respecto del que se cobró: es una
    // aproximación deliberada, porque la alternativa —dejar el 0— hace que una DEVOLUCIÓN offline
    // contra una de estas ventas reembolse $0 y el cierre le impute al cajero un faltante por el
    // importe completo. Errar por la deriva del precio es mucho menos que errar por el total.
    // client_unit_price queda NULL en estas filas, así que el sync las sigue omitiendo y el backend
    // recalcula desde su propio catálogo: el contrato con la nube no cambia.
    db.run(`
      UPDATE sale_items
         SET unit_price = (SELECT p.price FROM products p WHERE p.id = sale_items.product_id)
       WHERE unit_price = 0
         AND product_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM products p WHERE p.id = sale_items.product_id)
    `);

    // Y recomputar el total de las ventas que la nube nunca vio: en las ya sincronizadas
    // total_amount se reconcilió con el autoritativo del backend (R4-#26/#43), pero una venta
    // 'pending' o 'needs_review' vale $0 localmente y nadie más la va a corregir. Se excluyen las
    // que tienen final_total (promociones) porque ahí el total no sale de la suma de las líneas.
    db.run(`
      UPDATE sales
         SET total_amount = (SELECT ROUND(SUM(si.quantity * si.unit_price), 2)
                               FROM sale_items si WHERE si.sale_local_id = sales.local_id)
       WHERE total_amount = 0
         AND sync_status IN ('pending', 'needs_review')
         AND COALESCE(final_total, 0) = 0
         AND EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_local_id = sales.local_id)
    `);
  } catch (_) { /* column already exists */ }

  // v7: sólo se cachean URLs; los binarios permanecen en CloudFront y requieren conexión.
  const v7Columns = [
    "ALTER TABLE products ADD COLUMN image_url     TEXT",
    "ALTER TABLE products ADD COLUMN thumbnail_url TEXT",
  ];
  for (const stmt of v7Columns) {
    try { db.run(stmt); } catch (_) { /* column already exists */ }
  }

  // R4-#57: cerrar la ventana de tokens JWT legacy en texto plano (instalaciones previas al cifrado).
  _purgeLegacyPlaintextTokens();
}

// ── Helper wrappers ──────────────────────────────────────

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function run(sql, params = []) {
  db.run(sql, params);
  const changes = db.getRowsModified();
  const r = get('SELECT last_insert_rowid() AS id');
  saveSoon();
  return { changes, lastId: r ? Number(r.id) : 0 };
}

function exec(sql) {
  db.run(sql);
  saveSoon();
}

// Atomic unit of work. sql.js does not support nested transactions, so a
// transaction() called while another is active simply joins the outer one.
// On success the change set is flushed to disk synchronously (durable);
// on error everything is rolled back. Use this to wrap any mutation that
// spans more than one table (sale + items + payments + stock, etc.).
let _inTx = false;
function transaction(fn) {
  if (_inTx) return fn();
  _inTx = true;
  db.run('BEGIN');
  try {
    const result = fn();
    db.run('COMMIT');
    _inTx = false;
    _persist();
    return result;
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) { /* nothing to roll back */ }
    _inTx = false;
    throw e;
  }
}

// ── Public API ───────────────────────────────────────────

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return { all, get, run, exec, transaction, save: _persist };
}

function closeDatabase() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (db) { _persist(); db.close(); db = null; }
}

module.exports = { initDatabase, getDb, closeDatabase };
