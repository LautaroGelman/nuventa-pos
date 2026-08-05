# Arquitectura

> Documento de referencia técnica de **Nuventa POS**. Para el mapa rápido de archivos y reglas de
> trabajo, ver [../CLAUDE.md](../CLAUDE.md). Para el overview de producto, ver [../README.md](../README.md).

---

## 1. Idea central

Nuventa POS toma el **frontend web de Nuventa** (Next.js, repo hermano `nuventa-frontend-dev`,
exportado como sitio estático a `resources/web/`) y lo empaqueta en una app de escritorio Electron
con **capacidad offline-first**.

El frontend fue escrito para hablar con un backend Spring Boot por HTTP (`fetch('/api/...')`).
Dentro de Electron no existe ese backend ni el proxy de *rewrites* de Next.js. La solución:

1. Un **servidor HTTP local** (`src/main/local-server.js`) que sirve los archivos estáticos del
   frontend **y** emula la REST API del backend usando SQLite local.
2. La intercepción de `protocol.handle()` (`src/main/index.js`) que redirige toda llamada
   `/api/*` del renderer hacia ese servidor local.

Resultado: el frontend funciona igual offline que online, sin modificaciones.

## 2. Modelo de procesos

Electron corre dos clases de proceso. Este repo controla el **main** y el **preload**; el
**renderer** ejecuta el frontend de Nuventa (que no vive acá).

