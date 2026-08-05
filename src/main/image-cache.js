// ============================================================
// Nuventa POS — Image Cache Service
// Downloads product images from CloudFront and stores them
// locally so the POS can display them offline.
// Uses a manifest.json for metadata + atomic file writes.
// Non-blocking: cache operations never block login/sync.
// Disk-safe: enforces cache size limit + free disk reserve.
// ============================================================
const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');
const { app } = require('electron');
const http  = require('http');
const https = require('https');

// ── Constants ──────────────────────────────────────────────

const CACHE_DIR_NAME = path.join('cache', 'product-images');
const MANIFEST_FILE  = 'manifest.json';
const MAX_CONCURRENCY = 3;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const MAX_FILE_SIZE  = 10 * 1024 * 1024;       // 10 MB per file
const MAX_CACHE_BYTES = 1024 * 1024 * 1024;    // 1 GB total cache
const MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024; // keep 1 GB free on drive
const LAST_ACCESS_FLUSH_INTERVAL_MS = 30_000;   // batch lastAccessedAt writes
const LAST_ACCESS_FLUSH_COUNT = 50;              // or every N accesses

// CloudFront signed-URL temporary params to strip before hashing
const TEMP_QUERY_PARAMS = new Set([
  'Expires', 'Signature', 'Key-Pair-Id',
  'Policy', 'X-Amz-Date', 'X-Amz-Expires',
  'X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-SignedHeaders',
]);

// ── State ──────────────────────────────────────────────────

let _cacheDir    = null;
let _manifest    = null;  // { "productId:type:sourceKey": { sourceKey, fileName, contentType, size, lastAccessedAt } }
let _manifestDirty = false;
let _queue       = [];
let _pendingKeys = new Set();
let _activeDownloads = new Map();
let _running     = 0;
let _initialized = false;
let _shuttingDown = false;
let _suspended   = false;  // queue suspended due to disk-full
let _lastAccessDirty = 0;   // count of serveRequest hits not yet flushed
let _accessFlushTimer = null;

// ── Initialization ─────────────────────────────────────────

function getCacheDir() {
  if (_cacheDir) return _cacheDir;
  _cacheDir = path.join(app.getPath('userData'), CACHE_DIR_NAME);
  return _cacheDir;
}

function loadManifest() {
  const manifestPath = path.join(getCacheDir(), MANIFEST_FILE);
  try {
    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      _manifest = JSON.parse(raw);
      if (!_manifest || typeof _manifest !== 'object') _manifest = {};
    } else {
      _manifest = {};
    }
  } catch (err) {
    console.error('[IMAGE-CACHE] Failed to load manifest:', err.message);
    _manifest = {};
  }
}

function saveManifest(force = false) {
  if (!force && (!_manifestDirty || _shuttingDown)) return;
  const dir = getCacheDir();
  const manifestPath = path.join(dir, MANIFEST_FILE);
  const tmpPath = manifestPath + '.tmp';
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const json = JSON.stringify(_manifest, null, 2);
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, manifestPath);
    _manifestDirty = false;
    _lastAccessDirty = 0;
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    // ENOSPC: keep previous manifest — it's still valid
    if (isDiskFullError(err)) {
      console.error('[IMAGE-CACHE] Disk full — manifest not saved, previous version retained');
    } else {
      console.error('[IMAGE-CACHE] Failed to save manifest:', err.message);
    }
  }
}

function markManifestDirty() {
  _manifestDirty = true;
}

function initialize() {
  if (_initialized) return;
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  loadManifest();
  _initialized = true;
  console.log(`[IMAGE-CACHE] Initialized in ${dir} (${Object.keys(_manifest).length} entries)`);
}

// ── URL normalization ──────────────────────────────────────

function normalizeSourceUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const params = u.searchParams;
    const keysToDelete = [];
    for (const key of params.keys()) {
      if (TEMP_QUERY_PARAMS.has(key)) keysToDelete.push(key);
    }
    for (const k of keysToDelete) params.delete(k);
    const qs = params.toString();
    return u.origin + u.pathname + (qs ? '?' + qs : '');
  } catch {
    return url;
  }
}

