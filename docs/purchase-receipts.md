# Ingresos directos y sincronización

La implementación vive en `purchase-receipts.js`, `purchase-receipt-routes.js`, `purchase-receipt-sync.js` y el protocolo `sync-bundle-v2.js`. Requiere backend con migraciones V17–V22 y compras habilitadas para el negocio. SQLite agrega migraciones 15 y 16 sobre instalaciones existentes.

El borrador se guarda por UUID y alcance. Confirmar aplica stock, productos provisionales y mensaje pendiente en una transacción local. Los importes posteriores usan otro UUID y modifican el mismo ingreso sin repetir cantidades. Los productos nuevos usan `clientProductUuid`; los IDs negativos solo son locales y no se reutilizan después de resolver el ID remoto.

`PURCHASE_RECEIPT` precede a ventas y devoluciones dependientes. `PURCHASE_RECEIPT_AMOUNTS` enlaza su predecesor para resolver versiones del servidor sin reescribir el payload. Cada mensaje mantiene UUID, actor, sucursal, JSON original y hash. El ACK reasocia referencias de tablas, pero no cambia mensajes ya congelados.

Un catálogo descargado antes del ACK conserva las recepciones y precios locales pendientes. Los precios aceptados se vinculan a `receiptPriceUuid`, para que el servidor pueda conservar el importe realmente cobrado después de una revisión explícita de precios concurrentes. El catálogo posterior se aplica cuando la operación deja de estar pendiente.

Los conflictos quedan en revisión. Las rutas de resolución envían el mensaje original y las instantáneas actuales; después de cada llamada se comprueba que no haya cambiado la sesión. Una correspondencia de producto o una aprobación de catálogo permite reintentar el mismo mensaje. Las ventas dependientes siguen esperando hasta resolverlo.

Las facturas se suben y leen en el servidor. Antes de confirmar una factura localmente se guarda allí una intención de confirmación, para conservar el documento si el POS queda desconectado. Los archivos no se guardan en SQLite. Los ingresos manuales no requieren conexión después de descargar las capacidades del negocio.

## Verificación

```sh
npm run check
node test/run-electron-regressions.js
node test/run-electron-regressions.js --purchases
```

La prueba de compras utiliza un perfil temporal aislado. Comprueba migración SQLite 14→16 con datos existentes, borrador después de reiniciar, ingreso sin importe, producto nuevo con 15 recibidas y 3 vendidas, respuesta perdida, catálogo antes del ACK, referencias inmutables, importes posteriores, venta por un ID negativo ya reasociado, modalidad sin código y precios concurrentes. `contracts/purchase-pricing-v1.json` debe coincidir con el de backend y frontend.

Para producción: desplegar primero backend compatible, luego frontend/POS y habilitar un negocio piloto. El QR debe apuntar al origen público HTTPS configurado con `NEXT_PUBLIC_CAPTURE_BASE_URL`. No retirar la compatibilidad v2 ni eliminar mensajes mientras haya compras o ventas dependientes pendientes.
