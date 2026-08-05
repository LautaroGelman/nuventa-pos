# Nuventa POS — Punto de Venta Offline-First

Aplicación de escritorio para Windows construida con **Electron + SQLite** que actúa como
terminal de punto de venta, gestión de inventario y administración de local para negocios
conectados a la nube de Nuventa.

> **La UI no vive en este repositorio.** Electron carga el frontend web de Nuventa (Next.js,
> proyecto hermano `nuventa-frontend-dev`) ya compilado a export estático en `resources/web/`.
> Este repo es el **caparazón Electron**: ventana Chromium, servidor HTTP local, base de datos
> SQLite, sincronización con la nube y autenticación offline. No contiene pantallas de POS
> propias salvo una página de *fallback* de login offline (`src/renderer/`).

---

## ¿Qué hace este proyecto?

Convierte el frontend web de Nuventa en una app de escritorio **capaz de operar sin internet**.
El truco central: un **servidor HTTP local** (`src/main/local-server.js`) intercepta todas las
llamadas `/api/*` que hace el frontend y las resuelve contra SQLite local — o las reenvía
("proxy") a la nube según el rol del usuario y la ruta. Para el frontend, el POS local es
indistinguible del backend real.

## Modos de operación (según rol)

| Rol | Modo | Comportamiento |
|-----|------|----------------|
| **Cajero** | Local-first | Ventas, devoluciones y movimientos de caja se guardan primero en SQLite (`pending`). Sync automática cada 1 h. |
| **Inventario / Multifunción** | Local-first + sync manual | Igual que cajero, más botón de sincronización manual. |
| **Administrador / Dueño** | Online | Sin SQLite local: cada request se reenvía (proxy) a la nube en tiempo real. |

La búsqueda de inventario "en todas las sucursales" (`/inventory/all-branches`) **siempre** va
a la nube, sin importar el rol — requiere conexión activa.

## Arquitectura (resumen)

```
┌───────────────────────────── Electron App ──────────────────────────────┐
│                                                                          │
│   Renderer (Chromium)                Main Process                        │
│   ┌────────────────────┐             ┌──────────────────────────────┐   │
│   │ Frontend Next.js    │  fetch      │ protocol.handle('http')       │   │
│   │ (resources/web)     │ ─/api/*──▶  │   → redirige /api/* al         │   │
│   │                     │             │     servidor HTTP local        │   │
│   └────────────────────┘             │ ┌──────────────────────────┐  │   │
│                                       │ │ local-server.js           │  │   │
│                                       │ │  • sirve resources/web    │  │   │
│                                       │ │  • emula la REST API ↔ DB │  │   │
│                                       │ │  • proxy a la nube         │  │   │
│                                       │ └─────────┬────────────────┘  │   │
│                                       │ ┌─────────▼────────────────┐  │   │
│                                       │ │ SQLite (sql.js / WASM)    │  │   │
│                                       │ └─────────┬────────────────┘  │   │
│                                       │ ┌─────────▼────────────────┐  │   │
│                                       │ │ sync-service (cada 1 h)   │  │   │
│                                       │ └─────────┬────────────────┘  │   │
│                                       └───────────┼──────────────────┘   │
└───────────────────────────────────────────────────┼──────────────────────┘
                                                     │ HTTP/JWT
                                          ┌──────────▼──────────┐
                                          │  Nuventa Cloud API   │
                                          └──────────────────────┘
```

Detalle técnico completo en [docs/architecture.md](docs/architecture.md).

## Estructura del proyecto