```
┌─────────────────────────── PROCESO MAIN (Node.js) ───────────────────────────┐
│  index.js          orquestador: lifecycle, ventana, intercepción, IPC, menú   │
│  config-store.js   entorno (dev/prod) + config persistida                     │
│  database.js       SQLite (sql.js/WASM) — fuente de verdad local              │
│  local-server.js   HTTP local: estáticos + REST↔SQLite + proxy a la nube      │
│  auth-service.js   login local-first, descarga inicial de sucursal            │
│  sync-service.js   sube pendientes / baja catálogo cada 1 h                   │
│  api-client.js     cliente HTTP saliente hacia la nube                        │
│  token-crypto.js   cifra/descifra el JWT en reposo (safeStorage del SO)       │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                     │ contextBridge (IPC)
┌───────────────────────────── PRELOAD (aislado) ──────────────────────────────┐
│  preload/index.js   inyecta token en sessionStorage + expone nuventaAuth/Sync │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                     │
┌──────────────────────────── PROCESO RENDERER (Chromium) ──────────────────────┐
│  resources/web/*    Frontend Next.js compilado  (la UI real del POS)          │
│  src/renderer/*     Página de FALLBACK offline (solo si la web no carga)      │
└────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Ciclo de vida del arranque

Secuencia de `app.whenReady()` en [../src/main/index.js:594](../src/main/index.js#L594):

1. **Config** — `configStore.loadConfig()`: detecta entorno por el flag `--dev`.
2. **Base de datos** — `initDatabase()`: abre/crea `nuventa-pos.db`, corre migraciones.
3. **Servidor local** — `startLocalServer()`: levanta HTTP en `127.0.0.1` con puerto aleatorio.
4. **Listeners de login** — engancha `loginEvents` (emitidos por el servidor local) para arrancar
   sync y reenviar progreso al renderer.
5. **IPC + menú** — `registerIpcHandlers()` + `buildMenu()`.
6. **Intercepción** — `setupApiInterception()`: registra `protocol.handle()` para `/api/*`.
7. **Online check** — `checkOnlineStatus()` + chequeo periódico cada 30 s.
8. **API client** — fija la URL del backend según entorno.
9. **Restaurar auth** — si hay token cacheado, configura `apiClient` y arranca el `sync-service`.
10. **Cargar la app** — `loadApp()`: carga la UI (ver §5).

## 4. Ciclo de vida de un request `/api/*`

```
Frontend: fetch('/api/client-panel/7/sucursales/3/items?q=coca')
   │
   ▼
protocol.handle('http')  [index.js:138]
   │  ¿es /api/* dirigido al host web/backend/127.0.0.1?
   ├── sí ─▶ net.fetch a http://127.0.0.1:<puerto-local>/api/...
   │            │
   │            ▼
   │        local-server.js — http.createServer  [local-server.js:1373]
   │            │  1. OPTIONS → CORS preflight
   │            │  2. ¿no empieza con /api/? → servir archivo estático
   │            │  3. parseRoute → { clientId, sucursalId, subpath }
   │            │  4. ¿ruta cloud-only?  ── admin/owner → proxyToCloud
   │            │                         └ otro rol    → 403
   │            │  5. ¿ruta all-branches? → proxyToCloud (cualquier rol)
   │            │  6. routeRequest(method, pathname, route) → handler
   │            │       ├── handler local → responde desde SQLite
   │            │       ├── sin handler + admin/owner → proxyToCloud (fallback)
   │            │       └── sin handler + otro rol → 404
   │            ▼
   │        Respuesta JSON (DTO camelCase) → frontend
   │
   └── no  ─▶ net.fetch passthrough (bypassCustomProtocolHandlers) — assets, etc.
```

Puntos clave:
- **`bypassCustomProtocolHandlers: true`** es obligatorio en el passthrough; sin él, el handler se
  re-dispara recursivamente y la página queda en blanco ([index.js:170](../src/main/index.js#L170)).
- El `sync-service` usa `fetch` del proceso main, que **no** pasa por `protocol.handle()`; por eso
  habla directo con la nube sin caer en el servidor local.

## 5. Carga de la UI (static-first)

`loadApp()` ([../src/main/index.js:469](../src/main/index.js#L469)) elige el origen con esta
prioridad:

1. **Build estático local** (`resources/web/index.html` servido por el servidor local) → 100%
   offline. Es el caso normal de producción.
2. **URL de la nube** (fallback dev/CI si no hay build estático).
3. **Página de fallback** (`src/renderer/index.html`) si la carga falla (`did-fail-load`): un login
   offline mínimo.

El token cacheado se inyecta en `sessionStorage` desde el **preload** *antes* de que corran los
scripts de la página, para que el `AuthContext` del frontend lo encuentre al montar.

## 6. Los tres modos de operación

El comportamiento se decide por el **rol** del usuario autenticado (roles guardados en
`app_config.roles`). Ver helpers en [../src/main/local-server.js:155](../src/main/local-server.js#L155).

| Rol | Roles internos | Modo | Detalle |
|-----|----------------|------|---------|
| **Cajero** | `ROLE_CAJERO` | Local-first | Todo desde SQLite. Sync auto cada 1 h. Rutas cloud-only → 403. |
| **Inventario** | `ROLE_INVENTARIO` | Local-first | Igual que cajero + puede crear inventario + sync manual. |
| **Multifunción** | `ROLE_MULTIFUNCION` | Local-first | Igual que inventario. |
| **Administrador** | `ROLE_ADMINISTRADOR`, `ROLE_ADMIN` | Online | Proxy a la nube en cada request. |
| **Dueño** | `ROLE_PROPIETARIO`, `ROLE_OWNER` | Online | Igual que administrador. |

Jerarquía: `PROPIETARIO > ADMINISTRADOR > MULTIFUNCION > INVENTARIO > CAJERO`.

**Excepción transversal:** la búsqueda multi-sucursal (`/inventory/all-branches`,
`/products/all-branches`) siempre va a la nube, para cualquier rol — requiere conexión.

## 7. Conectividad y offline

- **Sonda de conexión:** `GET /api/auth/session-status` contra el backend, con timeout de 5 s.
  Se chequea al arrancar y cada 30 s ([index.js:91](../src/main/index.js#L91)).
- **Gracia offline:** un usuario ya logueado puede operar sin internet hasta **7 días**
  (`OFFLINE_MAX_DAYS`); pasado ese plazo, debe reconectarse. Ver
  [authentication.md](authentication.md).
- **Operación sin red:** las ventas/devoluciones/movimientos quedan `pending` en SQLite y se suben
  en el próximo ciclo de sync. El cajero nunca se entera del corte.

## 8. Flujo de datos (local ↔ nube)

```
            ┌──────────────────── NUBE (Spring Boot) ────────────────────┐
            │                                                            │
   (subida) │  POST /sales, /returns, /cash-movements, /cash-sessions    │ (bajada)
   pendientes ▲                                                        ▼ catálogo
            │  sync-service._uploadPending*()        _downloadProducts() │
            │                                        _downloadRegisters()│
            └──────────────────────────┬─────────────────────────────────┘
                                        │
                          ┌─────────────▼─────────────┐
                          │   SQLite local (sql.js)    │
                          │  products, sales, returns, │
                          │  cash_*, users, sync_log…  │
                          └─────────────┬─────────────┘
                                        │  lectura/escritura
                          ┌─────────────▼─────────────┐
                          │   local-server (REST↔DB)   │
                          └─────────────┬─────────────┘
                                        │  /api/*
                          ┌─────────────▼─────────────┐
                          │   Frontend Next.js (UI)    │
                          └────────────────────────────┘
```

- **Local → nube:** `sync-service` sube en lotes de 20 los registros `pending` (ventas,
  devoluciones, movimientos de caja, sesiones cerradas) y los marca `synced`.
- **Nube → local:** baja el catálogo de productos y las cajas registradoras de la sucursal.
- Detalle completo en [synchronization.md](synchronization.md).

## 9. Seguridad

- **Token en reposo cifrado** con `safeStorage` del SO (DPAPI en Windows) — ver
  [token-crypto.js](../src/main/token-crypto.js) y [modules.md](modules.md).
- **`contextIsolation: true`, `nodeIntegration: false`** en la `BrowserWindow`
  ([index.js:425](../src/main/index.js#L425)). El renderer solo accede a lo expuesto por el
  preload vía `contextBridge`.
- **Cabeceras de seguridad** (CSP, X-Frame-Options, nosniff…) en cada respuesta del servidor local
  ([local-server.js:46](../src/main/local-server.js#L46)).
- **Anti path-traversal** al servir estáticos ([local-server.js:68](../src/main/local-server.js#L68)).
- **401 de la nube enmascarado como 503** para no forzar logout indebido (ver
  [local-api.md](local-api.md)).

## Ver también

- [database.md](database.md) — el schema que respalda todo lo anterior.
- [local-api.md](local-api.md) — el catálogo de endpoints del servidor local.
- [authentication.md](authentication.md) — cómo se obtiene y mantiene la sesión.
- [synchronization.md](synchronization.md) — cómo se reconcilian local y nube.
</content>
