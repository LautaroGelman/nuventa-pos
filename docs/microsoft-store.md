# Microsoft Store (MSIX)

El MSIX x64 contiene el mismo frontend, código y `build-provenance.json` que el NSIS. Se genera sin
firma de CA: Partner Center firma el paquete al publicarlo. Cuando Electron informa
`process.windowsStore`, el estado del actualizador es `managed-by-store` y no se crea ninguna
petición hacia R2.

## Compilación

Se necesitan los valores exactos de **Product identity** de Partner Center:

```powershell
$env:MS_STORE_PACKAGE_NAME = '<Package/Identity/Name>'
$env:MS_STORE_PUBLISHER = '<Package/Identity/Publisher>'
$env:MS_STORE_PUBLISHER_DISPLAY_NAME = '<PublisherDisplayName>'
npm run build:store -- -Version 1.1.0.0
```

El resultado es `dist/store/Nuventa-POS_1.1.0.0_x64.msix`. La versión debe superar la mayor ya
reservada en Partner Center.

## Flight privado

Con `publish_store_flight=true`, el workflow:

1. Empaqueta el MSIX desde la misma salida web ya probada.
2. Ejecuta Windows App Certification Kit.
3. Configura Microsoft Store Developer CLI con credenciales Entra de Partner Center.
4. Envía el paquete al `MS_STORE_FLIGHT_ID` del producto `9MWQ82CX7C5B` y espera la certificación.

El piloto no instala simultáneamente NSIS y MSIX. Para cambiar de canal primero se vacía el outbox,
se desinstala el canal anterior y se vuelve a iniciar sesión.
