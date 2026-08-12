'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { once } = require('events');
const { createImageCache } = require('../src/main/image-cache');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const silentLogger = { log() {}, warn() {}, error() {} };

async function startServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function createFixture(t, overrides = {}, dependencies = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nuventa-image-test-'));
  const cache = createImageCache({
    getUserDataPath: () => userData,
    logger: silentLogger,
    random: () => 0.5,
    ...dependencies,
  }, {
    allowHttp: true,
    maxFileSize: 1024,
    maxCacheBytes: 1024 * 1024,
    minFreeDiskBytes: 0,
    inactivityTimeoutMs: 80,
    jobTimeoutMs: 180,
    manifestFlushMs: 5,
    manifestRetryDelaysMs: [1, 2, 3],
    networkRetryDelaysMs: [5, 10, 15, 20],
    retryJitter: 0,
    resumeCheckMs: 20,
    shutdownDrainMs: 300,
    staleTempAgeMs: 10,
    ...overrides,
  });
  cache.initialize();
  t.after(async () => {
    await cache.shutdown();
    const resolved = path.resolve(userData);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { cache, userData, cacheDir: path.join(userData, 'cache', 'product-images') };
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for condition');
}

async function waitIdle(cache, timeoutMs = 1500) {
  await waitFor(() => {
    const stats = cache.getStats();
    return stats.activeDownloads === 0 && stats.pendingJobs === 0 && stats.delayedJobs === 0;
  }, timeoutMs);
}

function jpegResponse(res, bytes = JPEG) {
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length });
  res.end(bytes);
}

test('normaliza firmas temporales y cambia la clave cuando cambia el UUID', (t) => {
  const { cache } = createFixture(t);
  const a = 'https://cdn.test/product/uuid-a/full.jpg?Expires=1&Signature=old&x=1';
  const b = 'https://cdn.test/product/uuid-a/full.jpg?Expires=2&Signature=new&x=1';
  const c = 'https://cdn.test/product/uuid-b/full.jpg?x=1';
  assert.equal(cache._normalizeSourceUrl(a), cache._normalizeSourceUrl(b));
  assert.equal(cache._computeSourceKey(a), cache._computeSourceKey(b));
  assert.notEqual(cache._computeSourceKey(a), cache._computeSourceKey(c));
});

test('descarga, persiste, reinicia y reemplaza sin servir la versión vieja', async (t) => {
  const fixtureServer = await startServer((_req, res) => jpegResponse(res));
  t.after(fixtureServer.close);
  const { cache, userData } = createFixture(t);
  const v1 = `${fixtureServer.baseUrl}/products/uuid-1/full.jpg`;
  const v2 = `${fixtureServer.baseUrl}/products/uuid-2/full.jpg`;

  cache.reconcileProducts([{ id: 7, imageUrl: v1 }]);
  await waitIdle(cache);
  const firstLocal = cache.getLocalUrl(7, 'image', v1);
  assert.match(firstLocal, /^\/api\/local-product-images\/7\/image\?v=/);

  cache.reconcileProducts([{ id: 7, imageUrl: v2 }]);
  assert.equal(cache.getLocalUrl(7, 'image', v2), null, 'a cache miss must not fall back to v1');
  await waitIdle(cache);
  const secondLocal = cache.getLocalUrl(7, 'image', v2);
  assert.ok(secondLocal);
  assert.notEqual(secondLocal, firstLocal);
  assert.equal(cache.getLocalUrl(7, 'image', v1), null);
  assert.equal(cache.getStats().fileCount, 1);

  await cache.shutdown();
  const restarted = createImageCache({ getUserDataPath: () => userData, logger: silentLogger }, { allowHttp: true, minFreeDiskBytes: 0 });
  restarted.initialize();
  t.after(() => restarted.shutdown());
  assert.equal(restarted.getLocalUrl(7, 'image', v2), secondLocal);
});

