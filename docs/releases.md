# Releases, descarga y actualización automática

## Modo temporal de prueba sin firma

La variable de repositorio `POS_ALLOW_UNSIGNED_RELEASE=true` habilita una publicación de prueba
sin Authenticode. El manifest deja constancia con `signed: false` y el workflow muestra una
advertencia visible. Al configurar la firma se debe eliminar la variable o cambiarla a `false`;
la firma obligatoria sigue siendo el comportamiento predeterminado.

El canal estable vive en `https://descargas.nuventa.com.ar`. El instalador NSIS incluye el
frontend estático correspondiente a un commit exacto y `electron-updater` consulta
`/stable/latest.yml` cada seis horas. La descarga ocurre en segundo plano y la instalación se
habilita al cerrar únicamente después de guardar y respaldar SQLite.

## Activación inicial

1. Crear el bucket privado `nuventa-pos-releases` en Cloudflare R2.
2. Asociar el dominio público `descargas.nuventa.com.ar` al bucket y esperar DNS/HTTPS válidos.
3. Configurar CORS del bucket para `GET` y `HEAD` desde `https://nuventa.com.ar`,
   `https://www.nuventa.com.ar` y `https://app.nuventa.com.ar`. No permitir escrituras públicas.
4. Obtener un certificado Authenticode OV/EV exportable como PFX con timestamp habilitado.
5. Cargar los secretos del workflow de producción:

| Repositorio | Secreto | Uso |
|---|---|---|
| POS | `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` | Firma obligatoria del instalador. |
| POS | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT_URL` | Publicación S3-compatible en R2. |
| POS | `FRONTEND_REPOSITORY_TOKEN` | Checkout del commit exacto del frontend. |
| Frontend | `POS_RELEASE_DISPATCH_TOKEN` | Evento `frontend_main_updated` hacia el POS. |
| POS | `MS_STORE_PACKAGE_NAME` / `MS_STORE_PUBLISHER` / `MS_STORE_PUBLISHER_DISPLAY_NAME` | Identidad exacta de Partner Center para generar el MSIX. |

Los tokens fine-grained deben limitarse al repositorio y permiso mínimos indicados. El environment
`production` del POS no requiere aprobación manual porque el canal estable elegido es automático.

## Publicación

- Un push a `master` del POS o un evento desde `main` del frontend ejecuta el workflow central.
- La versión es `1.0.<run_number>` y siempre crece dentro del workflow.
- Se ejecutan tests, export estático, empaquetado NSIS, firma y validación Authenticode.
- Se suben primero `.exe` y `.blockmap` versionados. El alias, `release.json` y finalmente
  `latest.yml` se publican solo después del smoke público.
- `release.json` registra hashes y commits de ambos repositorios. Los objetos versionados son
  inmutables; el alias y metadatos usan `no-cache`.

## Compatibilidad y recuperación

`pos-contract.json` declara el contrato que entiende Electron. El backend expone
`GET /api/public/pos-compatibility` y su workflow bloquea contratos fuera del rango soportado.
Todo contrato anterior se conserva al menos 30 días antes de elevar el mínimo.

Antes de instalar, el POS conserva las dos últimas copias `pre-update-*.db` en
`%APPDATA%/nuventa-pos/backups`. Una corrección se publica como una versión nueva superior; nunca se
apunta `latest.yml` a una versión menor porque el autoactualizador no hace downgrade.
