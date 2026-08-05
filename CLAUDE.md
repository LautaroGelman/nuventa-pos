# CLAUDE.md — Guía para agentes de IA

Punto de entrada para cualquier agente (Claude Code u otro) que trabaje en **Nuventa POS**.
Leé esto primero; luego saltá al documento de `docs/` que corresponda a tu tarea.

---

## 1. Qué es este proyecto (en una frase)

Caparazón **Electron + SQLite** que envuelve el frontend web de Nuventa (Next.js compilado en
`resources/web/`) y le da **capacidad offline-first**: un servidor HTTP local intercepta las
llamadas `/api/*` del frontend y las resuelve contra SQLite local, o las reenvía a la nube
según el rol del usuario.

**Lo que NO es:** no es el frontend (eso vive en el repo hermano `nuventa-frontend-dev`) ni el
backend (Spring Boot en la nube). Acá no hay componentes de React ni endpoints de Spring.

## 2. Stack y restricciones

- **Runtime:** Electron 33, Node.js (proceso main). Sin TypeScript, sin transpilación, sin
  bundler. Es **JavaScript plano con `require()` (CommonJS)**. Lo que editás es lo que corre.
- **Base de datos:** `sql.js` (SQLite compilado a WASM). **No es better-sqlite3.** La DB es un
  buffer en memoria que se serializa a disco; ver §5.
- **Sin framework de tests.** No hay suite de pruebas. No inventes `npm test`.
- **Plataforma objetivo:** Windows (electron-builder → NSIS + portable).
- **Dependencias de producción:** solo `sql.js`. Todo lo demás es API nativa de Electron/Node.

## 3. Mapa de archivos (dónde tocar según la tarea)

Todo el código editable está en `src/`. Tamaños aproximados entre paréntesis.

| Si tu tarea toca… | Archivo | Responsabilidad |
|-------------------|---------|-----------------|
| Arranque, ventana, intercepción de red, captura de token, IPC, menú | [src/main/index.js](src/main/index.js) (27 KB) | Orquestador del proceso main. |
| Endpoints offline, ruteo, qué va local vs. nube, permisos por rol | [src/main/local-server.js](src/main/local-server.js) (54 KB) | Servidor HTTP local. **El archivo más grande y central.** |
| Subir pendientes / bajar catálogo, cadencia de sync | [src/main/sync-service.js](src/main/sync-service.js) (21 KB) | Sincronización en background. |
| Login, fallback offline, descarga inicial de sucursal | [src/main/auth-service.js](src/main/auth-service.js) (20 KB) | Lógica de autenticación. |
| Schema, migraciones, helpers SQL (`all/get/run/exec`) | [src/main/database.js](src/main/database.js) (12 KB) | Capa SQLite. |
| Llamadas HTTP salientes a la nube | [src/main/api-client.js](src/main/api-client.js) (7 KB) | Cliente de la API cloud. |
| URLs por entorno, tamaño de ventana | [src/main/config-store.js](src/main/config-store.js) (2.5 KB) | Config + detección dev/prod. |
| Cifrado del JWT en reposo | [src/main/token-crypto.js](src/main/token-crypto.js) (1.6 KB) | safeStorage del SO. |
| Inyección de token, puente seguro main↔renderer | [src/preload/index.js](src/preload/index.js) (3 KB) | contextBridge. |
| Pantalla de login offline (solo si la web no carga) | [src/renderer/](src/renderer/) | Fallback HTML/CSS/JS. |

## 4. Comandos

```bash
npm install          # deps
npm start            # correr en PROD (nuventa.com.ar)
npm run start:dev    # correr en DEV (localhost:3000 / :8080) — abre DevTools
npm run build:web    # compila el frontend hermano y lo copia a resources/web/
npm run build        # instalador NSIS para Windows
```

No hay linter, formatter ni tests configurados. Respetá el estilo existente (ver §6).

## 5. Modelo mental imprescindible