test('sirve bytes con ETag y responde 304 a una copia válida', async (t) => {
  const fixtureServer = await startServer((_req, res) => jpegResponse(res));
  t.after(fixtureServer.close);
  const { cache } = createFixture(t);
  const source = `${fixtureServer.baseUrl}/full.jpg`;
  cache.reconcileProducts([{ id: 11, imageUrl: source }]);
  await waitIdle(cache);
  const local = cache.getLocalUrl(11, 'image', source);
  const sourceKey = new URL(`http://local${local}`).searchParams.get('v');

  const makeResponse = () => {
    const chunks = [];
    return {
      status: null, headers: null, headersSent: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); this.body = Buffer.concat(chunks); },
      on() {}, once() {}, emit() {},
      write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
      destroy(error) { throw error; },
    };
  };
  const first = makeResponse();
  cache.serveRequest({ url: local, headers: {} }, first, 11, 'image');
  await waitFor(() => first.body);
  assert.equal(first.status, 200);
  assert.equal(first.headers.ETag, `"${sourceKey}"`);
  assert.deepEqual(first.body, JPEG);

  const second = makeResponse();
  cache.serveRequest({ url: local, headers: { 'if-none-match': `"${sourceKey}"` } }, second, 11, 'image');
  assert.equal(second.status, 304);
});

test('rechaza Content-Type no JPEG, firma inválida, body vacío y body chunked excesivo', async (t) => {
  const fixtureServer = await startServer((req, res) => {
    if (req.url === '/type') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(JPEG); }
    if (req.url === '/signature') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(Buffer.from('not-jpeg')); }
    if (req.url === '/empty') { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': 0 }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.write(JPEG);
    res.end(Buffer.alloc(2048, 1));
  });
  t.after(fixtureServer.close);
  const { cache } = createFixture(t);
  for (const [id, route] of [[1, 'type'], [2, 'signature'], [3, 'empty'], [4, 'large']]) {
    cache.reconcileProducts([{ id, imageUrl: `${fixtureServer.baseUrl}/${route}` }]);
    await waitIdle(cache);
    assert.equal(cache.getLocalUrl(id, 'image', `${fixtureServer.baseUrl}/${route}`), null);
  }
  assert.equal(cache.getStats().failedJobs, 1, 'each reconciliation starts a new catalogue and prunes earlier failures');
});

test('reintenta 500 con backoff y termina publicando una única entrada', async (t) => {
  let requests = 0;
  const fixtureServer = await startServer((_req, res) => {
    requests++;
    if (requests < 3) { res.writeHead(500); return res.end('temporary'); }
    jpegResponse(res);
  });
  t.after(fixtureServer.close);
  const { cache } = createFixture(t);
  const source = `${fixtureServer.baseUrl}/retry.jpg`;
  cache.reconcileProducts([{ id: 20, imageUrl: source }]);
  await waitIdle(cache);
  assert.equal(requests, 3);
  assert.ok(cache.getLocalUrl(20, 'image', source));
  assert.equal(cache.getStats().fileCount, 1);
  assert.equal(cache.getStats().failedJobs, 0);
});

test('404 de catálogo es terminal pero 404 post-upload se reintenta', async (t) => {
  const counts = { catalog: 0, upload: 0 };
  const fixtureServer = await startServer((req, res) => {
    if (req.url === '/catalog') { counts.catalog++; res.writeHead(404); return res.end(); }
    counts.upload++;
    if (counts.upload === 1) { res.writeHead(404); return res.end(); }
    jpegResponse(res);
  });
  t.after(fixtureServer.close);
  const { cache } = createFixture(t);
  cache.reconcileProducts([{ id: 30, imageUrl: `${fixtureServer.baseUrl}/catalog` }]);
  await waitIdle(cache);
  assert.equal(counts.catalog, 1);

  cache.invalidateAndEnqueueProduct({ id: 31, imageUrl: `${fixtureServer.baseUrl}/upload` });
  await waitIdle(cache);
  assert.equal(counts.upload, 2);
  assert.ok(cache.getLocalUrl(31, 'image', `${fixtureServer.baseUrl}/upload`));
});

