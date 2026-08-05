# Módulos auxiliares

> Referencia archivo-por-archivo de los módulos que no tienen documento propio. Los módulos
> grandes (`index.js`, `local-server.js`, `auth-service.js`, `sync-service.js`, `database.js`)
> están cubiertos en [architecture.md](architecture.md), [local-api.md](local-api.md),
> [authentication.md](authentication.md), [synchronization.md](synchronization.md) y
> [database.md](database.md).

---

## `api-client.js` — cliente HTTP hacia la nube

[../src/main/api-client.js](../src/main/api-client.js) — clase `ApiClient` (singleton `apiClient`).
Es el **único** módulo que hace llamadas salientes a la API cloud. El `sync-service`, `auth-service`
y el proxy del servidor local lo usan.

**Estado:** `baseUrl`, `token`, `clientId`, `sucursalId`, `employeeId`.

**Configuración:**
- `setAuth({ token, clientId, sucursalId, employeeId })` — fija las credenciales.
- `clearAuth()` — limpia.
- `setBaseUrl(url)` — fija la URL del backend (sin barra final).

**Internos:**
- `_headers()` — `Content-Type: application/json` + `Authorization: Bearer <token>`.
- `_branchPath()` — `…/api/client-panel/{clientId}/sucursales/{sucursalId}`
  ([api-client.js:42](../src/main/api-client.js#L42)).
- `_fetch(url, opts)` — wrapper con timeout 15 s; lanza `Error('HTTP <status>: <body>')` si no es
  ok; parsea JSON.

**Métodos públicos:**

| Categoría | Métodos |
|-----------|---------|
| Conectividad | `isOnline()` (`GET /api/auth/session-status`, timeout 5 s) |
| Auth | `login(email, password, forceLogout)`, `verifyDevice(email, code, forceLogout)`, `resendVerificationCode(email)`, `logout()`, `getMe()` |
| Productos | `getProducts()`, `getProductById(id)` |
| Ventas | `createSale(payload)`, `getSales(params)` |
| Devoluciones | `createReturn(payload)`, `getReturns(params)` |
| Caja | `createCashMovement(payload)`, `listRegisters(onlyActive)`, `getCurrentSession()`, `openSession(body)`, `closeSession(sessionId, body)` |
| Sucursales | `getSucursales()` |

> `login()` ([api-client.js:88](../src/main/api-client.js#L88)) no usa `_fetch`: maneja
> explícitamente 403 (`_httpStatus:403`) y 409 (`activeSessionConflict`) para que `auth-service`
> los procese. `closeSession` apunta a `…/cash-sessions/{id}/close-with-tracking`.

---

## `config-store.js` — config y entorno

[../src/main/config-store.js](../src/main/config-store.js) — config JSON simple + detección de
entorno.

**Entorno** ([config-store.js:11](../src/main/config-store.js#L11)): se decide por el flag `--dev`
en `process.argv`.

| Entorno | `webAppUrl` | `backendApiUrl` |
|---------|-------------|-----------------|
| `dev` (`--dev`) | `http://localhost:3000` | `http://localhost:8080` |
| `prod` (default) | `https://nuventa.com.ar` | `https://nuventa.com.ar` |

- `isDev()`, `getEnvName()`, `getEnvUrls()` — helpers de entorno.
- `get(key)` — **las claves `webAppUrl` y `backendApiUrl` siempre se derivan del entorno**, no se
  leen del archivo ([config-store.js:68](../src/main/config-store.js#L68)). El resto sale del JSON o
  de `DEFAULTS`.
- `set(key, value)` / `saveConfig(data)` — persisten en `<userData>/nuventa-pos-config.json`.
- `DEFAULTS` — `{ windowWidth: 1280, windowHeight: 800 }`. En la práctica solo se persiste el
  tamaño de la ventana.

> Por esto, lo que el README viejo decía ("configurar la URL del backend desde el login") ya no
> aplica: las URLs son fijas por entorno.

---

## `token-crypto.js` — cifrado del token

[../src/main/token-crypto.js](../src/main/token-crypto.js) — cifra/descifra el JWT con el
`safeStorage` de Electron (DPAPI en Windows). Detalle en
[authentication.md §7](authentication.md#7-cifrado-del-token-en-reposo).

- `encryptToken(plain)` → `'enc:' + base64`, o el texto plano si `safeStorage` no está disponible.
- `decryptToken(stored)` → descifra `enc:…`; pasa de largo los tokens *legacy* en texto plano;
  devuelve `null` si el descifrado falla.

---

## `preload/index.js` — puente seguro main ↔ renderer

[../src/preload/index.js](../src/preload/index.js) — corre en contexto aislado
(`contextIsolation:true`). Hace tres cosas:

1. **Inyecta el token cacheado** en `sessionStorage` antes de que corran los scripts de la página
   (IPC síncrono `auth:get-cached-token-sync`). Ver
   [authentication.md §5](authentication.md#5-captura-del-token-desde-la-web-token-watcher).
2. **Intercepta `sessionStorage.removeItem('token')`** para que el logout web borre también el
   token local (IPC `auth:token-removed-sync`).
3. **Expone APIs** al renderer vía `contextBridge`:

| Objeto global | Métodos |
|---------------|---------|
| `window.nuventaConfig` | `getEnv()` → `{ env, isDev, webAppUrl, backendApiUrl }` |
| `window.nuventaAuth` | `offlineLogin(email, password)`, `logout()`, `onLoginStatus(cb)` |
| `window.nuventaSync` | `forceSync()`, `getStatus()`, `onSyncStatus(cb)`, `onSyncComplete(cb)` |

Estos globals son el contrato que el frontend (y la página de fallback) usan para hablar con el
proceso main. Los handlers IPC del otro lado están en `registerIpcHandlers()`
([index.js:315](../src/main/index.js#L315)).

---

## `renderer/` — página de fallback offline

[../src/renderer/](../src/renderer/) — login mínimo que se muestra **solo** si la web no carga
(`did-fail-load`). No es el POS; es una red de seguridad para iniciar sesión offline.

| Archivo | Rol |
|---------|-----|
| `index.html` | Formulario de login offline + badge de entorno. |
| `app.js` | Llama a `window.nuventaAuth.offlineLogin()`; muestra estado/errores; al loguear online, el main transiciona a la web. |
| `styles.css` | Estilos dark-theme de la página. |

Flujo: el usuario ingresa email/contraseña → `offlineLogin` → IPC `auth:offline-login` →
`authService.login()` (misma lógica que el login web). Si el login resulta online, el main inyecta
el token y navega a la web ([index.js:354](../src/main/index.js#L354)).

---

## Tabla resumen de exports

| Módulo | Exporta |
|--------|---------|
| `index.js` | — (entry point, sin exports). |
| `local-server.js` | `startLocalServer`, `stopLocalServer`, `getServerPort`, `loginEvents` |
| `sync-service.js` | `SyncService` |
| `auth-service.js` | `authService` (singleton), `AuthService` |
| `database.js` | `initDatabase`, `getDb`, `closeDatabase` |
| `api-client.js` | `apiClient` (singleton), `ApiClient` |
| `config-store.js` | `loadConfig`, `saveConfig`, `getConfig`, `get`, `set`, `DEFAULTS`, `isDev`, `getEnvName`, `getEnvUrls` |
| `token-crypto.js` | `encryptToken`, `decryptToken` |
| `preload/index.js` | — (expone globals vía contextBridge). |

## Ver también

- [architecture.md](architecture.md) — cómo encajan estos módulos en el proceso main.
- [authentication.md](authentication.md) — uso intensivo de `token-crypto`, `preload`, `api-client`.
- [synchronization.md](synchronization.md) — uso de `api-client` por el sync.
</content>
