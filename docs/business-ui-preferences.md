# Preferencias del negocio y filtros de compras

`business-ui-preferences.js` conserva los tres booleanos de presentación en
`app_config`, con clave `business_ui_preferences:{clientId}`. Sin copia previa
se muestran todas las herramientas. Los permisos actuales siguen siendo
obligatorios.

- GET devuelve la copia disponible sin conexión. Con conexión renueva desde
  `/api/client-panel/{clientId}/ui-preferences`.
- PATCH exige propietario y conexión. No modifica la copia ante un error y
  nunca agrega operaciones a `sync_outbox`.
- Login online y sincronización renuevan la copia. La identidad y `authEpoch`
  se verifican antes y después de cada respuesta para evitar datos de una sesión
  anterior. Las peticiones por negocio/sesión se serializan.
- Versiones anteriores sin endpoint conservan la copia o los valores por defecto.
- Lectura de facturas requiere internet; recepción manual y borradores mantienen
  su funcionamiento offline.

El historial admite `ALL`, `DRAFT` y `AMOUNT_PENDING`. SQLite filtra antes de
contar y paginar; cero es un total conocido. Con conexión, un filtro usa los
UUID devueltos por el servidor para no presentar borradores sincronizados que
ya cambiaron de estado en otro dispositivo. Las modificaciones locales y el
historial offline se conservan.

Pruebas: `npm test` y `node test/run-electron-regressions.js --purchases`.
Estas últimas requieren el almacenamiento seguro de Windows y usan una base
temporal independiente. Empaquetar con el frontend de `actualizacion` usando
`NUVENTA_FRONTEND_DIR` apuntando a `nuventa-frontend-dev`.