test('respeta concurrencia máxima de tres', async (t) => {
  let active = 0;
  let maximum = 0;
  const fixtureServer = await startServer((_req, res) => {
    active++;
    maximum = Math.max(maximum, active);
    setTimeout(() => { active--; jpegResponse(res); }, 25);
  });
  t.after(fixtureServer.close);
  const { cache } = createFixture(t);
  cache.reconcileProducts(Array.from({ length: 9 }, (_, index) => ({ id: index + 1, imageUrl: `${fixtureServer.baseUrl}/${index}.jpg` })));
  await waitIdle(cache);
  assert.equal(maximum, 3);
  assert.equal(cache.getStats().fileCount, 9);
});

test('un resultado tardío cancelado no puede publicar una URL obsoleta', async (t) => {
  const fixtureServer = await startServer((req, res) => {
    if (req.url === '/old.jpg') return setTimeout(() => jpegResponse(res), 80);
    jpegResponse(res);
  });
  t.after(fixtureServer.close);
  const { cache } = createFixture(t);
  const oldUrl = `${fixtureServer.baseUrl}/old.jpg`;
  const newUrl = `${fixtureServer.baseUrl}/new.jpg`;
  cache.reconcileProducts([{ id: 44, imageUrl: oldUrl }]);
  await waitFor(() => cache.getStats().activeDownloads === 1);
  cache.reconcileProducts([{ id: 44, imageUrl: newUrl }]);
  await waitIdle(cache);
  assert.equal(cache.getLocalUrl(44, 'image', oldUrl), null);
  assert.ok(cache.getLocalUrl(44, 'image', newUrl));
  assert.equal(cache.getStats().fileCount, 1);
});

test('recupera un manifest truncado, limpia tmp antiguo y no toca archivos extranjeros', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nuventa-image-recovery-'));
  const cacheDir = path.join(userData, 'cache', 'product-images');
  fs.mkdirSync(cacheDir, { recursive: true });
  const source = 'https://cdn.test/products/uuid/full.jpg';
  const bootstrap = createImageCache({ getUserDataPath: () => userData, logger: silentLogger });
  const sourceKey = bootstrap._computeSourceKey(source);
  fs.writeFileSync(path.join(cacheDir, `77_image_${sourceKey}.jpg`), JPEG);
  fs.writeFileSync(path.join(cacheDir, 'manifest.json'), '{broken');
  const tempPath = path.join(cacheDir, 'old.jpg.tmp');
  fs.writeFileSync(tempPath, JPEG);
  fs.utimesSync(tempPath, new Date(0), new Date(0));
  fs.writeFileSync(path.join(cacheDir, 'keep-me.txt'), 'foreign');

  const cache = createImageCache({ getUserDataPath: () => userData, logger: silentLogger }, { staleTempAgeMs: 1 });
  cache.initialize();
  t.after(async () => {
    await cache.shutdown();
    fs.rmSync(userData, { recursive: true, force: true });
  });
  assert.ok(cache.getLocalUrl(77, 'image', source));
  assert.equal(cache.getStats().recoveredFiles, 1);
  assert.equal(fs.existsSync(tempPath), false);
  assert.equal(fs.existsSync(path.join(cacheDir, 'keep-me.txt')), true);
});