function computeSourceKey(sourceUrl) {
  if (!sourceUrl) return '';
  const normalized = normalizeSourceUrl(sourceUrl);
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

function cacheKey(productId, type, sourceUrl) {
  const sk = computeSourceKey(sourceUrl);
  return `${productId}:${type}:${sk}`;
}

// ── Manifest helpers ───────────────────────────────────────

function getManifestEntry(productId, type) {
  if (!_manifest) return null;
  const prefix = `${productId}:${type}:`;
  for (const key of Object.keys(_manifest)) {
    if (key.startsWith(prefix)) return { key, ..._manifest[key] };
  }
  return null;
}

function hasLocalVersion(productId, type, sourceUrl) {
  if (!sourceUrl) return false;
  const sk = computeSourceKey(sourceUrl);
  if (!sk) return false;
  const key = `${productId}:${type}:${sk}`;
  const entry = _manifest[key];
  if (!entry) return false;
  const filePath = path.join(getCacheDir(), entry.fileName);
  if (!fs.existsSync(filePath)) {
    delete _manifest[key];
    markManifestDirty();
    return false;
  }
  return true;
}

// ── Disk space helpers ─────────────────────────────────────

function isDiskFullError(err) {
  return err && (err.code === 'ENOSPC' || err.code === 'EDQUOT');
}

function calculateCacheSize() {
  if (!_manifest) return 0;
  let total = 0;
  for (const key of Object.keys(_manifest)) {
    total += _manifest[key].size || 0;
  }
  return total;
}

function getFreeDiskBytes() {
  try {
    const dir = getCacheDir();
    if (!fs.existsSync(dir)) return Infinity;
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return Infinity;
  }
}

function canDownload(expectedBytes = 0) {
  if (_suspended) return false;
  const cacheBytes = calculateCacheSize();
  if (cacheBytes + expectedBytes > MAX_CACHE_BYTES) return false;
  const freeBytes = getFreeDiskBytes();
  if (freeBytes < MIN_FREE_DISK_BYTES + expectedBytes) return false;
  return true;
}

function suspendQueue(reason) {
  if (_suspended) return;
  _suspended = true;
  console.warn(`[IMAGE-CACHE] Queue suspended: ${reason}`);
}

function resumeQueue() {
  if (!_suspended) return;
  _suspended = false;
  console.log('[IMAGE-CACHE] Queue resumed');
  processQueue();
}

// ── Space reclamation (eviction policy) ────────────────────

function reclaimDiskSpace() {
  const dir = getCacheDir();
  let freed = 0;

  // 1. Clean stale .tmp files
  try {
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir);
      for (const file of entries) {
        if (file.endsWith('.tmp')) {
          try { const s = fs.statSync(path.join(dir, file)); freed += s.size; } catch (_) { freed += 0; }
          try { fs.unlinkSync(path.join(dir, file)); } catch (_) {}
        }
      }
    }
  } catch (_) {}
  if (freed > 0) console.log(`[IMAGE-CACHE] Reclaimed ${freed} bytes from stale .tmp`);

  // 2. Remove manifest entries whose files are missing (stale manifest)
  const orphanKeys = [];
  for (const key of Object.keys(_manifest)) {
    const entry = _manifest[key];
    if (_activeDownloads.has(key) || _pendingKeys.has(key)) continue;
    const filePath = path.join(dir, entry.fileName);
    if (!fs.existsSync(filePath)) {
      orphanKeys.push(key);
      freed += entry.size || 0;
    }
  }
  for (const key of orphanKeys) delete _manifest[key];
  if (orphanKeys.length > 0) {
    markManifestDirty();
    console.log(`[IMAGE-CACHE] Removed ${orphanKeys.length} stale manifest entries`);
  }

  // 3. Remove old versions of images (keep only the latest for each product:type)
  const typeLatest = new Map(); // "productId:type" → { key, lastAccessedAt }
  for (const key of Object.keys(_manifest)) {
    if (_activeDownloads.has(key) || _pendingKeys.has(key)) continue;
    const parts = key.split(':');
    const pt = `${parts[0]}:${parts[1]}`;
    const entry = _manifest[key];
    const existing = typeLatest.get(pt);
    if (!existing || (entry.lastAccessedAt || '') > (existing.entry.lastAccessedAt || '')) {
      typeLatest.set(pt, { key, entry });
    }
  }

  const oldVersionKeys = [];
  for (const key of Object.keys(_manifest)) {
    if (_activeDownloads.has(key) || _pendingKeys.has(key)) continue;
    const parts = key.split(':');
    const pt = `${parts[0]}:${parts[1]}`;
    const latest = typeLatest.get(pt);
    if (latest && key !== latest.key) {
      oldVersionKeys.push(key);
      freed += _manifest[key].size || 0;
    }
  }
  for (const key of oldVersionKeys) {
    const entry = _manifest[key];
    try { const fp = path.join(dir, entry.fileName); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
    delete _manifest[key];
  }
  if (oldVersionKeys.length > 0) {
    markManifestDirty();
    console.log(`[IMAGE-CACHE] Removed ${oldVersionKeys.length} old image versions`);
  }

  // 4. If still need space, evict full images LRU (keep thumbnails)
  if (calculateCacheSize() > MAX_CACHE_BYTES || getFreeDiskBytes() < MIN_FREE_DISK_BYTES) {
    const fullImages = [];
    for (const key of Object.keys(_manifest)) {
      if (_activeDownloads.has(key) || _pendingKeys.has(key)) continue;
      if (key.includes(':image:')) {
        fullImages.push({ key, ..._manifest[key] });
      }
    }
    // Oldest accessed first
    fullImages.sort((a, b) => (a.lastAccessedAt || '').localeCompare(b.lastAccessedAt || ''));

    for (const img of fullImages) {
      try { const fp = path.join(dir, img.fileName); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
      delete _manifest[img.key];
      freed += img.size || 0;
      markManifestDirty();
      if (calculateCacheSize() <= MAX_CACHE_BYTES * 0.8 && getFreeDiskBytes() >= MIN_FREE_DISK_BYTES) break;
    }
    console.log(`[IMAGE-CACHE] Evicted full images — cache size now ${calculateCacheSize()}`);
  }

  // 5. Last resort: evict thumbnails LRU (oldest first)
  if (calculateCacheSize() > MAX_CACHE_BYTES || getFreeDiskBytes() < MIN_FREE_DISK_BYTES) {
    const thumbs = [];
    for (const key of Object.keys(_manifest)) {
      if (_activeDownloads.has(key) || _pendingKeys.has(key)) continue;
      if (key.includes(':thumbnail:')) {
        thumbs.push({ key, ..._manifest[key] });
      }
    }
    thumbs.sort((a, b) => (a.lastAccessedAt || '').localeCompare(b.lastAccessedAt || ''));

    for (const t of thumbs) {
      try { const fp = path.join(dir, t.fileName); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
      delete _manifest[t.key];
      freed += t.size || 0;
      markManifestDirty();
      if (calculateCacheSize() <= MAX_CACHE_BYTES * 0.8 && getFreeDiskBytes() >= MIN_FREE_DISK_BYTES) break;
    }
    console.log(`[IMAGE-CACHE] Evicted thumbnails — cache size now ${calculateCacheSize()}`);
  }

  saveManifest(true);
  return freed;
}

// ── Last-access tracking (deferred writes) ─────────────────

function touchEntry(key) {
  const entry = _manifest[key];
  if (!entry) return;
  entry.lastAccessedAt = new Date().toISOString();
  _lastAccessDirty++;
  markManifestDirty();
  if (_lastAccessDirty >= LAST_ACCESS_FLUSH_COUNT) {
    _scheduleAccessFlush();
  } else if (!_accessFlushTimer) {
    _accessFlushTimer = setTimeout(_flushAccessTimer, LAST_ACCESS_FLUSH_INTERVAL_MS);
  }
}

function _scheduleAccessFlush() {
  if (_accessFlushTimer) clearTimeout(_accessFlushTimer);
  _accessFlushTimer = setTimeout(_flushAccessTimer, 0);
}

function _flushAccessTimer() {
  _accessFlushTimer = null;
  if (_lastAccessDirty > 0) saveManifest(true);
}

// ── Atomic download (ENOSPC-safe) ──────────────────────────

function downloadFile(sourceUrl, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(sourceUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    const tmpPath = destPath + '.tmp';

    const parentDir = path.dirname(destPath);
    if (!fs.existsSync(parentDir)) {
      try {
        fs.mkdirSync(parentDir, { recursive: true });
      } catch (err) {
        if (isDiskFullError(err)) {
          return reject(Object.assign(new Error('Disk full — cannot create cache directory'), { code: 'ENOSPC', diskFull: true }));
        }
        return reject(err);
      }
    }

    let redirectCount = 0;
    let timeout = setTimeout(() => reject(new Error('Download timeout')), DOWNLOAD_TIMEOUT_MS);

    function cleanupTemp() {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    }

    function streamUrl(url) {
      const req = transport.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          redirectCount++;
          if (redirectCount > MAX_REDIRECTS) {
            cleanupTemp();
            return reject(new Error('Too many redirects'));
          }
          return streamUrl(res.headers.location);
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          cleanupTemp();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const contentType = (res.headers['content-type'] || '').toLowerCase();
        if (!contentType.startsWith('image/')) {
          res.resume();
          cleanupTemp();
          return reject(new Error(`Unexpected Content-Type: ${contentType}`));
        }

        const contentLength = parseInt(res.headers['content-length'], 10);
        if (contentLength === 0 || contentLength > MAX_FILE_SIZE) {
          res.resume();
          cleanupTemp();
          return reject(new Error(`Invalid content-length: ${contentLength}`));
        }

        let received = 0;
        const writeStream = fs.createWriteStream(tmpPath);

        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > MAX_FILE_SIZE) {
            writeStream.destroy();
            res.destroy();
            cleanupTemp();
            reject(new Error('File too large'));
            return;
          }
        });

        res.pipe(writeStream);

        writeStream.on('finish', () => {
          clearTimeout(timeout);
          try {
            const stat = fs.statSync(tmpPath);
            if (stat.size === 0) {
              cleanupTemp();
              return reject(new Error('Downloaded file is empty'));
            }
            fs.renameSync(tmpPath, destPath);
            resolve({ contentType, size: stat.size });
          } catch (err) {
            cleanupTemp();
            reject(err);
          }
        });

        writeStream.on('error', (err) => {
          clearTimeout(timeout);
          writeStream.destroy();
          cleanupTemp();
          if (isDiskFullError(err)) {
            reject(Object.assign(new Error('Disk full during write'), { code: err.code, diskFull: true }));
          } else {
            reject(err);
          }
        });

        res.on('error', (err) => {
          clearTimeout(timeout);
          writeStream.destroy();
          cleanupTemp();
          reject(err);
        });
      });

      req.on('error', (err) => {
        cleanupTemp();
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        cleanupTemp();
        reject(new Error('Request timeout'));
      });
    }

    streamUrl(sourceUrl);
  });
}

