# Sincronización offline-first

El contrato preferido es `pos-contract=2`. Antes del primer bundle el POS consulta
`/api/public/pos-compatibility`; sólo usa v2 cuando el backend anuncia `bundleSyncV2`. Durante la
transición conserva el uploader v1 como fallback.

## Outbox durable

Cada apertura/cierre, venta, devolución y movimiento crea, en la misma transacción SQLite, una fila
de `sync_outbox` con UUID, secuencia, fecha real, payload congelado, SHA-256, scope, intentos y estado
`PENDING`, `IN_FLIGHT` o `QUARANTINED`. La transacción sólo responde al cajero después de escribir,
releer, descifrar y ejecutar `integrity_check` sobre el archivo temporal que reemplaza atómicamente
la base anterior.

El stock visible se calcula como `stock cloud + movimientos locales no confirmados`. Un delta remoto
no puede deshacer una venta pendiente. Los catálogos SQLite están separados por cliente y sucursal,
igual que sus cursores.

## Bundle v2

`POST /api/client-panel/{clientId}/sucursales/{sucursalId}/pos-sync/v2` recibe gzip, como máximo 50
mutaciones y 1 MiB descomprimido. El backend procesa cada mutación en una transacción independiente
y en orden de dependencia: apertura, venta, devolución/movimiento y cierre. Devuelve `APPLIED`,
`APPLIED_WITH_WARNING`, `DUPLICATE`, `RETRYABLE` o `CONFLICT` por UUID.

La idempotencia se registra por cliente+sucursal+UUID+hash completo. Reenviar una respuesta perdida
no duplica venta, caja ni stock; reutilizar el UUID con otro payload queda en cuarentena.

La respuesta contiene hasta 500 cambios de un change-log monotónico. Productos, cajas y configuración
de balanza incluyen tombstones. Un cursor ausente o de más de 30 días inicia un snapshot paginado;
los eventos ocurridos durante el snapshot se leen después de su watermark.

Cada producto incluye revisión y prueba HMAC de precio. Un precio histórico con prueba válida se
conserva; una prueba inválida conserva la venta pero genera un incidente. Dos cajas pueden agotar la
última unidad offline: ambas ventas se aplican, el stock puede quedar negativo y se crea
`OFFLINE_STOCK_CONFLICT`. Las promociones no se aplican offline.

## Cadencia y diagnóstico

- Operación local: debounce de 5 segundos.
- Reconexión: reintento con jitter exponencial entre 15 segundos y 5 minutos.
- Pull condicional: cada 5 minutos.
- Cierre: no inicia red; sólo deja terminar hasta 3 segundos un ciclo existente.

El reporte exportable contiene versión, canal, estado/progreso del actualizador, códigos de error,
cursor opaco y cantidad/tamaño/antigüedad del outbox. Nunca incluye JWT, credenciales ni payloads.
