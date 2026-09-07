# Releases, descarga y actualización automática

El código funcional se compila una vez y se distribuye por dos canales:

- NSIS (`.exe`): consulta `https://descargas.nuventa.com.ar/direct/latest.yml` con
  `electron-updater`.
- MSIX: Microsoft Store es el único actualizador; la aplicación no configura ni consulta R2.

La versión es SemVer explícita (`1.1.0`) y Store usa cuatro bloques (`1.1.0.0`). Cada paquete
incluye `build-provenance.json` con los commits exactos de POS, frontend y backend y el contrato.

## Anillos R2

- `/pilot`: piloto privado protegido por Cloudflare Access. Nunca se enlaza desde el sitio.
- `/direct`: descarga pública. Sin Authenticode se identifica como **Vista previa**.
- `/stable`: alias de compatibilidad y canal estable. Requiere Authenticode válido, timestamp y
  publisher esperado.

Los objetos con versión son inmutables. El publicador rechaza reutilizar una versión con bytes
distintos. Primero sube `.exe`, blockmap y manifiestos con caché inmutable; luego actualiza los
punteros `Nuventa-POS-Setup-latest.exe`, `release.json` y, al final, `latest.yml` con `no-store`.
La promoción entre anillos descarga y verifica los bytes ya probados: nunca recompila.

## Secretos del workflow

| Uso | Secretos |
|---|---|
| R2 | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT_URL` |
| Purga pública | `CF_CACHE_PURGE_TOKEN`, `CF_ZONE_ID` |
| Piloto privado | `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` |
| Repos relacionados | `FRONTEND_REPOSITORY_TOKEN`, opcionalmente `BACKEND_REPOSITORY_TOKEN` |
| Authenticode | `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`, `WIN_CSC_PUBLISHER_NAME` |
| Identidad MSIX | `MS_STORE_PACKAGE_NAME`, `MS_STORE_PUBLISHER`, `MS_STORE_PUBLISHER_DISPLAY_NAME` |
| Flight Store | `MS_STORE_FLIGHT_ID`, `PARTNER_CENTER_TENANT_ID`, `PARTNER_CENTER_SELLER_ID`, `PARTNER_CENTER_CLIENT_ID`, `PARTNER_CENTER_CLIENT_SECRET` |

El bucket aplica CORS de solo lectura para `nuventa.com.ar` y `www.nuventa.com.ar`. Ningún token,
payload comercial o secreto de Access se escribe en diagnósticos.

La publicación normal usa acceso a objetos R2 y verifica CORS sobre el manifiesto
versionado antes de cambiar los punteros. Configurar CORS es una tarea inicial de
administración (`publish-release.ps1 -ConfigureBucketCors`), no requiere ampliar
los permisos del token de publicación. El backend se registra con un SHA completo
en la procedencia; no se descarga ni se despliega en este workflow.

## Publicar

Ejecutar manualmente `Release Windows POS` con versión, anillo y commits exactos. `pilot` y
`direct` admiten `unsigned_preview=true`; `stable` lo bloquea. El workflow corre pruebas, genera el
instalador, valida firma/publisher, publica, vuelve a descargar los cuatro archivos y compara hashes
y el contenido exacto de `latest.yml`. El piloto comprueba además que el instalador no sea descargable
sin las credenciales de Access.

La página `/descargar` consume exclusivamente `/direct/release.json`; si falta o es inválido no
inventa un enlace alternativo.

## Recuperación

En instalaciones directas empaquetadas, la búsqueda empieza 30 segundos después
del arranque y se repite cada 6 horas. Los avisos de conexión del servicio de sync
también pueden dispararla, con separación mínima de 5 minutos. La descarga es
automática en segundo plano; instalar requiere **Reiniciar y actualizar** en el
aviso del frontend. **Más tarde** permite continuar. El cierre normal no instala
ni espera descargas (`autoInstallOnAppQuit=false`). En desarrollo está desactivado.

Antes de `quitAndInstall`, el POS bloquea operaciones nuevas, drena hasta tres segundos la petición
en curso, ejecuta `PRAGMA integrity_check` y crea un backup verificado. Un fallo cancela la
instalación y vuelve a habilitar el POS. Un rollback se publica siempre con una versión superior.
