'use strict';

// Authenticated production smoke test. Credentials are accepted only through stdin and are never
// written to disk or included in output. The test is intentionally read-only; mutation semantics
// are exercised against the disposable MySQL integration environment before any cloud rollout.
const crypto = require('crypto');
const { ApiClient } = require('../src/main/api-client');

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    const finish = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      try { resolve(JSON.parse(input)); } catch (error) { reject(new Error('Entrada de credenciales inválida')); }
    };
    const onData = (chunk) => {
      input += chunk;
      if (process.stdin.isTTY && /[\r\n]$/.test(input)) {
        input = input.trim();
        finish();
      }
    };
    if (process.stdin.isTTY) process.stdin.setRawMode?.(true); // disables terminal echo
    process.stdin.on('data', onData);
    process.stdin.on('end', finish);
  });
}

function jwtPayload(token) {
  try {
    const encoded = token.split('.')[1];
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch { return {}; }
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.content)) return value.content;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

async function run() {
  const credentials = await readStdin();
  if (typeof credentials.email !== 'string' || typeof credentials.password !== 'string') {
    throw new Error('Faltan email o contraseña');
  }

  const client = new ApiClient();
  let loggedIn = false;
  let stage = 'login';
  try {
    let login = await client.login(credentials.email, credentials.password, false);
    if (login?.activeSessionConflict) login = await client.login(credentials.email, credentials.password, true);
    if (!login?.token) {
      const status = login?._httpStatus || 'unexpected-response';
      throw new Error(`La nube rechazó el inicio de sesión (${status})`);
    }
    loggedIn = true;
    const claims = jwtPayload(login.token);
    const clientId = Number(login.clientId || claims.clientId);
    client.setAuth({ token: login.token, clientId, sucursalId: login.sucursalId || claims.sucursalId,
      employeeId: login.employeeId || claims.employeeId });

    stage = 'branches';
    const branchesResponse = await client.getSucursales();
    const branches = list(branchesResponse);
    const branchId = Number(client.sucursalId || branches[0]?.id);
    if (!Number.isSafeInteger(clientId) || clientId <= 0 || !Number.isSafeInteger(branchId) || branchId <= 0) {
      throw new Error('La cuenta no expuso un cliente y una sucursal utilizables');
    }
    client.setAuth({ token: login.token, clientId, sucursalId: branchId,
      employeeId: login.employeeId || claims.employeeId });

    stage = 'heartbeat';
    const online = await client.isOnline();
    stage = 'identity';
    const me = await client.getMe();
    stage = 'catalog-and-registers';
    const [productsResponse, registersResponse] = await Promise.all([
      client.getProducts(), client.listRegisters(true),
    ]);
    const products = list(productsResponse);
    const registers = list(registersResponse);

    stage = 'compatibility';
    const compatibility = await client.getPosCompatibility();
    let bundleV2 = {
      available: Number(compatibility?.currentContractVersion) >= 2
        && !!(compatibility?.features?.bundleSyncV2 === true
          || compatibility?.features?.includes?.('bundleSyncV2')),
      advertisedContract: compatibility?.currentContractVersion ?? null,
    };
    stage = 'bundle-v2';
    if (bundleV2.available) try {
      const response = await client.syncBundle({
        protocolVersion: 2,
        deviceId: `cloud-smoke-${crypto.randomUUID()}`.slice(0, 64),
        requestId: crypto.randomUUID(),
        cursor: null,
        mutations: [],
      });
      bundleV2 = {
        available: true,
        advertisedContract: compatibility.currentContractVersion,
        protocolVersion: response?.protocolVersion,
        changeCount: Array.isArray(response?.changes) ? response.changes.length : 0,
        hasMore: !!response?.hasMore,
        resetRequired: !!response?.resetRequired,
      };
    } catch (error) {
      if (error.status === 404 || error.status === 405) bundleV2 = { available: false, httpStatus: error.status };
      else throw error;
    }

    process.stdout.write(`${JSON.stringify({
      authenticated: !!me,
      heartbeat: online,
      branches: branches.length,
      products: products.length,
      registers: registers.length,
      bundleV2,
    })}\n`);
  } catch (error) {
    error.message = `${stage}: ${error.message}`;
    throw error;
  } finally {
    credentials.password = '';
    if (loggedIn) await client.logout().catch(() => client.clearAuth());
  }
}

run().catch((error) => {
  process.stderr.write(`[CLOUD-SMOKE] ${String(error.message || error).slice(0, 300)}\n`);
  process.exitCode = 1;
});
