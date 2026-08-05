# Autenticación

> Cubre el login local-first, la captura del token desde la web, el cifrado en reposo y el logout.
> Archivos: [../src/main/auth-service.js](../src/main/auth-service.js),
> [../src/main/token-crypto.js](../src/main/token-crypto.js),
> el *token watcher* en [../src/main/index.js](../src/main/index.js) y el
> [../src/preload/index.js](../src/preload/index.js).

---

## 1. Dos caminos de login

El frontend de Nuventa hace el login normal por la web (`POST /api/auth/login`). En Electron ese
request lo atiende el **servidor local**, que delega en `authService.login()`. Además existe una
**página de fallback offline** (`src/renderer/`) que se usa solo si la web no carga; llama a
`window.nuventaAuth.offlineLogin()` vía IPC, que termina en el mismo `authService.login()`.

> Resultado: hay una sola lógica de login (`auth-service.js`), alcanzable por dos rutas (la web
> interceptada y la página de fallback).

## 2. La matriz de decisión

`AuthService.login(email, password)` ([auth-service.js:48](../src/main/auth-service.js#L48))
combina "¿existe el usuario localmente?" × "¿hay internet?":

| Usuario en `users` | Conexión | Acción | Método |
|--------------------|----------|--------|--------|
| Sí | Online | Login remoto + actualizar datos locales | `_remoteLoginAndUpdate` ([:83](../src/main/auth-service.js#L83)) |
| Sí | Offline | Login local por hash (ventana de 7 días) | `_offlineLogin` ([:186](../src/main/auth-service.js#L186)) |
| No | Online | Primer login remoto + descarga de sucursal | `_firstRemoteLogin` ([:133](../src/main/auth-service.js#L133)) |
| No | Offline | Error: hay que conectarse al menos una vez | — |

La conexión se sondea con `apiClient.isOnline()` (`GET /api/auth/session-status`, timeout 5 s).

### Login remoto (usuario existente u online por primera vez)
1. `apiClient.login(email, password)` contra la nube.
2. Maneja respuestas especiales (ver §3).
3. `_saveUserLocally()` persiste el usuario (hash de contraseña + datos + token) en `users` **y** en
   `app_config`.
4. `_configureApiClient()` carga el token en el cliente HTTP.
5. `_checkBranchDataStatus()` descarga productos + cajas si la sucursal no fue sincronizada.
6. Si la red falla a mitad de camino, hace *fallback* a `_offlineLogin`.

### Login offline
1. Verifica la **ventana de gracia**: si `last_online_at` es de hace más de `OFFLINE_MAX_DAYS`
   (= **7 días**, [auth-service.js:12](../src/main/auth-service.js#L12)) → error, debe reconectarse.
2. Compara `sha256(salt + password)` contra `pw_hash` en `users`.
3. Configura el `apiClient` con el último token cacheado (o `'offline-session-token'`).
4. Devuelve el usuario con `offlineMode:true`.

## 3. Respuestas especiales del backend

`_handle403()` ([auth-service.js:248](../src/main/auth-service.js#L248)) traduce 403 a flags:

| Flag del backend | Significado | Devuelve |
|------------------|-------------|----------|
| `emailPending` | Falta confirmar email | `{ emailPending:true }` |
| `deviceVerificationRequired` | Verificación de dispositivo | `{ deviceVerification:true, email }` |
| `blocked` | Cuenta bloqueada | `{ blocked:true }` |

**409 — sesión activa en otro dispositivo:** `_handleActiveSessionConflict()`
([auth-service.js:280](../src/main/auth-service.js#L280)) reintenta automáticamente con
`forceLogout=true` (cierra la sesión anterior sin preguntar).

> El `api-client` también soporta `verifyDevice`, `resendVerificationCode` (ver
> [modules.md](modules.md)), pero el flujo de verificación visible lo maneja el frontend web.

## 4. Descarga inicial de la sucursal

En el primer login para una sucursal, `_downloadBranchData()`
([auth-service.js:401](../src/main/auth-service.js#L401)) baja:

- **Productos** (`apiClient.getProducts()`): marca todo `active=0` y reactiva lo vigente.
- **Cajas registradoras** (`apiClient.listRegisters(false)`).

El estado queda registrado en `branch_data_status` (`full_sync_completed=1`) para no re-descargar
en cada login. El progreso se notifica vía callbacks `onStatus` → `loginEvents` → renderer.

## 5. Captura del token desde la web (token watcher)

Cuando el login ocurre por la **web** (no por la página de fallback), el JWT queda en
`sessionStorage.token` del renderer. El proceso main lo vigila por **polling cada 2 s**
(`startTokenWatcher`, [index.js:189](../src/main/index.js#L189)):

- **Token nuevo detectado** → `handleTokenCaptured()` ([index.js:222](../src/main/index.js#L222)):
  1. Parsea el JWT (`clientId`, `sucursalId`, `employeeId`, `sub`, …).
  2. Configura el `apiClient`.
  3. Persiste en `app_config` + `users` (token **cifrado**).
  4. Arranca el `sync-service` (si hay conexión).
  5. Dispara la descarga inicial de sucursal si falta.
- **Token desaparece** → `handleTokenCleared()` → detiene el sync.

### Inyección del token (preload)
En cada carga de página, el preload lee el token cacheado vía IPC **síncrono**
(`auth:get-cached-token-sync`) y lo escribe en `sessionStorage` **antes** de que corran los scripts
del frontend ([preload/index.js:11](../src/preload/index.js#L11)), para que el `AuthContext` lo
encuentre al montar. Un token vencido se inyecta igual (la sesión local no depende de la firma del
JWT); el sync intentará refrescarlo al reconectar ([index.js:51](../src/main/index.js#L51)).

## 6. Logout

Hay varias vías que convergen en `clearLocalToken()` ([index.js:76](../src/main/index.js#L76)),
que borra `auth_token` de `app_config`, limpia `users.last_token`, resetea estado en memoria y
detiene el sync:

| Disparador | Dónde |
|------------|-------|
| Menú "Cerrar sesión" (`Ctrl+Shift+L`) | [index.js:516](../src/main/index.js#L516) |
| Navegación a `/login` (señal de logout) | `will-navigate`, [index.js:440](../src/main/index.js#L440) |
| `sessionStorage.removeItem('token')` desde la web | override del preload → IPC `auth:token-removed-sync` |
| IPC `auth:logout` (desde `nuventaAuth.logout()`) | [index.js:386](../src/main/index.js#L386) |
| Cierre de la app | `window-all-closed` borra `auth_token`, [index.js:680](../src/main/index.js#L680) |

### El flag `loggedOut`
Evita una **condición de carrera**: tras logout, el preload de la próxima carga de página podría
re-inyectar el token cacheado antes de que el borrado en DB termine. El override de `removeItem`
usa `sendSync` (bloqueante) para fijar `loggedOut=true` **antes** de navegar; mientras ese flag
esté activo, `auth:get-cached-token-sync` devuelve vacío ([index.js:325](../src/main/index.js#L325)).

> Con `contextIsolation:true`, el override de `removeItem` del preload no siempre alcanza al
> renderer; por eso la detección de navegación a `/login` es el respaldo principal del logout.

## 7. Cifrado del token en reposo

[token-crypto.js](../src/main/token-crypto.js) usa el `safeStorage` de Electron (cifrado a nivel
del SO: **DPAPI en Windows**, Keychain en macOS, libsecret en Linux):

- `encryptToken()` → prefijo `enc:` + base64 del buffer cifrado.
- `decryptToken()` → maneja tokens cifrados (`enc:`) y *legacy* en texto plano de forma
  transparente.
- Si `safeStorage` no está disponible, cae a texto plano (con warning).

El token se guarda cifrado tanto en `app_config.auth_token` como en `users.last_token`.

## 8. Seguridad — resumen

- JWT cifrado en reposo (§7).
- `pw_hash` = `sha256(salt + password)` solo para verificación **offline local**; no reemplaza la
  auth del backend.
- El token se borra al cerrar la app → re-login en cada arranque (el offline-login sigue
  disponible con el hash).
- Ventana de gracia offline de 7 días (`OFFLINE_MAX_DAYS`).

## Ver también

- [synchronization.md](synchronization.md) — el sync que arranca tras el login.
- [database.md](database.md) — tablas `users`, `app_config`, `branch_data_status`.
- [local-api.md](local-api.md) — el endpoint `POST /api/auth/login` y el manejo de 401 del proxy.
- [modules.md](modules.md) — `api-client` (login/verifyDevice) y `preload` (bridge IPC).
</content>
