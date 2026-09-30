# Tiendanube en el POS

## Vinculación segura

La API de configuración `/tiendanube` sigue siendo cloud-only para dueño/administrador.
`tiendanube:authorize` sólo acepta IPC del renderer principal autenticado. Se abre una ventana
modal aislada con partición temporal, sandbox, sin preload ni integración Node. Sólo admite
inicios OAuth HTTPS en los dominios oficiales de Tiendanube/Nuvemshop. No permite nuevas
ventanas, descargas ni permisos del sistema. El JWT permanece en la ventana Nuventa original.

El main captura `/tn-callback` en el origen configurado de Nuventa, verifica el `state` y devuelve
únicamente código y state. El frontend original completa la operación usando su sesión JWT.
Al cerrar, cancelar o vencer el tiempo, se descarta el almacenamiento temporal. Cambiar de
sesión durante OAuth invalida el resultado.

## Stock compartido y conexión

El endpoint autenticado `GET /api/client-panel/{clientId}/sucursales/{sucursalId}/pos-sync/tiendanube`
responde `{active, linkedProductIds, availableStock}` para todos los roles operativos autorizados.
`availableStock` se indexa por ID de producto; descuenta reservas de pedidos online y `null`
significa sin control de stock. La metadata se guarda durablemente por comercio y sucursal.
`active` indica que sigue vigente la protección de inventario compartido. Si se revoca el token
de Tiendanube pero se conservan vínculos, continúa en `true` y la comprobación previa bloquea
ventas vinculadas hasta reconectar o desvincular explícitamente; la revocación no libera reservas.

Cada 15 segundos se consulta esta metadata. Sólo una sucursal con Tiendanube activa ejecuta
un ciclo completo de sincronización cada 15 segundos; además, sus mutaciones locales disparan
un envío urgente agrupado durante 500 ms. Las demás conservan el ciclo horario/manual y el
envío al cerrar caja. Logout, cambio de sucursal y apagado cancelan o invalidan trabajo pendiente.

Antes de aceptar una venta de un producto vinculado, el POS espera la sincronización de las
operaciones anteriores, verifica que no queden operaciones pendientes o en revisión y vuelve
a consultar el endpoint con `?refreshReservations=true`. Esta lectura reconcilia las reservas
en Tiendanube y rechaza la venta si no alcanza el disponible o no se puede consultar la nube.
Las líneas repetidas de un producto se suman. Las solicitudes de venta se serializan para
no reutilizar una misma lectura antes de registrar la operación anterior.

La comprobación sucede antes de modificar stock/caja locales. Una venta rechazada por falta
de conexión o stock no se registra para sincronización posterior: el cajero debe resolver el
mensaje antes de cobrar. Las ventas locales ya confirmadas conservan su UUID y reintento
idempotente. Una venta compartida confirmada se envía de inmediato por el ciclo urgente.

Después de actualizar o instalar el POS se necesita una primera conexión para conocer la
política de la sucursal. Luego los productos conocidos como no vinculados conservan su venta
offline. No debe activarse una vinculación nueva mientras haya terminales desconectadas o
ventas sin sincronizar: un equipo desconectado no puede conocer cambios remotos de vínculos.

La API remota no ofrece una transacción atómica entre el checkout de Tiendanube y el POS.
La lectura previa y el envío rápido reducen esa ventana; no equivalen a una reserva distribuida
ni garantizan ausencia absoluta de conflictos entre compras simultáneas en ambos canales.

## Verificación

`test/tiendanube-oauth.test.js`: origen/state, aislamiento y retorno sin credenciales.
`test/tiendanube-policy.test.js`: tenant/sucursal, reservas, offline, pendientes y exclusión mutua.
`test/sync-service.test.js`: envío agrupado urgente y fallos de la comprobación previa.
