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
y en orden de secuencia del outbox (sin agrupar por tipo entre turnos). Devuelve `APPLIED`,
`APPLIED_WITH_WARNING`, `DUPLICATE`, `RETRYABLE` o `CONFLICT` por UUID.

La idempotencia se registra por cliente+sucursal+UUID+hash completo. Reenviar una respuesta perdida
no duplica venta, caja ni stock; reutilizar el UUID con otro payload queda en cuarentena.

La respuesta contiene hasta 500 cambios de un change-log monotónico. Productos, cajas y configuración
de balanza incluyen tombstones. Un cursor ausente o de más de 30 días inicia un snapshot paginado;
los eventos ocurridos durante el snapshot se leen después de su watermark. Las páginas se guardan
en `sync_snapshot_changes`; el catálogo activo sólo se reemplaza al completar el snapshot. El cursor
y las páginas sobreviven a un reinicio. Un cambio de token o sucursal cancela la aplicación de una
respuesta del ciclo anterior.

Las operaciones incluyen `employeeId` y `clientSessionUuid`; una apertura posterior incluye
`previousSessionUuid`. El servidor exige el turno exacto y conserva las fechas de apertura/cierre.
Si entra otro empleado, las operaciones pendientes del autor anterior esperan su ingreso online
(`ORIGINAL_ACTOR_REQUIRED`). No se atribuyen al empleado nuevo. Una dependencia fallida bloquea el
resto de ese lote; los turnos independientes pueden continuar en un envío posterior.

En backend, V11 impone una sola sesión abierta por caja y por empleado/sucursal. El secuenciador
del change-log permanece bloqueado hasta commit: un cursor no puede adelantar un cambio todavía no
confirmado. Esto serializa la asignación de eventos; monitorear contención al probar carga real.
Los cursores anteriores al formato 2 provocan un snapshot de reparación.

Cada producto incluye revisión y prueba HMAC de precio. Un precio histórico con prueba válida se
conserva; una prueba inválida conserva la venta pero genera un incidente. Dos cajas pueden agotar la
última unidad offline: ambas ventas se aplican, el stock puede quedar negativo y se crea
`OFFLINE_STOCK_CONFLICT`. Las promociones no se aplican offline.

## Cadencia y diagnóstico

- Ventas, devoluciones y movimientos: guardado durable y actualización del contador, sin envío inmediato.
- Sincronización completa automática: cada 60 minutos; el botón manual puede adelantarla.
- Cerrar una caja dispara inmediatamente un ciclo completo después de persistir el cierre. También
  lo hace el reintento idempotente del cierre. Si hay otro ciclo en vuelo, queda un ciclo urgente
  encolado sin perder esa prioridad ante posteriores pedidos manuales o descargas de catálogo.
- El ciclo urgente v2 ignora `next_retry_at` de la cola inicial y supera el presupuesto ordinario
  de 20 lotes. Mantiene el orden, las dependencias, los límites de 50 operaciones/1 MiB por pedido
  y la cuarentena. Cada operación se intenta una sola vez por ciclo; los errores no generan un bucle.
- Cada 15 segundos se revisan aperturas/cierres pendientes del empleado, cliente y sucursal activos.
  Un cierre pendiente reintenta el ciclo urgente, incluso después de reiniciar e ingresar. Una
  apertura pendiente se publica sin enviar ventas ni movimientos. En v2 respeta el cierre previo.
- Inicio de sesión y selección de sucursal descargan catálogo sin mutaciones; las cajas pendientes
  tienen el tratamiento separado anterior. Las ventas solas conservan la cadencia horaria/manual.
- Sin cierres pendientes, los errores esperan al ciclo horario/manual. En ciclos ordinarios se
  conservan el máximo de 20 lotes y el backoff de cada operación.
- El fallback v1 conserva lotes de 20 filas y reintenta las cajas pendientes cada 15 segundos;
  no cierra una sesión que tenga ventas, devoluciones o movimientos sin confirmar.