test('descarta entradas con path traversal sin borrar el archivo externo', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nuventa-image-path-'));
  const cacheDir = path.join(userData, 'cache', 'product-images');
  fs.mkdirSync(cacheDir, { recursive: true });
  const outside = path.join(userData, 'outside.jpg');
  fs.writeFileSync(outside, JPEG);
  fs.writeFileSync(path.join(cacheDir, 'manifest.json'), JSON.stringify({
    '1:image:aaaaaaaaaaaa': {
      sourceKey: 'aaaaaaaaaaaa', normalizedSourceUrl: 'https://cdn.test/x.jpg',
      fileName: '../../outside.jpg', contentType: 'image/jpeg', size: JPEG.length,
    },
  }));
  const cache = createImageCache({ getUserDataPath: () => userData, logger: silentLogger });
  cache.initialize();
  t.after(async () => { await cache.shutdown(); fs.rmSync(userData, { recursive: true, force: true }); });
  assert.equal(cache.getStats().fileCount, 0);
  assert.equal(fs.existsSync(outside), true);
});

test('shutdown aborta una descarga colgada sin rechazo no manejado', async (t) => {
  const fixtureServer = await startServer(() => {});
  t.after(fixtureServer.close);
  const { cache } = createFixture(t, { inactivityTimeoutMs: 1000, jobTimeoutMs: 2000 });
  let unhandled = null;
  const listener = (error) => { unhandled = error; };
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  cache.reconcileProducts([{ id: 99, imageUrl: `${fixtureServer.baseUrl}/hang.jpg` }]);
  await waitFor(() => cache.getStats().activeDownloads === 1);
  await cache.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(unhandled, null);
  assert.equal(cache._getActiveCount(), 0);
});

test('redirect relativo funciona, exceso de redirects falla y HTTP puede bloquearse', async (t) => {
  const fixtureServer = await startServer((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { Location: '/image.jpg' }); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end(); }
    jpegResponse(res);
  });
  t.after(fixtureServer.close);
  const { cache } = createFixture(t, { maxRedirects: 2 });
  const redirected = `${fixtureServer.baseUrl}/start`;
  cache.reconcileProducts([{ id: 101, imageUrl: redirected }]);
  await waitIdle(cache);
  assert.ok(cache.getLocalUrl(101, 'image', redirected));

  const loop = `${fixtureServer.baseUrl}/loop`;
  cache.reconcileProducts([{ id: 102, imageUrl: loop }]);
  await waitIdle(cache);
  assert.equal(cache.getLocalUrl(102, 'image', loop), null);

  const secureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuventa-secure-'));
  const secureOnly = createImageCache({ getUserDataPath: () => secureDir, logger: silentLogger }, {
    allowHttp: false, minFreeDiskBytes: 0, networkRetryDelaysMs: [],
  });
  secureOnly.initialize();
  t.after(async () => { await secureOnly.shutdown(); fs.rmSync(secureDir, { recursive: true, force: true }); });
  secureOnly.reconcileProducts([{ id: 103, imageUrl: `${fixtureServer.baseUrl}/image.jpg` }]);
  await waitIdle(secureOnly);
  assert.equal(secureOnly.getStats().failedJobs, 1);
});

test('un bloqueo transitorio del manifest se reintenta sin suspender ni desalojar', async (t) => {
  let renameFailures = 0;
  let failNextRenames = 0;
  const fsProxy = {
    ...fs,
    promises: {
      ...fs.promises,
      rename: async (...args) => {
        if (failNextRenames > 0) {
          failNextRenames--;
          renameFailures++;
          throw Object.assign(new Error('locked by antivirus'), { code: 'EBUSY' });
        }
        return fs.promises.rename(...args);
      },
    },
  };
  const fixtureServer = await startServer((_req, res) => jpegResponse(res));
  t.after(fixtureServer.close);
  const { cache } = createFixture(t, {}, { fs: fsProxy });
  const v1 = `${fixtureServer.baseUrl}/uuid-1.jpg`;
  const v2 = `${fixtureServer.baseUrl}/uuid-2.jpg`;
  cache.reconcileProducts([{ id: 110, imageUrl: v1 }]);
  await waitIdle(cache);
  failNextRenames = 2;
  cache.reconcileProducts([{ id: 110, imageUrl: v2 }]);
  await waitIdle(cache);
  assert.equal(renameFailures, 2);
  assert.ok(cache.getLocalUrl(110, 'image', v2));
  assert.equal(cache.getStats().suspended, false);
  assert.equal(cache.getStats().fileCount, 1);
});

