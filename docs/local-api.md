# API local — Servidor HTTP offline

> Referencia del servidor HTTP local: [../src/main/local-server.js](../src/main/local-server.js).
> Emula la REST API del backend Spring Boot usando SQLite, sirve los estáticos del frontend y hace
> de proxy a la nube cuando corresponde. Para el panorama general, ver
> [architecture.md](architecture.md).

---

## 1. Qué hace este servidor

`startLocalServer()` ([local-server.js:1371](../src/main/local-server.js#L1371)) levanta un
`http.Server` en `127.0.0.1` con un **puerto aleatorio** (`listen(0)`). Resuelve dos tipos de
tráfico:

1. **No-`/api/*`** → sirve archivos estáticos del frontend desde `resources/web/`
   (`serveStaticFile`, [local-server.js:53](../src/main/local-server.js#L53)).
2. **`/api/*`** → enruta a un handler local (SQLite) o hace proxy a la nube.

El proceso main redirige el tráfico `/api/*` del renderer hacia acá vía `protocol.handle()`
(ver [architecture.md §4](architecture.md#4-ciclo-de-vida-de-un-request-api)).

## 2. Forma de las rutas

El backend expone rutas **branch-scoped**:

```
/api/client-panel/{clientId}/sucursales/{sucursalId}/{subpath}
```

`parseRoute()` ([local-server.js:122](../src/main/local-server.js#L122)) extrae `clientId`,
`sucursalId` y `subpath`. Los handlers locales se registran **por el `subpath`** (p. ej.
`'GET /items'`), salvo las rutas de auth que son top-level (`'POST /api/auth/login'`).

## 3. Pipeline del router

`http.createServer` ([local-server.js:1373](../src/main/local-server.js#L1373)) aplica, en orden:

1. **`OPTIONS`** → responde CORS preflight y corta.
2. **¿No empieza con `/api/`?** → `serveStaticFile`.
3. Parsea `query`, `route` y `body` (JSON, para POST/PUT/PATCH).
4. **Gate cloud-only** (`isCloudOnlyRoute`): si la ruta es cloud-only y hay `clientId`:
   - Admin/Dueño → `proxyToCloud`.
   - Otro rol → **403**.
5. **Búsqueda multi-sucursal** (`/inventory/all-branches`, `/products/all-branches`) → siempre
   `proxyToCloud` (cualquier rol).
6. **Creación de productos** (`POST /items`): si el rol no puede gestionar inventario → **403**.
7. **`routeRequest`** ([local-server.js:1311](../src/main/local-server.js#L1311)) → busca handler:
   - Handler local encontrado → lo ejecuta.
   - Sin handler + Admin/Dueño → `proxyToCloud` (fallback).
   - Sin handler + otro rol → **404** (`Endpoint no disponible en modo offline`).

`routeRequest` matchea primero rutas estáticas exactas y luego patrones con `:id` por regex
(items, cash-sessions/:id/…).

## 4. Roles y permisos

Definidos en [local-server.js:155-177](../src/main/local-server.js#L155):

| Constante / helper | Valor / lógica |
|--------------------|----------------|
| `ONLINE_ONLY_ROLES` | `ROLE_PROPIETARIO`, `ROLE_OWNER`, `ROLE_ADMINISTRADOR`, `ROLE_ADMIN` (admin/dueño). |
| `isAdminOrOwner()` | true si el usuario tiene algún rol de `ONLINE_ONLY_ROLES`. |
| `canManageInventory()` | true para admin/owner **o** `ROLE_INVENTARIO` / `ROLE_MULTIFUNCION`. |

> Los roles local-first (`ROLE_CAJERO`, `ROLE_INVENTARIO`, `ROLE_MULTIFUNCION`) se definen por
> exclusión: son todo lo que **no** es admin/dueño. Ver la tabla de modos en
> [architecture.md §6](architecture.md#6-los-tres-modos-de-operación).

Los roles se leen de `app_config.roles` (JSON array) — escritos en el login.

### Rutas cloud-only (`CLOUD_ONLY_PATTERNS`, [local-server.js:248](../src/main/local-server.js#L248))

Hacen proxy a la nube para admin/owner y **403** para el resto:

`/dashboard`, `/reports`, `/finance`, `/employees`, `/daily-close/*` (excepto
`/daily-close/sessions`), `/recurring-expenses`, `/providers`, `/categories`, `/purchase-orders`,
`/mercadopago/*`, `/promotions` (lista), `/promotions/{id}`, `/sucursales`.

## 5. Catálogo de endpoints locales

DTOs en **camelCase** (forma que espera el frontend). Columnas en snake_case (ver
[database.md](database.md)).

### Auth (top-level)

| Método y ruta | Handler | Comportamiento |
|---------------|---------|----------------|
| `POST /api/auth/login` | [local-server.js](../src/main/local-server.js) | Delega en `authService.login` (flujo local-first). Devuelve token, ids, roles, `offlineMode`; si el dispositivo es nuevo preserva el HTTP 403 y `requiresDeviceVerification` de la nube. Emite `loginEvents`. Ver [authentication.md](authentication.md). |
| `POST /api/auth/verify-device` | [local-server.js](../src/main/local-server.js) | Valida el código en la nube y termina el login local (persistencia de credenciales, sesión y descarga inicial). No exige JWT previo. |
| `POST /api/auth/resend-verification-code` | [local-server.js](../src/main/local-server.js) | Reenvía el código desde la nube. No exige JWT previo. |
| `GET /api/auth/me` | [:323](../src/main/local-server.js#L323) | Identidad derivada de `app_config`. 401 si no hay token. |
| `GET /api/auth/session-status` | [:338](../src/main/local-server.js#L338) | `{ active: true }`. Usado como sonda de conexión. |
| `POST /api/auth/logout` | [:342](../src/main/local-server.js#L342) | No-op (`{}`). El logout real lo maneja `index.js`. |

### Productos

| Método y ruta | Handler | Comportamiento |
|---------------|---------|----------------|
| `GET /items` (`?q=`) | [:348](../src/main/local-server.js#L348) | Lista local `active=1`. Con `q`, busca por name/code/description (LIMIT 100, prioriza match exacto de code). |
| `GET /items/:id` | [:370](../src/main/local-server.js#L370) | Un producto local activo, o 404. |
| `POST /items` | — | **Sin handler local.** El pipeline solo chequea permiso (403 si no puede gestionar inventario); luego admin/owner → proxy, otro rol → 404. La creación real es cloud-only. |

### Ventas

| Método y ruta | Handler | Comportamiento |
|---------------|---------|----------------|
| `POST /sales` | [local-server.js](../src/main/local-server.js) | Exige un turno abierto con caja válida. Crea venta `pending`, inserta `sale_items`/`sale_payments`/`sale_promotion_discounts`, **decrementa stock** (salvo `no_code`/`weighable`) y suma el efectivo a `expected_amount`. Persiste `cashRegisterId`; si un frontend anterior lo omite, lo hereda de la sesión local abierta para que la nube pueda vincularla al sincronizar. Responde 201 con `offlineCreated:true`. |
| `GET /sales` | [:495](../src/main/local-server.js#L495) | Ventas de **hoy** (LIMIT 100). |

### Cajas registradoras

| Método y ruta | Handler | Comportamiento |
|---------------|---------|----------------|
| `GET /registers` (`?onlyActive=`) | [:585](../src/main/local-server.js#L585) | **Cloud-first**: intenta la nube (timeout 8 s) para disponibilidad en tiempo real; si falla, cae al cache local con flag `_offlineWarning:true`. |
| `GET /registers/availability` (`?onlyActive=`) | `local-server.js` | Consulta el estado autoritativo en la nube al entrar en Ventas. Devuelve ocupación y responsable; offline devuelve el estado local con `availabilityVerified:false`. |

### Sesiones de caja

| Método y ruta | Handler | Comportamiento |
|---------------|---------|----------------|
| `GET /cash-sessions/current` | `local-server.js` | **Online-first y scoped** por cliente, sucursal y empleado autenticados. Vincula una apertura offline por UUID; si la nube la rechaza, la aísla como `FORCED_CLOSE/needs_review`. Nunca devuelve el turno de otro cajero. |
| `GET /cash-sessions/current/preview` | [:664](../src/main/local-server.js#L664) | Alias de `current`. |
| `GET /cash-sessions/open-preview` (`?cashRegisterId=`) | [:669](../src/main/local-server.js#L669) | Sugiere fondo de apertura (carry-over de la sesión previa o `default_opening_float`). |
| `POST /cash-sessions/open` | `local-server.js` | **Online-first**: reserva la caja en la nube con UUID idempotente antes de crear la sesión local. Un rechazo cloud (caja ocupada, otra sesión del empleado o permisos) no crea estado local. Ante una caída real de red conserva la apertura offline. |
| `POST /cash-sessions/open-with-tracking` | alias [:759](../src/main/local-server.js#L759) | = `open`. |
| `POST /shift/open` | [:761](../src/main/local-server.js#L761) | = `open`. |
| `POST /cash-sessions/close` | `local-server.js` | Cierra exclusivamente la sesión abierta del empleado autenticado: setea `counted_amount`, `difference`, `float_left_for_next`, `sync_status='pending'`. La variante `/:id/close-with-tracking` es idempotente: un retry del mismo ID devuelve el cierre existente y nunca cierra un turno nuevo. |
| `POST /cash-sessions/:id/close-with-tracking` | alias [:801](../src/main/local-server.js#L801) | = `close`. |
| `GET /cash-sessions/:id/close-preview` | [:803](../src/main/local-server.js#L803) | Preview de cierre con fórmula de efectivo esperado (apertura + ventas efectivo + inyecciones − retiros/gastos − devoluciones efectivo). `:id` puede ser `current`. |
| `GET /cash-sessions/history` | [:879](../src/main/local-server.js#L879) | Historial paginado. |
| `GET /cash-sessions/:id/sales` | [:900](../src/main/local-server.js#L900) | Ventas de la sesión (`:id` = `current` resuelve a la abierta). |
| `GET /cash-sessions/:id/returns` | [:929](../src/main/local-server.js#L929) | Devoluciones de la sesión. |
| `GET /cash-sessions/:id/expenses` | [:965](../src/main/local-server.js#L965) | Movimientos de caja de la sesión. |

### Devoluciones

| Método y ruta | Handler | Comportamiento |
|---------------|---------|----------------|
| `POST /returns` | [:1009](../src/main/local-server.js#L1009) | Valida contra la venta original (cantidades), crea `returns` + `return_items` `pending`, **restaura stock**, ajusta `expected_amount` si refund en efectivo. |
| `GET /returns` (`?saleId=&from=&to=`) | [:1115](../src/main/local-server.js#L1115) | Lista filtrable (LIMIT 100). |
| `POST /returns/:id/fiscal-document/retry` | `local-server.js` | Propietario/admin: reintenta la NC en la nube y actualiza el estado fiscal local. |

### Movimientos de caja

| Método y ruta | Handler | Comportamiento |
|---------------|---------|----------------|
| `POST /expenses` | [:1161](../src/main/local-server.js#L1161) | Crea movimiento (`INJECTION`/`WITHDRAWAL`/`ADJUSTMENT`/`EXPENSE`) `pending` y ajusta `expected_amount` de la sesión. |
| `POST /cash-movements` | alias [:1226](../src/main/local-server.js#L1226) | = `expenses`. |
| `GET /expenses` (`?sessionId=&type=&from=&to=`) | [:1228](../src/main/local-server.js#L1228) | Lista filtrable. |
| `GET /cash-movements` | alias [:1268](../src/main/local-server.js#L1268) | = `expenses`. |

### Promociones

| Método y ruta | Handler | Comportamiento |
|---------------|---------|----------------|
| `POST /promotions/apply` | [:994](../src/main/local-server.js#L994) | Offline: sin promos, devuelve totales originales sin descuento. |

> `GET /promotions` (lista) es **cloud-only por diseño**: no hay handler local. Para admin/dueño
> hace proxy a la nube; para cajero/inventario devuelve **403** (lo intercepta el gate cloud-only
> antes de `routeRequest` — ver §7).

### Daily-close y MercadoPago (stubs)

| Método y ruta | Handler | Comportamiento |
|---------------|---------|----------------|
| `GET /daily-close/preview` | [:1272](../src/main/local-server.js#L1272) | Stub `{ readyToClose:false }`. |
| `GET /daily-close/sessions` | [:533](../src/main/local-server.js#L533) | Sesiones de caja del día desde SQLite, paginadas (lo usa el RegisterPicker para saber qué cajas están ocupadas). Excluida del gate cloud-only por el lookahead `(?!sessions)`. |
| `GET /api/mercadopago-point` | [:1278](../src/main/local-server.js#L1278) | 503 — requiere internet. |

## 6. Proxy a la nube

`proxyToCloud()` ([local-server.js:184](../src/main/local-server.js#L184)) reenvía el request tal
cual al backend (`apiClient.baseUrl + url original`), con el `Authorization: Bearer <token>`
descifrado desde `app_config.auth_token`. Timeout 20 s.

**Enmascaramiento de 401:** si la nube responde 401 (JWT vencido, sesión reemplazada), NO se
reenvía al frontend —dispararía el interceptor de axios y forzaría logout—. Se devuelve **503 con
`offline:true`** para preservar la sesión local ([local-server.js:221](../src/main/local-server.js#L221)).
Cualquier otro error de red también cae en 503.

### Multipart de imágenes de productos

`PUT /items/{productId}/image` y `DELETE /items/{productId}/image` tienen un proxy específico para
propietario, administrador, inventario y multifunción. En el `PUT` conserva el `Content-Type` con
su boundary y reenvía los bytes sin convertirlos a JSON; acepta hasta 2 MB de archivo más un margen
acotado para el envelope multipart. El límite JSON general de 1 MB no cambia.

Una respuesta exitosa actualiza `image_url` y `thumbnail_url` en SQLite y encola ambas variantes
en el caché local. El caché conserva archivos raster en `userData/cache/product-images`, usa un
manifest atómico, limita su tamaño a 1 GB y reserva 1 GB libre en el disco. Las mutaciones de imagen
requieren conexión; las copias ya descargadas se sirven offline desde
`/api/local-product-images/{productId}/{image|thumbnail}`. Si cambia la URL, nunca se sirve una
versión anterior: mientras la nueva no esté disponible se usa la URL CDN o el placeholder.

En desarrollo, las URLs públicas del object storage del backend bajo
`/api/local-product-images/product-images/{clientId}/{sucursalId}/{productId}/{version}/{filename}`
se proxifican para cualquier rol. Esto equivale a la lectura pública por CloudFront en producción y
cubre el instante previo a que el caché offline termine de descargar el objeto.

## 7. Notas de comportamiento por diseño

1. **El orden del pipeline importa.** El gate cloud-only (`isCloudOnlyRoute`) se evalúa **antes**
   que `routeRequest`. Por eso una ruta cloud-only (p. ej. `GET /promotions`) nunca llega a un
   handler local aunque existiera: para cajero/inventario es **403** y para admin/dueño es proxy.
2. **`GET /daily-close/sessions` se sirve local a propósito.** `CLOUD_ONLY_PATTERNS` usa el
   lookahead `/^\/daily-close\/(?!sessions)/` para **excluir** esta ruta del proxy y atenderla
   desde SQLite; el resto de `/daily-close/*` sí es cloud-only.
3. **El proxy enmascara 401 como 503** (ver §6): si el JWT de la nube vence pero la sesión local
   sigue válida, no se fuerza el logout del frontend.

## 8. Cómo agregar un endpoint local

1. Registrá el handler en el objeto `handlers` con la clave `'<MÉTODO> <subpath>'`
   (p. ej. `handlers['GET /loyalty'] = async (req, res, body, route, query, pathParams) => {…}`).
2. Si la ruta lleva `:id`, agregá el match por regex en `routeRequest`
   ([local-server.js:1311](../src/main/local-server.js#L1311)).
3. Respondé con `jsonResponse(res, status, dto)` y DTO en **camelCase**.
4. Tras mutar datos, terminá con `db.save()`.
5. Si la operación genera un registro que debe subir a la nube, dejalo `sync_status='pending'` y
   asegurate de que el `sync-service` tenga su `_uploadPending*()` (ver
   [synchronization.md](synchronization.md)).

## Ver también

- [database.md](database.md) — tablas que tocan estos handlers.
- [synchronization.md](synchronization.md) — destino en la nube de los registros `pending`.
- [architecture.md](architecture.md) — cómo llega el request hasta acá.
</content>
