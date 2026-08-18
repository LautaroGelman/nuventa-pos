# Microsoft Store (MSIX)

La edicion de Microsoft Store se publica como MSIX x64 sin firma. Partner Center vuelve a firmar el
paquete y Microsoft Store administra sus actualizaciones. En ejecucion, Electron expone
`process.windowsStore`; Nuventa usa esa señal para deshabilitar `electron-updater` solamente en la
edicion Store. El instalador NSIS directo conserva las actualizaciones desde R2.

## Identidad requerida

Reservar `Nuventa POS` en Partner Center y copiar desde **Product management > Product identity**:

- `Package/Identity/Name`
- `Package/Identity/Publisher`
- `Package/Properties/PublisherDisplayName`

Los valores distinguen mayusculas, espacios y puntuacion. No deben inventarse ni normalizarse.

## Compilar

```powershell
$env:MS_STORE_PACKAGE_NAME = '<Identity Name>'
$env:MS_STORE_PUBLISHER = '<Publisher>'
$env:MS_STORE_PUBLISHER_DISPLAY_NAME = '<Publisher display name>'
$env:NUVENTA_FRONTEND_DIR = '..\nuventa-frontend-pos-release'
npm run build:store
```

El resultado se escribe en `dist/store/Nuventa-POS_<version>_x64.msix`. La version se deriva de
`package.json` y se convierte a `Major.Minor.Build.0`, ya que el cuarto bloque queda reservado para
Microsoft Store.

Antes de cada envio, probar caja, impresion, modo offline, sincronizacion y cierre seguro en una
instalacion MSIX firmada para desarrollo, y ejecutar Windows App Certification Kit.

## Automatizacion

El workflow principal genera tambien el MSIX cuando existen estos secretos en el repositorio POS:

- `MS_STORE_PACKAGE_NAME`
- `MS_STORE_PUBLISHER`
- `MS_STORE_PUBLISHER_DISPLAY_NAME`

Por lo tanto, un cambio en `main` del frontend dispara una nueva compilacion NSIS y MSIX con el
commit exacto del frontend. El MSIX queda como artifact de GitHub listo para una nueva submission;
Partner Center distribuye la actualizacion despues de la carga y certificacion. Los cambios de
backend compatibles se consumen directamente desde la API y no requieren reinstalar el POS.