test('un error permanente no-ENOSPC del manifest conserva la versión durable y no pausa la cola', async (t) => {
  let blockManifest = false;
  const fsProxy = {
    ...fs,
    promises: {
      ...fs.promises,
      rename: async (...args) => {
        if (blockManifest) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return fs.promises.rename(...args);
      },
    },
  };
  const fixtureServer = await startServer((_req, res) => jpegResponse(res));
  t.after(fixtureServer.close);
  const { cache } = createFixture(t, {}, { fs: fsProxy });
  const v1 = `${fixtureServer.baseUrl}/durable.jpg`;
  const v2 = `${fixtureServer.baseUrl}/blocked.jpg`;
  cache.reconcileProducts([{ id: 120, imageUrl: v1 }]);
  await waitIdle(cache);
  blockManifest = true;
  cache.reconcileProducts([{ id: 120, imageUrl: v2 }]);
  await waitIdle(cache);
  assert.equal(cache.getLocalUrl(120, 'image', v2), null);
  assert.equal(cache.getStats().suspended, false);
  assert.equal(cache.getStats().fileCount, 1);
});

test('LRU salta un archivo bloqueado y continúa con otros candidatos', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nuventa-lru-'));
  const cacheDir = path.join(userData, 'cache', 'product-images');
  fs.mkdirSync(cacheDir, { recursive: true });
  const entries = {};
  for (let id = 1; id <= 3; id++) {
    const sourceKey = String(id).repeat(12);
    const fileName = `${id}_image_${sourceKey}.jpg`;
    fs.writeFileSync(path.join(cacheDir, fileName), JPEG);
    entries[`${id}:image:${sourceKey}`] = {
      sourceKey,
      normalizedSourceUrl: `https://cdn.test/${id}.jpg`,
      revisionCreatedAt: id,
      fileName,
      contentType: 'image/jpeg',
      size: JPEG.length,
      lastAccessedAt: `2020-01-0${id}T00:00:00.000Z`,
    };
  }
  fs.writeFileSync(path.join(cacheDir, 'manifest.json'), JSON.stringify(entries));
  const lockedPath = path.join(cacheDir, '1_image_111111111111.jpg');
  const fsProxy = {
    ...fs,
    unlinkSync: (target) => {
      if (path.resolve(target) === path.resolve(lockedPath)) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      return fs.unlinkSync(target);
    },
  };
  const cache = createImageCache({ getUserDataPath: () => userData, logger: silentLogger, fs: fsProxy }, {
    maxFileSize: JPEG.length,
    maxCacheBytes: JPEG.length * 2,
    minFreeDiskBytes: 0,
  });
  cache.initialize();
  t.after(async () => { await cache.shutdown(); fs.rmSync(userData, { recursive: true, force: true }); });
  cache._reclaimDiskSpace(JPEG.length);
  assert.equal(fs.existsSync(lockedPath), true);
  assert.ok(cache.getStats().fileCount <= 2, 'another deletable candidate must be reclaimed');
});

test('una caída masiva usa un único despertador de reintentos', async (t) => {
  const fixtureServer = await startServer((_req, res) => { res.writeHead(503); res.end(); });
  t.after(fixtureServer.close);
  const { cache } = createFixture(t, { networkRetryDelaysMs: [1000] });
  cache.reconcileProducts(Array.from({ length: 18 }, (_, index) => ({
    id: 200 + index,
    imageUrl: `${fixtureServer.baseUrl}/${index}.jpg`,
  })));
  await waitFor(() => cache.getStats().activeDownloads === 0 && cache.getStats().delayedJobs === 18);
  assert.equal(cache._hasRetryWakeTimer(), true);
  assert.equal(cache.getStats().delayedJobs, 18);
});