### 5.1 El frontend no sabe que está offline
El frontend Next.js hace `fetch('/api/...')` como si hablara con el backend real. En Electron,
`protocol.handle()` ([index.js:125](src/main/index.js#L125)) redirige **todo** `/api/*` al
servidor HTTP local (`127.0.0.1:<puerto-aleatorio>`). El servidor local decide, ruta por ruta,
si responde desde SQLite o hace de proxy a la nube. **No existe el proxy de rewrites de Next.js
dentro de Electron**; por eso esta intercepción es obligatoria.

### 5.2 Persistencia de SQLite es manual y diferida
`sql.js` mantiene la DB en memoria. Para que un cambio sobreviva hay que **serializar a disco**:
- `db.run(...)` y `db.exec(...)` programan un guardado diferido (`saveSoon`, 500 ms) — ver
  [database.js:53](src/main/database.js#L53).
- Tras una serie de escrituras que deben persistir ya, se llama `db.save()` explícitamente.
- **Regla:** si agregás una mutación importante, terminá con `db.save()`. Olvidarlo = el dato se
  pierde si la app se cierra antes del flush.

### 5.3 Identidad del usuario: dos fuentes
Tras login, los datos del usuario (clientId, sucursalId, employeeId, roles, token) viven en
**dos lugares** que deben mantenerse en sync:
1. La tabla `users` (para login offline con hash de contraseña).
2. Pares clave-valor en `app_config` (los lee el servidor local en cada request).

`auth-service._saveUserLocally()` ([auth-service.js:300](src/main/auth-service.js#L300)) escribe
en ambos. Si tocás la forma del login, actualizá los dos.

### 5.4 El rol decide el ruteo
El servidor local clasifica cada request por rol antes de ejecutar el handler:
- **Admin/Dueño** (`ROLE_ADMINISTRADOR`, `ROLE_PROPIETARIO`, …): rutas "cloud-only" hacen proxy
  a la nube; rutas sin handler local también hacen proxy (fallback).
- **Cajero/Inventario/Multifunción**: operan local-first; rutas cloud-only devuelven **403**.

Tablas de roles y patrones en [local-server.js:155](src/main/local-server.js#L155) y
[local-server.js:248](src/main/local-server.js#L248). Detalle en [docs/local-api.md](docs/local-api.md).

## 6. Convenciones de código (imitá lo que ya hay)

- **CommonJS** (`require`/`module.exports`), no ESM.
- **Comentarios de cabecera por archivo**: cada módulo abre con un bloque `// ===` que explica su
  propósito. Mantené ese estilo si creás un módulo nuevo.
- **Logs con prefijo de subsistema**: `[MAIN]`, `[LOCAL-API]`, `[SYNC]`, `[AUTH]`, `[TOKEN]`,
  `[DB]`, `[CONFIG]`, `[TOKEN-CRYPTO]`, `[INTERCEPT]`. Usá el prefijo del módulo donde escribís.
- **Idioma**: comentarios técnicos en inglés; mensajes visibles al usuario (errores de API,
  diálogos) en **español rioplatense** (“iniciá sesión”, “tenés”, “conectate”). Respetalo.
- **SQL**: snake_case en columnas locales; los DTOs que se devuelven al frontend usan camelCase
  (hay funciones `*ToDto` que traducen, p. ej. `productToDto` en
  [local-server.js:377](src/main/local-server.js#L377)).
- **Parámetros SQL siempre parametrizados** (`?` / `?1`), nunca interpolación de strings.

## 7. Gotchas / trampas conocidas

Cosas no obvias que ya están en el código. **No las "arregles" sin pedir confirmación** —
algunas son intencionales y otras son deuda técnica que conviene documentar antes de tocar.

1. **401 de la nube se enmascara como 503.** En `proxyToCloud`
   ([local-server.js:221](src/main/local-server.js#L221)) un 401 del backend NO se reenvía al
   frontend (dispararía el interceptor de axios y forzaría logout). Se devuelve 503 con
   `offline:true` para preservar la sesión local. Intencional.
2. **El token se borra al salir.** `window-all-closed` elimina `auth_token` de `app_config`
   ([index.js:680](src/main/index.js#L680)). Cada arranque exige re-login (el login offline
   funciona igual vía el hash en `users`).
3. **Token watcher por polling.** No hay evento; se hace polling de `sessionStorage.token` cada
   2 s ([index.js:189](src/main/index.js#L189)). Con `contextIsolation:true` el override de
   `removeItem` del preload no alcanza al renderer, por eso además se detecta la navegación a
   `/login` como señal de logout ([index.js:440](src/main/index.js#L440)).
4. **`forceLogout` automático en 409.** Si el backend responde 409 (sesión activa en otro
   dispositivo), auth reintenta con `forceLogout=true` sin preguntar
   ([auth-service.js:280](src/main/auth-service.js#L280)).
5. **Migraciones idempotentes, no versionadas.** No hay tabla de versiones de schema. Todo es
   `CREATE TABLE IF NOT EXISTS` + algún `ALTER TABLE` envuelto en try/catch
   ([database.js:60](src/main/database.js#L60)). Para agregar una columna, seguí ese patrón
   (`ALTER TABLE … ADD COLUMN` dentro de try/catch que ignora "ya existe").

## 8. Reglas de trabajo en este repo

- **Cambios mínimos y quirúrgicos.** No reescribas módulos enteros para un fix puntual.
- **Tras cualquier mutación de datos que importe, asegurá `db.save()`** (ver §5.2).
- **Si cambiás el contrato del servidor local, verificá el doble lado:** el frontend espera un
  DTO con forma específica (camelCase) y el `sync-service` espera un payload específico para la
  nube. Cambiá ambos extremos o ninguno.
- **No agregues dependencias** sin necesidad real; el proyecto se enorgullece de tener una sola.
- **Si encontrás cruft o docs desactualizados, actualizá `docs/` en el mismo PR.** Esta carpeta
  es contrato vivo: si tu cambio invalida algo acá, corregilo.

## 9. Índice de documentación detallada

| Documento | Cuándo leerlo |
|-----------|---------------|
| [docs/architecture.md](docs/architecture.md) | Antes de tocar el flujo de arranque, intercepción de red o el modelo de procesos. |
| [docs/database.md](docs/database.md) | Antes de cualquier query o cambio de schema. Referencia de las 13 tablas. |
| [docs/local-api.md](docs/local-api.md) | Antes de agregar/cambiar un endpoint o el ruteo por rol. Catálogo completo. |
| [docs/authentication.md](docs/authentication.md) | Antes de tocar login, logout, sesiones o el manejo de token. |
| [docs/synchronization.md](docs/synchronization.md) | Antes de tocar la subida de pendientes o la descarga de catálogo. |
| [docs/modules.md](docs/modules.md) | Referencia de los módulos chicos (api-client, config, crypto, preload, renderer). |
</content>