// ── Enqueue / queue management ─────────────────────────────

function getExtension(contentType) {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
  };
  return map[contentType] || '.img';
}

function processQueue() {
  if (_shuttingDown || _suspended || _queue.length === 0) return;

  while (_running < MAX_CONCURRENCY && _queue.length > 0) {
    const job = _queue.shift();
    _running++;
    _processJob(job);
  }
}

async function _processJob(job) {
  const { productId, type, sourceUrl, key } = job;
  _activeDownloads.set(key, job);
  const startTime = Date.now();
  try {
    const sk = computeSourceKey(sourceUrl);
    if (!sk) throw new Error('Empty sourceKey');

    // Pre-download space check: use MAX_FILE_SIZE as conservative estimate
    if (!canDownload(MAX_FILE_SIZE)) {
      reclaimDiskSpace();
      if (!canDownload(MAX_FILE_SIZE)) {
        suspendQueue('disk-full');
        console.warn(`[IMAGE-CACHE] Disk full — download skipped for #${productId} ${type}, queue suspended`);
        return;
      }
    }

    const ext = '.jpg';
    const fileName = `${productId}_${type}_${sk}${ext}`;
    const destPath = path.join(getCacheDir(), fileName);

    const { contentType, size } = await downloadFile(sourceUrl, destPath);
    const actualExt = getExtension(contentType);

    let finalFileName = fileName;
    if (actualExt !== ext) {
      finalFileName = `${productId}_${type}_${sk}${actualExt}`;
      const newPath = path.join(getCacheDir(), finalFileName);
      if (destPath !== newPath) fs.renameSync(destPath, newPath);
    }

    // Remove previous versions of this product:type
    const prefix = `${productId}:${type}:`;
    const oldKeys = Object.keys(_manifest).filter(k => k.startsWith(prefix) && k !== key);
    for (const ok of oldKeys) {
      const oldEntry = _manifest[ok];
      try {
        const oldPath = path.join(getCacheDir(), oldEntry.fileName);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch (_) {}
      delete _manifest[ok];
    }

    _manifest[key] = { sourceKey: sk, fileName: finalFileName, contentType, size, lastAccessedAt: null };
    markManifestDirty();
    saveManifest();
    console.log(`[IMAGE-CACHE] Downloaded #${productId} ${type} (${size} bytes, ${Date.now() - startTime}ms)`);
  } catch (err) {
    if (err.diskFull) {
      reclaimDiskSpace();
      if (!canDownload(MAX_FILE_SIZE)) suspendQueue('disk-full');
      console.warn(`[IMAGE-CACHE] Disk full — #${productId} ${type} deferred`);
    } else {
      console.error(`[IMAGE-CACHE] Failed ${type} for #${productId}: ${err.message}`);
    }
  } finally {
    _activeDownloads.delete(key);
    _pendingKeys.delete(key);
    _running--;
    saveManifest();
    processQueue();
  }
}

function enqueue(productId, type, sourceUrl) {
  if (!_initialized || _shuttingDown) return;
  if (!sourceUrl) return;
  const key = cacheKey(productId, type, sourceUrl);
  if (!key || _pendingKeys.has(key) || _activeDownloads.has(key)) return;
  if (hasLocalVersion(productId, type, sourceUrl)) return;

  _pendingKeys.add(key);
  _queue.push({ productId, type, sourceUrl, key });
  processQueue();
}

function enqueueProduct(product) {
  if (!product || !product.id) return;
  if (product.imageUrl) enqueue(product.id, 'image', product.imageUrl);
  if (product.thumbnailUrl) enqueue(product.id, 'thumbnail', product.thumbnailUrl);
}

// ── Reconcile (sync / login) ───────────────────────────────

function reconcileProducts(products) {
  if (!_initialized || _shuttingDown) return;
  if (!Array.isArray(products) || products.length === 0) return;

  const activeCacheKeys = new Set();

  for (const p of products) {
    if (!p || !p.id) continue;
    const imgUrl = (p.imageUrl || p.ImageUrl || p.image_url) || null;
    const thumbUrl = (p.thumbnailUrl || p.ThumbnailUrl || p.thumbnail_url) || null;

    if (imgUrl) {
      const key = cacheKey(p.id, 'image', imgUrl);
      activeCacheKeys.add(key);
      if (!hasLocalVersion(p.id, 'image', imgUrl)) {
        enqueue(p.id, 'image', imgUrl);
      }
    }

    if (thumbUrl) {
      const key = cacheKey(p.id, 'thumbnail', thumbUrl);
      activeCacheKeys.add(key);
      if (!hasLocalVersion(p.id, 'thumbnail', thumbUrl)) {
        enqueue(p.id, 'thumbnail', thumbUrl);
      }
    }
  }

  setImmediate(() => clearOrphans(activeCacheKeys));
}

// ── Serve cached file ──────────────────────────────────────

function serveRequest(req, res, productId, type) {
  if (!_initialized) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Cache not ready');
    return;
  }

  const entry = getManifestEntry(productId, type);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const filePath = path.join(getCacheDir(), entry.fileName);
  if (!fs.existsSync(filePath)) {
    const prefix = `${productId}:${type}:`;
    for (const key of Object.keys(_manifest)) {
      if (key.startsWith(prefix)) { delete _manifest[key]; markManifestDirty(); }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // Track access for LRU eviction (deferred persistence)
  touchEntry(entry.key);

  const etag = `"${entry.sourceKey}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'ETag': etag });
    res.end();
    return;
  }

  try {
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': entry.contentType || 'image/jpeg',
      'Content-Length': stat.size,
      'ETag': etag,
      'Cache-Control': 'private, no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

// ── Public URL generation ──────────────────────────────────

function getLocalUrl(productId, type, sourceUrl) {
  if (!_initialized || !sourceUrl) return null;
  if (!hasLocalVersion(productId, type, sourceUrl)) return null;
  const sk = computeSourceKey(sourceUrl);
  return `/api/local-product-images/${productId}/${type}?v=${sk}`;
}

// ── Cleanup ────────────────────────────────────────────────

function removeProduct(productId) {
  if (!_initialized || !productId) return;
  const prefixes = [`${productId}:image:`, `${productId}:thumbnail:`];
  const keysToDelete = Object.keys(_manifest).filter(k =>
    prefixes.some(p => k.startsWith(p))
  );
  for (const key of keysToDelete) {
    const entry = _manifest[key];
    try {
      const filePath = path.join(getCacheDir(), entry.fileName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.error(`[IMAGE-CACHE] Failed to delete ${entry.fileName}:`, err.message);
    }
    delete _manifest[key];
  }
  if (keysToDelete.length > 0) markManifestDirty();
}

function clearOrphans(activeCacheKeys) {
  if (!_initialized) return;
  if (!(activeCacheKeys instanceof Set)) return;

  const keysToDelete = [];
  for (const key of Object.keys(_manifest)) {
    if (!activeCacheKeys.has(key)) {
      if (!_activeDownloads.has(key) && !_pendingKeys.has(key)) {
        keysToDelete.push(key);
      }
    }
  }

  for (const key of keysToDelete) {
    const entry = _manifest[key];
    try {
      const filePath = path.join(getCacheDir(), entry.fileName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
    delete _manifest[key];
  }

  if (keysToDelete.length > 0) {
    markManifestDirty();
    saveManifest();
    console.log(`[IMAGE-CACHE] Cleaned ${keysToDelete.length} orphaned images`);
  }

  // Also clean orphaned .tmp files
  try {
    const dir = getCacheDir();
    const entries = fs.readdirSync(dir);
    for (const file of entries) {
      if (file.endsWith('.tmp')) {
        try { fs.unlinkSync(path.join(dir, file)); } catch (_) {}
      }
    }
  } catch (_) {}
}

// ── Stats ──────────────────────────────────────────────────

function getStats() {
  if (!_initialized) return null;
  let totalSize = 0;
  let fileCount = 0;
  let thumbnailCount = 0;
  let imageCount = 0;
  for (const key of Object.keys(_manifest)) {
    totalSize += _manifest[key].size || 0;
    fileCount++;
    if (key.includes(':thumbnail:')) thumbnailCount++;
    else if (key.includes(':image:')) imageCount++;
  }
  const freeBytes = getFreeDiskBytes();
  return {
    fileCount,
    imageCount,
    thumbnailCount,
    totalBytes: totalSize,
    totalMB: (totalSize / (1024 * 1024)).toFixed(1),
    cacheLimitBytes: MAX_CACHE_BYTES,
    cacheLimitMB: (MAX_CACHE_BYTES / (1024 * 1024)).toFixed(0),
    freeDiskBytes: freeBytes,
    freeDiskGB: freeBytes === Infinity ? 'N/A' : (freeBytes / (1024 * 1024 * 1024)).toFixed(1),
    pendingJobs: _queue.length,
    activeDownloads: _activeDownloads.size,
    suspended: _suspended,
  };
}

// ── Shutdown ───────────────────────────────────────────────

function shutdown() {
  _shuttingDown = true;
  if (_accessFlushTimer) { clearTimeout(_accessFlushTimer); _accessFlushTimer = null; }
  _queue = [];
  _pendingKeys.clear();
  _suspended = false;
  saveManifest(true);
  _initialized = false;
  _cacheDir = null;
  _manifest = null;
  _manifestDirty = false;
  _lastAccessDirty = 0;
  console.log('[IMAGE-CACHE] Shut down');
}

// ── Exports ────────────────────────────────────────────────

module.exports = {
  initialize,
  shutdown,
  getStats,
  // Queue management
  enqueueProduct,
  reconcileProducts,
  // Serving + URLs
  serveRequest,
  getLocalUrl,
  // Cleanup
  removeProduct,
  clearOrphans,
  // Internal (for testing / diagnostics)
  _getQueueSize: () => _queue.length,
  _getActiveCount: () => _activeDownloads.size,
  _isSuspended: () => _suspended,
};