test('delete durante backoff cancela el retry y elimina las dos variantes', async (t) => {
  let requests = 0;
  const fixtureServer = await startServer((_req, res) => { requests++; res.writeHead(503); res.end(); });
  t.after(fixtureServer.close);
  const { cache } = createFixture(t, { networkRetryDelaysMs: [100] });
  cache.reconcileProducts([{
    id: 300,
    imageUrl: `${fixtureServer.baseUrl}/full.jpg`,
    thumbnailUrl: `${fixtureServer.baseUrl}/thumb.jpg`,
  }]);
  await waitFor(() => cache.getStats().delayedJobs === 2);
  cache.removeProduct(300);
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(requests, 2);
  assert.equal(cache.getStats().delayedJobs, 0);
  assert.equal(cache.getStats().fileCount, 0);
});

test('un producto borrado y recreado enseguida con la misma URL vuelve a encolarse', async (t) => {
  let requests = 0;
  const fixtureServer = await startServer((_req, res) => {
    requests++;
    if (requests === 1) return setTimeout(() => jpegResponse(res), 80);
    jpegResponse(res);
  });
  t.after(fixtureServer.close);
  const { cache } = createFixture(t);
  const source = `${fixtureServer.baseUrl}/same.jpg`;
  cache.reconcileProducts([{ id: 301, imageUrl: source }]);
  await waitFor(() => cache.getStats().activeDownloads === 1);
  cache.removeProduct(301);
  cache.reconcileProducts([{ id: 301, imageUrl: source }]);
  await waitIdle(cache);
  assert.ok(cache.getLocalUrl(301, 'image', source));
  assert.equal(requests, 2);
});

test('catálogo vacío elimina entradas que ya no pertenecen a ningún producto', async (t) => {
  const fixtureServer = await startServer((_req, res) => jpegResponse(res));
  t.after(fixtureServer.close);
  const { cache } = createFixture(t);
  const source = `${fixtureServer.baseUrl}/orphan.jpg`;
  cache.reconcileProducts([{ id: 302, imageUrl: source }]);
  await waitIdle(cache);
  assert.equal(cache.getStats().fileCount, 1);
  cache.reconcileProducts([]);
  await waitFor(() => cache.getStats().fileCount === 0);
  assert.equal(cache.getLocalUrl(302, 'image', source), null);
});

test('ENOSPC libera la reserva, conserva la versión durable y puede reanudar', async (t) => {
  let diskFull = false;
  const fsProxy = {
    ...fs,
    promises: {
      ...fs.promises,
      rename: async (...args) => {
        if (diskFull) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return fs.promises.rename(...args);
      },
    },
  };
  const fixtureServer = await startServer((_req, res) => jpegResponse(res));
  t.after(fixtureServer.close);
  const { cache } = createFixture(t, {}, { fs: fsProxy });
  const v1 = `${fixtureServer.baseUrl}/disk-v1.jpg`;
  const v2 = `${fixtureServer.baseUrl}/disk-v2.jpg`;
  cache.reconcileProducts([{ id: 303, imageUrl: v1 }]);
  await waitIdle(cache);
  diskFull = true;
  cache.reconcileProducts([{ id: 303, imageUrl: v2 }]);
  await waitFor(() => cache.getStats().suspended);
  assert.equal(cache.getStats().reservedBytes, 0);
  assert.equal(cache.getLocalUrl(303, 'image', v2), null);
  assert.ok(cache.getLocalUrl(303, 'image', v1), 'the durable file remains available for its own URL');

  diskFull = false;
  cache.tryResume();
  await waitIdle(cache);
  assert.ok(cache.getLocalUrl(303, 'image', v2));
  assert.equal(cache.getStats().suspended, false);
  assert.equal(cache.getStats().fileCount, 1);
});