- Una operación nueva demasiado grande se rechaza dentro de la transacción; una antigua se aísla
  para revisión sin impedir el envío de otras operaciones independientes.
- Cerrar la aplicación no inicia red: sólo deja terminar hasta 3 segundos un ciclo existente.

La interfaz cuenta el outbox completo, muestra incidentes y avisa cuando hace falta ingresar online.
Un cambio de catálogo sin ventas pendientes también invalida las consultas de productos del renderer.

La cadencia se cambió por pedido explícito durante el testing del 7/9/2026. No afecta las consultas
online de disponibilidad de cajas o inventario multi-sucursal, ni los cobros integrados que necesitan
una operación remota. El cierre de la app no inicia una sincronización nueva.

El reporte exportable contiene versión, canal, estado/progreso del actualizador, códigos de error,
cursor opaco y cantidad/tamaño/antigüedad del outbox. Nunca incluye JWT, credenciales ni payloads.
# Progreso del tutorial commerce-v2

GET/PUT `/api/client-panel/{clientId}/onboarding` se reenvían al backend online para el
comercio autenticado, incluidos cajeros e inventario. GET conserva `tutorialVersion` y
PUT conserva posiciones por tarea, preferencias y revisión. Las llamadas v1 siguen
funcionando sin el parámetro. La regresión de Electron verifica ambas versiones,
rechazo de otro comercio y ausencia de entradas en la cola offline.

El frontend conserva el avance de sesión si no hay conexión y reintenta su guardado;
este mecanismo es independiente de sincronizar ventas. El export comprobado del frontend
se copia a `resources/web` para revisión local. Validación: `npm run check`,
`npm run test:regressions` y `npm run test:smoke`.

## Mayorista del producto y preferencias de carga

El catálogo conserva `wholesale_enabled`, `wholesale_configured`, `wholesale_price`,
`wholesale_minimum_quantity` y `wholesale_price_proof`. La regla se aplica en cotización y venta
offline a todas las unidades cuando la cantidad agregada alcanza el mínimo. La venta guarda su
precio, mínimo y firma antes de congelar el outbox; no dependen del catálogo al sincronizar.
`sales.product_pricing_version=1` distingue el contrato nuevo de operaciones de builds anteriores.
Sin firma mayorista el POS solicita sincronizar antes de cobrar; si no hay protocolo v2 disponible,
una venta mayorista pendiente se conserva y no se envía por la ruta v1 que recalcula importes.
El inventario puede leer las reglas nativas de su catálogo local sin conexión.

Las preferencias de los switches usan claves `product_form_preferences:{clientId}:{sucursalId}`
y una cola independiente `product_form_preferences_pending:{clientId}:{sucursalId}`. Se persisten
antes de responder, se fusionan por campo y se reintentan al sincronizar. Una respuesta en vuelo
no borra cambios más recientes ni se aplica luego de cambiar la identidad. No ingresan al outbox
de ventas, y el endpoint mantiene los permisos de inventario y el aislamiento de sucursal.
Las reglas históricas con fechas/escalones mantienen su funcionamiento online hasta convertirse.

SQLite aplica la migración aditiva 14 (`product_wholesale_pricing`) también en instalaciones que
ya tienen v2. No se modifica la migración 9 existente. Las cotizaciones online nuevas incluyen
`priceQuotes` firmadas: el guardado local usa el precio cotizado para esa cantidad y conserva
su prueba en el outbox. Una cotización offline posterior vuelve al catálogo local.

## Entrega mayorista del 9/9/2026

Publicar primero el backend con V15/V16 y verificar salud, luego frontend y el instalador
del canal direct con sus commits exactos. El ticket conserva la marca mayorista registrada
al cobrar. La dependencia js-yaml se fija en 4.3.2 para incorporar la correcci?n de seguridad
GHSA-2883-xcg3-v3hh sin cambiar el contrato del actualizador.
