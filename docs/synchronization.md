# Sincronización

> El servicio de background que reconcilia SQLite local ↔ nube.
> Archivo: [../src/main/sync-service.js](../src/main/sync-service.js). Habla con la nube a través de
> [../src/main/api-client.js](../src/main/api-client.js).

---

## 1. Qué sincroniza

`SyncService` es un `EventEmitter` que en cada ciclo (`_tick`,
[sync-service.js:56](../src/main/sync-service.js#L56)):

**Sube (local → nube)**, en lotes de `BATCH_SIZE = 20`:
1. Ventas `pending` → `_uploadPendingSales` ([:148](../src/main/sync-service.js#L148))
2. Devoluciones `pending` → `_uploadPendingReturns` ([:234](../src/main/sync-service.js#L234))
3. Movimientos de caja `pending` → `_uploadPendingCashMovements` ([:310](../src/main/sync-service.js#L310))
4. Sesiones de caja `pending` **y `CLOSED`** → `_uploadPendingCashSessions` ([:367](../src/main/sync-service.js#L367))

**Baja (nube → local)**, si hay token:
5. Catálogo de productos → `_downloadProducts` ([:434](../src/main/sync-service.js#L434))
6. Cajas registradoras → `_downloadRegisters` ([:493](../src/main/sync-service.js#L493))

## 2. Cadencia

| Parámetro | Valor | Constante |
|-----------|-------|-----------|
| Ciclo normal | **1 hora** | `SYNC_INTERVAL_MS = 3_600_000` |
| Reintento si está offline | **5 minutos** | `RETRY_INTERVAL_MS = 300_000` |
| Primer ciclo tras arrancar | ~3 segundos | `setTimeout` en `start()` |
| Tamaño de lote | 20 | `BATCH_SIZE` |

- `start()` ([:24](../src/main/sync-service.js#L24)) programa el intervalo horario y un primer
  tick a los 3 s.
- Si un tick detecta que no hay conexión, programa un **reintento a los 5 min** (`_scheduleRetry`).
  Al reconectar, el reintento se cancela y vuelve la cadencia horaria.
- `forceSync()` ([:121](../src/main/sync-service.js#L121)) dispara un tick inmediato (lo usan el
  botón de sync manual y el menú "Forzar sincronización").
- Guard de reentrada: `_running` evita ticks solapados.
- Guard de sucursal: si falta un `sucursalId` positivo (caso propietario antes de elegir), el tick
  informa `waitingForBranch` y no sube ni descarga datos. Nunca se generan rutas con `undefined`.
- Si cambia la sucursal durante un tick, `authEpoch` aborta el resto y se encola un ciclo inmediato
  para la nueva sucursal.

## 3. Anatomía de un tick

```
_tick()
  ├─ apiClient.isOnline()?  ── no ─▶ emit('sync-status', {online:false}); _scheduleRetry(); return
  │                          └ sí ─▶ _cancelRetry()
  ├─ app_config.last_online_at = now
  ├─ subir ventas / devoluciones / movimientos / sesiones cerradas
  ├─ (si hay token) bajar productos + cajas
  ├─ si totalSynced > 0 → emit('sync-complete', { sales, returns, movements, sessions, total })
  └─ emit('sync-status', {online:true, syncing:false})
```

Errores del tick → `emit('sync-status', {online:false})` + reintento programado.

## 4. Eventos (consumidos por `index.js`)

`index.js` ([:660](../src/main/index.js#L660)) escucha y reenvía al renderer:

| Evento | Payload | Uso en el renderer |
|--------|---------|--------------------|
| `sync-status` | `{ online, syncing }` | El frontend actualiza el botón/indicador de sync. |
| `sync-complete` | `{ sales, returns, movements, sessions, total }` | Notifica cuántos registros subieron. |
| `products-updated` | — | Señala que el catálogo local cambió. |

## 5. Mapeo local → payload de la nube

Cada uploader transforma filas snake_case en el payload camelCase que espera el backend, vía
`api-client` (ver [modules.md](modules.md)). Resumen de endpoints destino:

| Origen local | Endpoint de la nube | Método de `api-client` |
|--------------|---------------------|------------------------|
| `sales` (+ items/payments/promos) | `…/sales` | `createSale` |
| `returns` (+ return_items) | `…/returns` | `createReturn` |
| `cash_movements` | `…/cash-movements` | `createCashMovement` |
| `cash_sessions` (CLOSED) | `…/cash-sessions/open` luego `…/{id}/close-with-tracking` | `openSession` + `closeSession` |
| productos (bajada) | `…/items` | `getProducts` |
| cajas (bajada) | `…/registers?onlyActive=false` | `listRegisters` |

### Detalles que importan
- **Ventas y caja**: el payload incluye `clientSessionUuid` y `cashRegisterId`. Para compatibilidad
  con ventas creadas por builds viejos, si `sales.cash_register_id` está vacío se recupera la caja
  desde la `cash_session` local asociada; sin ese dato el backend no puede autoabrir la sesión cloud.
- **Sesiones de caja**: solo se suben las `CLOSED`. La nube no acepta "crear una sesión ya
  cerrada", así que el uploader la **abre y luego la cierra** con los conteos registrados
  ([:382](../src/main/sync-service.js#L382)).
  Si la apertura fue confirmada online, el POS ya guarda `cloud_id`: al cerrar omite una nueva
  apertura y cierra exactamente esa sesión cloud. Si se abrió offline, conserva el UUID para que
  el alta posterior sea idempotente.
  Al consultar la sesión actual con conectividad, el POS la reconcilia primero con la nube y
  siempre limita la sesión local por `client_id`, `sucursal_id` y `employee_id`; una fila residual
  de otro cajero no habilita ventas ni cierre.
- **Devoluciones**: necesitan el `cloud_id` de la venta original. Si la venta aún no se subió, la
  devolución se **difiere** al próximo ciclo ([:258](../src/main/sync-service.js#L258)). Por eso el
  orden importa: ventas antes que devoluciones.

- Una devolución local nace con `fiscal_status=PENDING_SYNC`. Al subirla se guardan el estado,
  número, CAE y mensaje de `fiscalDocument` devuelto por el backend. El `cloud_id` se toma de
  `saleReturnId` (con compatibilidad para respuestas legacy con `id`). Los ciclos posteriores
  refrescan estados `PENDING`/`WAITING_ORIGINAL`, para incorporar el CAE que ARCA autorice luego.
- **Descarga de catálogo**: reemplaza, no mergea. Marca todo `active=0` y reactiva lo que llega.
  Actualiza `app_config.last_product_sync`.

## 6. Resolución de conflictos

Tras subir un registro:
- **Éxito 2xx** → `sync_status='synced'`, guarda `cloud_id`, limpia `sync_error`.
- **4xx permanente** → `sync_status='needs_review'`; no se considera sincronizado. En ventas, al
  producirse esta transición se reintegra el stock local porque la nube no procesó la operación.
- **Error transitorio** → guarda el mensaje en `sync_error`, mantiene `pending` y reintenta hasta
  el límite configurado; luego pasa a `needs_review`.

Para sesiones, también se trata como conflicto el mensaje "ya tiene una sesión abierta"
([:412](../src/main/sync-service.js#L412)).

## 7. Estado y diagnóstico

- `getStatus()` ([:126](../src/main/sync-service.js#L126)) devuelve los contadores de pendientes
  (`pendingSales`, `pendingReturns`, `pendingMovements`, `pendingSessions`, `pendingTotal`) y
  `lastSyncAt`. Expuesto al renderer por IPC `sync:status`.
- Cada operación se registra en la tabla `sync_log` (`_log`, [:534](../src/main/sync-service.js#L534)):
  `action`, `detail`, `status`.
- El menú "Estado offline" ([index.js:548](../src/main/index.js#L548)) muestra un resumen
  (conexión, usuarios, productos, cajas, ventas pendientes, último sync).

## 8. Relación con el ciclo de vida

- El sync arranca tras un login exitoso **solo si hay conexión** (un login offline no lo arranca;
  ver [authentication.md](authentication.md)).
- Se detiene en cada logout (`clearLocalToken` → `syncService.stop()`).
- En `window-all-closed` se detiene y la app borra el `auth_token`.

## 9. Cómo agregar un tipo nuevo de sincronización

1. Asegurate de que el endpoint local deje el registro con `sync_status='pending'` (ver
   [local-api.md](local-api.md)).
2. Agregá un `_uploadPendingX()` siguiendo el patrón existente: leer `pending` (LIMIT
   `BATCH_SIZE`), mapear a payload camelCase, llamar al `api-client`, marcar `synced`/`cloud_id`,
   tratar 409/400 como conflicto resuelto.
3. Agregá su método correspondiente en `api-client` ([modules.md](modules.md)).
4. Llamalo desde `_tick()` en el orden correcto (respetá dependencias, como ventas→devoluciones).
5. Sumá su contador a `getStatus()` y al evento `sync-complete`.

## Ver también

- [database.md](database.md) — los `sync_status` y las tablas que se suben.
- [local-api.md](local-api.md) — dónde se crean los registros `pending`.
- [modules.md](modules.md) — `api-client`, el cliente HTTP que usa el sync.
- [authentication.md](authentication.md) — cuándo arranca/para el servicio.
</content>