```
nuventa-pos/
├── package.json              # Scripts, deps (Electron 33, sql.js), config electron-builder
├── README.md                 # Este archivo (overview para humanos)
├── CLAUDE.md                 # Punto de entrada e índice para agentes de IA
├── docs/                     # Documentación técnica detallada (ver índice abajo)
├── src/
│   ├── main/                 # Proceso principal de Electron (Node.js)
│   │   ├── index.js          # Ciclo de vida, ventana, intercepción /api/*, token watcher, IPC
│   │   ├── local-server.js   # Servidor HTTP local: estáticos + REST↔SQLite + proxy a la nube
│   │   ├── sync-service.js   # Sincronización en background (sube pendientes, baja catálogo)
│   │   ├── auth-service.js   # Login local-first con fallback remoto, gracia offline 7 días
│   │   ├── database.js       # SQLite (sql.js/WASM): schema, migraciones, helpers
│   │   ├── api-client.js     # Cliente HTTP hacia la API cloud
│   │   ├── config-store.js   # Config JSON + detección de entorno (dev/prod)
│   │   └── token-crypto.js   # Cifrado de tokens JWT con safeStorage del SO
│   ├── preload/
│   │   └── index.js          # contextBridge: inyecta token + expone IPC seguro al renderer
│   └── renderer/             # Página de FALLBACK offline (solo si la web no carga)
│       ├── index.html
│       ├── styles.css
│       └── app.js
├── resources/web/            # Frontend Next.js COMPILADO (generado por `npm run build:web`)
└── assets/                   # Íconos de la app (icon.ico)
```

## Instalación y desarrollo

```bash
npm install            # Instalar dependencias

npm start              # Ejecutar en modo PROD (apunta a nuventa.com.ar)
npm run start:dev      # Ejecutar en modo DEV (localhost:3000 web / localhost:8080 backend)

npm run build:web      # Compilar el frontend hermano y copiarlo a resources/web/
npm run build          # Instalador NSIS para Windows (incluye build:web)
npm run build:portable # Versión portable para Windows
```

> `build:web` ejecuta `pnpm build` dentro de `../nuventa-frontend-dev`, por lo que ese repo
> hermano debe existir junto a este para poder generar el bundle de producción.

## Entornos

El entorno se decide por el flag `--dev` ([config-store.js:11](src/main/config-store.js#L11)):

| Entorno | Web URL | Backend URL |
|---------|---------|-------------|
| **dev** (`--dev`) | `http://localhost:3000` | `http://localhost:8080` |
| **prod** (default) | `https://nuventa.com.ar` | `https://nuventa.com.ar` |

## Atajos de teclado (menú de la app)

Definidos en `buildMenu()` ([index.js:509](src/main/index.js#L509)):

| Atajo | Acción |
|-------|--------|
| `Ctrl+Shift+L` | Cerrar sesión |
| `Ctrl+Shift+V` | Ir a Punto de Venta (`/sale-form`) |
| `Ctrl+Shift+Y` | Forzar sincronización |
| `Ctrl+R` | Recargar página |
| `F12` | Alternar DevTools |

> Los atajos *dentro* del POS (búsqueda, confirmar venta, etc.) pertenecen al frontend Next.js
> (`nuventa-frontend-dev`), no a este repo.

## Documentación para agentes de IA

El archivo [CLAUDE.md](CLAUDE.md) es el punto de entrada. Documentación técnica en `docs/`:

| Documento | Contenido |
|-----------|-----------|
| [docs/architecture.md](docs/architecture.md) | Modelo de procesos, ciclo de vida de un request, los 3 modos de operación, flujo de datos. |
| [docs/database.md](docs/database.md) | Referencia completa del schema SQLite (13 tablas, columnas, índices, estados de sync). |
| [docs/local-api.md](docs/local-api.md) | Catálogo de endpoints del servidor local, ruteo, role gating y proxy a la nube. |
| [docs/authentication.md](docs/authentication.md) | Flujos de login (online/offline/primer-login), gracia de 7 días, captura de token, cifrado. |
| [docs/synchronization.md](docs/synchronization.md) | Cadencia de sync, upload de pendientes, descarga de catálogo, resolución de conflictos. |
| [docs/modules.md](docs/modules.md) | Referencia archivo-por-archivo: api-client, config-store, token-crypto, preload, renderer. |

## Persistencia local

| Ruta (en `userData`) | Contenido |
|----------------------|-----------|
| `nuventa-pos.db` | Base de datos SQLite (catálogo, ventas, caja, usuarios, sync). |
| `nuventa-pos-config.json` | Config de la app (tamaño de ventana). Las URLs se derivan del entorno, no se persisten. |

> En Windows `userData` ≈ `%APPDATA%/nuventa-pos`. El `auth_token` se borra al cerrar la app
> ([index.js:680](src/main/index.js#L680)): hay que volver a iniciar sesión en cada arranque
> (el login offline sigue funcionando con el hash guardado en la tabla `users`).
</content>
</invoke>
