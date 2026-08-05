# Base de datos — Referencia del schema SQLite

> Toda la capa de datos vive en [../src/main/database.js](../src/main/database.js). El schema se
> crea en `runMigrations()` ([database.js:60](../src/main/database.js#L60)). Antes de escribir
> queries leé también §"Reglas operativas" al final.

---

## Motor y persistencia

- **Motor:** `sql.js` — SQLite compilado a **WebAssembly**. La base es un buffer en memoria que se
  exporta a un archivo (`db.export()` → `fs.writeFileSync`).
- **Archivo:** `<userData>/nuventa-pos.db` (en Windows ≈ `%APPDATA%/nuventa-pos/nuventa-pos.db`).
- **WASM:** se carga desde `node_modules/sql.js/dist/sql-wasm.wasm`
  ([database.js:24](../src/main/database.js#L24)).
- **`PRAGMA foreign_keys = ON`** activo. Varias FK usan `ON DELETE CASCADE`.
- **Persistencia diferida:** `db.run()`/`db.exec()` programan un flush a los 500 ms (`saveSoon`);
  `db.save()` fuerza el flush inmediato. **Siempre cerrá una mutación importante con `db.save()`.**

## Helpers de acceso

`getDb()` ([database.js:321](../src/main/database.js#L321)) devuelve un objeto con:

| Método | Uso |
|--------|-----|
| `all(sql, params)` | SELECT múltiple → array de objetos. |
| `get(sql, params)` | SELECT único → objeto o `null`. |
| `run(sql, params)` | INSERT/UPDATE/DELETE → `{ changes, lastId }`. Programa flush. |
| `exec(sql)` | Ejecuta SQL sin params. Programa flush. |
| `save()` | Fuerza la serialización a disco (`_persist`). |

Parámetros: posicionales `?` o numerados `?1, ?2…`. **Nunca interpolar strings en SQL.**

## Migraciones

No hay versionado de schema (no hay tabla `schema_version`). El patrón es:

- `CREATE TABLE IF NOT EXISTS` para cada tabla — idempotente.
- `CREATE INDEX IF NOT EXISTS` para cada índice.
- Para columnas agregadas a tablas existentes: `ALTER TABLE … ADD COLUMN` envuelto en `try/catch`
  que ignora el error "la columna ya existe" (ej.: `subcategory_ids` en
  [database.js:281](../src/main/database.js#L281)).

**Para agregar una columna nueva, seguí ese patrón** (no rompe DBs viejas ni nuevas).

**Backfill de datos que debe correr UNA sola vez.** Sin tabla de versiones no hay dónde anotar
"esto ya se ejecutó", pero el propio `ALTER` sirve de compuerta: si no lanza, la columna acaba de
crearse y por lo tanto es el primer arranque con la migración. Poné el backfill **dentro** de ese
`try`, nunca después — un `UPDATE` que corra en cada arranque pisaría datos legítimos escritos por
la versión nueva. Ejemplo: la v6 de `sale_items`
([database.js:496](../src/main/database.js#L496)).

---

## Tablas (13)

### Convenciones de columnas comunes

- `local_id` / `id` — PK local autoincremental.
- `cloud_id` — ID asignado por el backend tras subir el registro (NULL hasta sincronizar).
- `sync_status` — `'pending'` | `'synced'` (algunas filas usan `sync_error` con
  `'conflict-resolved'`). Ver [synchronization.md](synchronization.md).
- `sync_error` — último mensaje de error de sync, o NULL.
- `synced_at` / `created_at` — timestamps ISO o `datetime('now','localtime')`.

---

### 1. `app_config` — almacén clave-valor
Configuración y estado de sesión que el servidor local lee en cada request.

| Columna | Tipo | Notas |
|---------|------|-------|
| `key` | TEXT PK | |
| `value` | TEXT | |

**Claves usadas:** `auth_token` (JWT cifrado), `client_id`, `sucursal_id`, `employee_id`,
`employee_name`, `client_name`, `roles` (JSON array), `last_online_at`, `last_product_sync`,
`offline_email`, `offline_pw_hash`, `offline_pw_salt`.

> El `auth_token` se **borra al cerrar la app** ([index.js:680](../src/main/index.js#L680)).

### 2. `products` — catálogo cacheado (nube → local)
Réplica local del catálogo de la sucursal. Se repuebla en cada sync (todos pasan a `active=0` y
los vigentes vuelven a `active=1`).

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | INTEGER PK | ID de la nube (no autoincremental). |
| `code` | TEXT | Código/SKU. Indexado. |
| `no_code` | INTEGER | 1 = producto sin código (no descuenta stock). |
| `name` | TEXT NOT NULL | Indexado. |
| `description` | TEXT | |
| `price` | REAL NOT NULL | Precio de venta. |
| `cost` | REAL | |
| `cost_derived` | INTEGER | |
| `quantity` | INTEGER | Stock local; se decrementa en ventas. |
| `low_stock_threshold` | INTEGER | |
| `reorder_qty_default` | INTEGER | |
| `preferred_provider_id` | INTEGER | |
| `preferred_provider_name` | TEXT | |
| `category_ids` | TEXT | JSON array. |
| `subcategory_ids` | TEXT | JSON array (agregada en migración v2). |
| `provider_ids` | TEXT | JSON array. |
| `active` | INTEGER | 1 = vigente. Indexado. |
| `synced_at` | TEXT | |

Las columnas nullable `image_url` y `thumbnail_url` guardan referencias CDN, nunca binarios. La
migración v7 las agrega con `ALTER TABLE` idempotente para instalaciones existentes.

Índices: `idx_products_code`, `idx_products_name`, `idx_products_active`.

### 3. `sales` — ventas (local → nube)

| Columna | Tipo | Notas |
|---------|------|-------|
| `local_id` | INTEGER PK AUTOINCREMENT | |
| `cloud_id` | INTEGER | |
| `sale_date` | TEXT NOT NULL | |
| `employee_id` / `employee_name` | INTEGER / TEXT | |
| `status` | TEXT | Default `'COMPLETED'`. |
| `total_amount` | REAL NOT NULL | |
| `total_discount` | REAL | |
| `original_total` / `final_total` | REAL | |
| `cash_register_id` | INTEGER | |
| `cash_session_id` | INTEGER | Sesión de caja abierta al momento de la venta. |
| `sync_status` | TEXT | Default `'pending'`. Indexado. |
| `sync_error` | TEXT | |
| `created_at` / `synced_at` | TEXT | |

Índices: `idx_sales_sync`, `idx_sales_date`.

### 4. `sale_items` — ítems de venta
FK → `sales(local_id)` `ON DELETE CASCADE`. Índice `idx_sale_items_sale`.

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `sale_local_id` | INTEGER NOT NULL (FK) | |
| `product_id` | INTEGER NOT NULL | NULL en el ítem de venta independiente. |
| `product_name` | TEXT NOT NULL | |
| `product_code` | TEXT | |
| `quantity` | INTEGER NOT NULL | |
| `unit_price` | REAL NOT NULL | Precio **efectivo** de la línea. Si el frontend no lo manda (caso normal: ítem de catálogo, donde online el precio lo pone el backend), el POS lo resuelve contra su catálogo local. |
| `client_unit_price` | REAL | Precio que **envió el cliente**: sólo pesable (importe de la etiqueta) e ítem independiente (precio libre). NULL = el precio salió del catálogo local. |

> **Por qué dos columnas de precio.** El sync reenvía a la nube **únicamente**
> `client_unit_price`. Mandar un precio resuelto del catálogo local despertaría el guard de precio
> de `SalesService` (`clientSaleUuid` + `unitPrice != null && > 0`): si el precio cambió en la nube
> entre el cacheo del catálogo y el sync, un CAJERO recibiría un 403 *"no coincide con el de
> catálogo"* y la venta caería en `needs_review`. Separando ambos, el payload de sync queda igual
> que antes y el backend sigue siendo la autoridad del precio de catálogo.
>
> Antes de la migración v6 no existía `client_unit_price` y `unit_price` quedaba en **0** para todo
> ítem de catálogo vendido en el POS. Eso arrastraba: venta valuada en $0 mientras estaba
> `pending`, y —lo serio— **devolución offline reembolsando $0**, con lo que
> `computeExpectedInCash` no descontaba la plata que el cajero sí había entregado y el cierre le
> imputaba un faltante fantasma. La v6 backfillea las filas históricas con el precio de catálogo
> actual (aproximación deliberada; ver `database.js`).

### 5. `sale_payments` — pagos de cada venta
FK → `sales(local_id)` `ON DELETE CASCADE`. Índice `idx_sale_payments_sale`.

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `sale_local_id` | INTEGER NOT NULL (FK) | |
| `payment_method` | TEXT NOT NULL | p. ej. `EFECTIVO`. |
| `amount` | REAL NOT NULL | |
| `external_ref` | TEXT | Referencia externa (p. ej. MercadoPago). |

### 6. `sale_promotion_discounts` — descuentos por promoción
FK → `sales(local_id)` `ON DELETE CASCADE`.

| Columna | Tipo |
|---------|------|
| `id` | INTEGER PK AUTOINCREMENT |
| `sale_local_id` | INTEGER NOT NULL (FK) |
| `promotion_id` | INTEGER |
| `promotion_name` | TEXT |
| `discount_amount` | REAL |

### 7. `cash_registers` — cajas registradoras (nube → local)

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | INTEGER PK | ID de la nube. |
| `code` / `name` | TEXT | `name` NOT NULL. |
| `active` | INTEGER | |
| `default_opening_float` | REAL | Fondo de apertura sugerido. |
| `blind_count_enabled` | INTEGER | Conteo ciego. |
| `client_id` / `sucursal_id` | INTEGER | |
| `external_pos_id` | TEXT | |
| `qr_url` | TEXT | |
| `point_device_id` | TEXT | Dispositivo MercadoPago Point. |
| `created_at` / `synced_at` | TEXT | |

### 8. `cash_sessions` — sesiones de caja (local → nube)
Una sesión = apertura/cierre de una caja por un empleado.

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `cloud_id` | INTEGER | |
| `client_id` / `sucursal_id` | INTEGER | |
| `employee_id` / `employee_name` | INTEGER / TEXT | |
| `status` | TEXT | `'OPEN'` \| `'CLOSED'`. Default `'OPEN'`. Indexado. |
| `business_date` | TEXT | |
| `opening_time` / `closing_time` | TEXT | |
| `initial_amount` | REAL | Fondo de apertura. |
| `expected_amount` | REAL | Esperado en caja; se ajusta con ventas/movimientos/devoluciones. |
| `counted_amount` | REAL | Conteo real al cerrar. |
| `difference` | REAL | `counted - expected`. |
| `cash_register_id` / `_name` / `_code` | INTEGER / TEXT | |
| `closing_note` | TEXT | |
| `float_left_for_next` | REAL | Fondo que queda para la próxima sesión. |
| `sync_status` | TEXT | Default `'pending'`. Indexado. **Solo se sincronizan las `CLOSED`.** |
| `sync_error` / `synced_at` | TEXT | |

Índices: `idx_cash_sessions_status`, `idx_cash_sessions_sync`.

### 9. `returns` — devoluciones (local → nube)

| Columna | Tipo | Notas |
|---------|------|-------|
| `local_id` | INTEGER PK AUTOINCREMENT | |
| `cloud_id` | INTEGER | |
| `sale_local_id` / `sale_cloud_id` | INTEGER | Venta original. |
| `return_date` | TEXT NOT NULL | |
| `reason` | TEXT | |
| `refund_method` | TEXT | p. ej. `EFECTIVO`. |
| `total_refund_amount` | REAL NOT NULL | Default 0. |
| `employee_id` / `employee_name` | INTEGER / TEXT | |
| `cash_session_id` | INTEGER | |
| `sync_status` | TEXT | Default `'pending'`. Indexado. |
| `sync_error` | TEXT | |
| `created_at` / `synced_at` | TEXT | |

Índices: `idx_returns_sync`, `idx_returns_sale_local`, `idx_returns_date`.

> Al sincronizar una devolución, el `sync-service` requiere que la **venta original ya tenga
> `cloud_id`**; si no, la difiere al próximo ciclo ([sync-service.js:258](../src/main/sync-service.js#L258)).

### 10. `return_items` — ítems devueltos
FK → `returns(local_id)` `ON DELETE CASCADE`. Índice `idx_return_items_return`.

| Columna | Tipo |
|---------|------|
| `id` | INTEGER PK AUTOINCREMENT |
| `return_local_id` | INTEGER NOT NULL (FK) |
| `sale_item_id` | INTEGER |
| `product_id` | INTEGER NOT NULL |
| `product_name` / `product_code` | TEXT |
| `quantity` | INTEGER NOT NULL |
| `unit_price` | REAL NOT NULL |

### 11. `cash_movements` — ingresos/egresos de caja (local → nube)

| Columna | Tipo | Notas |
|---------|------|-------|
| `local_id` | INTEGER PK AUTOINCREMENT | |
| `cloud_id` | INTEGER | |
| `type` | TEXT NOT NULL | `INJECTION` \| `WITHDRAWAL` \| `EXPENSE` \| `ADJUSTMENT`. Indexado. |
| `scope` | TEXT | Default `'SESSION'`. |
| `amount` | REAL NOT NULL | |
| `description` | TEXT | |
| `employee_id` / `employee_name` | INTEGER / TEXT | |
| `cash_session_id` | INTEGER | Indexado. |
| `movement_date` | TEXT NOT NULL | |
| `sync_status` | TEXT | Default `'pending'`. Indexado. |
| `sync_error` / `created_at` / `synced_at` | TEXT | |

Índices: `idx_cash_movements_sync`, `idx_cash_movements_session`, `idx_cash_movements_type`.

### 12. `users` — credenciales para login offline
Permite autenticar sin internet validando un hash local de la contraseña.

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `email` | TEXT UNIQUE NOT NULL | Indexado (único). |
| `pw_hash` | TEXT NOT NULL | `sha256(salt + password)`. |
| `pw_salt` | TEXT NOT NULL | 16 bytes hex. |
| `client_id` / `sucursal_id` / `employee_id` | INTEGER | |
| `employee_name` / `client_name` | TEXT | |
| `roles` | TEXT | JSON array. |
| `subscription_status` | TEXT | |
| `last_token` | TEXT | Último JWT (cifrado). |
| `last_login_at` / `last_online_at` | TEXT | `last_online_at` rige la gracia de 7 días. |
| `created_at` | TEXT | |

Índice único: `idx_users_email`.

> El hash `sha256(salt+password)` es para **verificación offline local**, no es el almacenamiento
> de credenciales del backend. La fuente de verdad de auth sigue siendo la nube cuando hay conexión.

### 13. `branch_data_status` — estado de descarga por sucursal
Marca si una sucursal ya hizo su descarga inicial completa (productos + cajas).

| Columna | Tipo | Notas |
|---------|------|-------|
| `sucursal_id` | INTEGER PK | |
| `client_id` | INTEGER | |
| `products_synced_at` | TEXT | |
| `registers_synced_at` | TEXT | |
| `full_sync_completed` | INTEGER | 1 cuando ya bajó todo al menos una vez. |

### 14. `sync_log` — bitácora de sincronización
Registro append-only de operaciones de sync (diagnóstico).

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `action` | TEXT NOT NULL | p. ej. `UPLOAD_SALE`, `DOWNLOAD_PRODUCTS`. |
| `detail` | TEXT | |
| `status` | TEXT | `'ok'` \| `'error'`. |
| `created_at` | TEXT | |

---

## Relaciones (resumen)

```
sales (local_id) ──┬─< sale_items (sale_local_id)
                   ├─< sale_payments (sale_local_id)
                   └─< sale_promotion_discounts (sale_local_id)

returns (local_id) ──< return_items (return_local_id)
returns.sale_local_id ─▶ sales.local_id   (lógica, no FK física)

cash_sessions (id) ◀── sales.cash_session_id
                   ◀── returns.cash_session_id
                   ◀── cash_movements.cash_session_id
cash_registers (id) ◀── cash_sessions.cash_register_id
```

Solo `sale_items`, `sale_payments`, `sale_promotion_discounts` y `return_items` tienen FK físicas
con `CASCADE`. El resto son relaciones lógicas por id.

## Reglas operativas

1. **Cerrá las mutaciones con `db.save()`** si deben persistir antes de un posible cierre.
2. **El catálogo se reemplaza, no se mergea incrementalmente**: cada descarga marca todo `active=0`
   y reactiva lo vigente ([auth-service.js:411](../src/main/auth-service.js#L411),
   [sync-service.js:445](../src/main/sync-service.js#L445)).
3. **Stock local**: las ventas decrementan `quantity` (salvo `no_code=1`); las devoluciones lo
   restauran. Es stock optimista local; la nube es la fuente de verdad tras sync.
4. **`expected_amount` de la sesión** se mantiene incrementalmente: +ventas, +inyecciones,
   −retiros/gastos, −devoluciones en efectivo.
5. **DTOs vs columnas**: las columnas son snake_case; lo que se devuelve al frontend es camelCase
   (funciones `*ToDto` en [local-server.js](../src/main/local-server.js)).

## Ver también

- [local-api.md](local-api.md) — qué endpoint lee/escribe cada tabla.
- [synchronization.md](synchronization.md) — cómo viajan los `pending` a la nube.
- [authentication.md](authentication.md) — uso de `users`, `app_config` y `branch_data_status`.
</content>
