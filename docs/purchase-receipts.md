# Ingresos directos y sincronización

La implementación vive en `purchase-receipts.js`, `purchase-receipt-routes.js`, `purchase-receipt-sync.js` y el protocolo `sync-bundle-v2.js`. Requiere backend con migraciones V17–V22 y compras habilitadas para el negocio. SQLite agrega migraciones 15 y 16 sobre instalaciones existentes.

El borrador se guarda por UUID y alcance. Confirmar aplica stock, productos provisionales y mensaje pendiente en una transacción local. Los importes posteriores usan otro UUID y modifican el mismo ingreso sin repetir cantidades. Los productos nuevos usan `clientProductUuid`; los IDs negativos solo son locales y no se reutilizan después de resolver el ID remoto.

Editar en el POS un borrador descargado lo marca como pendiente: las lecturas de historial y detalle conservan esa copia local, también después de reiniciar. Guardar sin cambios mantiene su estado sincronizado y permite recibir nuevas versiones remotas. La descarga actualiza juntos el estado, la versión y el contenido; una versión anterior no puede reabrir un ingreso confirmado.

`PURCHASE_RECEIPT` precede a ventas y devoluciones dependientes. `PURCHASE_RECEIPT_AMOUNTS` enlaza su predecesor para resolver versiones del servidor sin reescribir el payload. Cada mensaje mantiene UUID, actor, sucursal, JSON original y hash. El ACK reasocia referencias de tablas, pero no cambia mensajes ya congelados.

Un catálogo descargado antes del ACK conserva las recepciones y precios locales pendientes. Los precios aceptados se vinculan a `receiptPriceUuid`, para que el servidor pueda conservar el importe realmente cobrado después de una revisión explícita de precios concurrentes. El catálogo posterior se aplica cuando la operación deja de estar pendiente.

Los costos locales también se conservan al elegir `KEEP`, tanto al confirmar como al completar importes. `purchase-receipt-pending.js` identifica la última operación de costo por producto desde la cola persistida; incluye mensajes en revisión y referencias provisionales, sin modificar payloads ni requerir otra migración. Un ACK anterior conserva el costo de una operación local todavía pendiente. El precio remoto puede actualizarse de forma independiente cuando no hay un cambio local de precio pendiente.

Los conflictos quedan en revisión. Las rutas de resolución envían el mensaje original y las instantáneas actuales; después de cada llamada se comprueba que no haya cambiado la sesión. Una correspondencia de producto o una aprobación de catálogo permite reintentar el mismo mensaje. Las ventas dependientes siguen esperando hasta resolverlo.

Las facturas se suben y leen en el servidor. Antes de confirmar una factura localmente se guarda allí una intención de confirmación, para conservar el documento si el POS queda desconectado. Los archivos no se guardan en SQLite. Los ingresos manuales no requieren conexión después de descargar las capacidades del negocio.

## Correcciones por renglón y ventas sin stock

La capacidad `receiptCorrections` habilita las rutas locales `/{uuid}/lines/{lineUuid}/corrections/preview` y `/corrections`. La migración SQLite 17 conserva colas anteriores y añade deltas firmados, revisión de precios y procedencia de cada aplicación. `PURCHASE_RECEIPT_CORRECTION` persiste junto con el resultado local y conserva actor, predecesor, payload y hash. Las descargas y los ACK usan los movimientos originales/compensatorios y preservan operaciones posteriores pendientes; los IDs provisionales nunca obligan a reescribir el mensaje.

Un conflicto conserva la operación para revisión explícita y bloquea sus dependencias. Ventas ajenas de la misma caja pueden continuar en una sincronización posterior. Los precios de ventas offline se vinculan también al UUID de corrección. Los cambios de catálogo diferidos no alteran la revisión de precios local. Las ventas con stock cero, negativo o insuficiente descuentan todas las unidades y devuelven advertencias; se excluyen pesables, ítems libres y productos sin control de stock.

`test/purchase-receipt-corrections-regressions.js` se ejecuta con `--purchases`: compensación tras ventas, reasignación, packs, restauración agrupada, roles, reinicio, catálogo antes de ACK, pérdida de respuesta, producto provisional y conflicto con venta dependiente/ajena. La prueba de migración ahora cubre SQLite 14→17.

El contrato, diagnóstico de salud y orden backend → frontend/POS → piloto están documentados en el checkout backend, `docs/correcciones-ingresos-y-ventas-sin-stock.md`. El instalador local generado para validar esta entrega no se publicó ni se firmó para distribución.

## Comandos de verificación

```sh
npm run check
node test/run-electron-regressions.js
node test/run-electron-regressions.js --purchases
```

La prueba de compras utiliza un perfil temporal aislado. Comprueba migración SQLite 14→16 con datos existentes, borrador después de reiniciar, ingreso sin importe, producto nuevo con 15 recibidas y 3 vendidas, respuesta perdida, catálogo antes del ACK, referencias inmutables, importes posteriores, venta por un ID negativo ya reasociado, modalidad sin código y precios concurrentes. `contracts/purchase-pricing-v1.json` debe coincidir con el de backend y frontend.

Incluye `test/purchase-receipts-review-regressions.js`: borrador web editado en POS, refrescos de historial/detalle, transición remota a confirmado, versiones atrasadas, costo con `KEEP`, importes consecutivos, reinicios, ACKs anteriores a cambios locales pendientes y reasociación de un producto provisional con importes pendientes.

Para producción: desplegar primero backend compatible, luego frontend/POS y habilitar un negocio piloto. El QR debe apuntar al origen público HTTPS configurado con `NEXT_PUBLIC_CAPTURE_BASE_URL`. No retirar la compatibilidad v2 ni eliminar mensajes mientras haya compras o ventas dependientes pendientes.
# Privacidad y aviso de IA

`GET/POST /purchase-receipts/ai-notice` se reenvía al backend con el ámbito y autenticación habituales. No se cachea una aceptación, no se encola offline y no se interpreta un error/404 como elección positiva. Sin conexión, ofrecer ingreso manual. Requiere el frontend y backend compatibles; la bandera de activación y el manifiesto legal se administran en el servidor, tras la publicación y comunicación correspondientes.

El POS transmite las referencias del aviso de términos que reciba de la interfaz en login/verificación. Un rechazo `LEGAL_DOCUMENT_CHANGED` no se trata como una caída de red para entrar offline. El fallback nativo que no envía esas referencias no acredita una aceptación nueva. Las copias completas del texto se incluyen bajo `resources/web/legal/<hash>.txt` al empaquetar el frontend y se sirven como texto UTF-8.

# Carga de facturas completas

Web y POS vuelven a usar `/documents/{uuid}/files` con multipart binario y su boundary. Se admiten PDF, fotos y conversión HEIC con conservación del original cuando corresponde. El backend procesa el documento completo según la configuración de lectura. El aviso inicial de IA se conserva; no hay revisión de recortes ni declaración por factura.

Sin conexión no se encolan archivos ni se simula extracción. El ingreso manual sigue disponible. El frontend compartido ya no necesita empaquetar un runtime PDF/OCR local para esta función.
