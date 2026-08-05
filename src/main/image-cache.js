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
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

// ── Constants ──────────────────────────────────────────────

const CACHE_DIR_NAME = path.join('cache', 'product-images');
const MANIFEST_FILE  = 'manifest.json';
const MAX_CONCURRENCY = 3;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const MAX_FILE_SIZE  = 10 * 1024 * 1024;       // 10 MB per file
const MAX_CACHE_BYTES = 1024 * 1024 * 1024;    // 1 GB total cache
const MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024; // keep 1 GB free on drive
const MANIFEST_FLUSH_MS = 2_000;                // debounce manifest writes
const RESUME_CHECK_MS = 300_000;                // periodic space check while suspended (5 min)
const STALE_TMP_AGE_MS = 3_600_000;             // 1 hour — ignore newer .tmp as potentially active
const SHUTDOWN_DRAIN_MS = 3_000;                // max wait for active downloads on shutdown
const LAST_ACCESS_FLUSH_INTERVAL_MS = 30_000;
const LAST_ACCESS_FLUSH_COUNT = 50;

// CloudFront signed-URL temporary params to strip before hashing
const TEMP_QUERY_PARAMS = new Set([
  'Expires', 'Signature', 'Key-Pair-Id',
  'Policy', 'X-Amz-Date', 'X-Amz-Expires',
  'X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-SignedHeaders',
]);

// ── State ──────────────────────────────────────────────────

let _cacheDir    = null;
let _manifest    = null;
let _manifestDirty = false;
let _manifestFlushTimer = null;
let _queue       = [];
let _pendingKeys = new Set();
let _activeDownloads = new Map();
let _running     = 0;
let _initialized = false;
let _disabled    = false;   // cache inoperable (init failure) — degrade safely
let _shuttingDown = false;
let _suspended   = false;
let _desiredKeys = new Map();  // "productId:type" → key
let _reservedDownloadBytes = 0;
let _activeTempPaths = new Set();
let _abortControllers = new Map();  // key → AbortController
let _resumeTimer = null;
let _lastAccessDirty = 0;
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

function scheduleManifestFlush() {
  if (_manifestFlushTimer) clearTimeout(_manifestFlushTimer);
  _manifestFlushTimer = setTimeout(_doManifestFlush, MANIFEST_FLUSH_MS);
}

function _doManifestFlush() {
  _manifestFlushTimer = null;
  saveManifest(true);
}

function saveManifest(force = false) {
  if (!force && (!_manifestDirty || _shuttingDown)) return true;
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
    return true;
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    if (isDiskFullError(err)) {
      console.error('[IMAGE-CACHE] Disk full — manifest not saved, previous version retained');
    } else {
      console.error('[IMAGE-CACHE] Failed to save manifest:', err.message);
    }
    return false;
  }
}

function markManifestDirty() {
  _manifestDirty = true;
  scheduleManifestFlush();
}

function initialize() {
  if (_initialized) return;
  try {
    const dir = getCacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    loadManifest();
    _initialized = true;
    console.log(`[IMAGE-CACHE] Initialized in ${dir} (${Object.keys(_manifest).length} entries)`);
  } catch (err) {
    _disabled = true;
    _manifest = {};
    _initialized = true; // prevent re-init attempts
    console.error('[IMAGE-CACHE] Cache disabled — init failed:', err.message);
  }
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

function computeSourceKey(sourceUrl, versionHint = '') {
  if (!sourceUrl) return '';
  const normalized = normalizeSourceUrl(sourceUrl);
  if (!normalized) return '';
  return crypto.createHash('sha256')
    .update(normalized + ':' + (versionHint || ''))
    .digest('hex')
    .slice(0, 12);
}

function cacheKey(productId, type, sourceUrl, versionHint) {
  const sk = computeSourceKey(sourceUrl, versionHint);
  return `${productId}:${type}:${sk}`;
}

// ── Manifest helpers ───────────────────────────────────────

function entryFileExists(entry) {
  if (!entry) return false;
  const fp = path.join(getCacheDir(), entry.fileName);
  return fs.existsSync(fp);
}

function findEntryByNormalizedUrl(productId, type, normalizedUrl) {
  if (!_manifest || !normalizedUrl) return null;
  const prefix = `${productId}:${type}:`;
  let best = null;
  for (const key of Object.keys(_manifest)) {
    if (!key.startsWith(prefix)) continue;
    const entry = _manifest[key];
    if (entry.normalizedSourceUrl === normalizedUrl) {
      if (!best || (entry.revisionCreatedAt || 0) > (best.revisionCreatedAt || 0)) {
        best = { key, ...entry };
      }
    }
  }
  return best;
}

function findLatestEntry(productId, type) {
  if (!_manifest) return null;
  const prefix = `${productId}:${type}:`;
  let best = null;
  for (const key of Object.keys(_manifest)) {
    if (!key.startsWith(prefix)) continue;
    const entry = _manifest[key];
    if (!best || (entry.revisionCreatedAt || 0) > (best.revisionCreatedAt || 0)) {
      best = { key, ...entry };
    }
  }
  return best;
}

function findLatestValidEntry(productId, type) {
  if (!_manifest) return null;
  const prefix = `${productId}:${type}:`;
  const entries = [];
  for (const key of Object.keys(_manifest)) {
    if (!key.startsWith(prefix)) continue;
    entries.push({ key, ..._manifest[key] });
  }
  entries.sort((a, b) => (b.revisionCreatedAt || 0) - (a.revisionCreatedAt || 0));
  for (const entry of entries) {
    if (entryFileExists(entry)) return entry;
    // Stale — clean up
    delete _manifest[entry.key];
    markManifestDirty();
  }
  return null;
}

function findEntryByNormalizedUrlValid(productId, type, normalizedUrl) {
  if (!_manifest || !normalizedUrl) return null;
  const prefix = `${productId}:${type}:`;
  const entries = [];
  for (const key of Object.keys(_manifest)) {
    if (!key.startsWith(prefix)) continue;
    const entry = _manifest[key];
    if (entry.normalizedSourceUrl === normalizedUrl) {
      entries.push({ key, ...entry });
    }
  }
  entries.sort((a, b) => (b.revisionCreatedAt || 0) - (a.revisionCreatedAt || 0));
  for (const entry of entries) {
    if (entryFileExists(entry)) return entry;
    delete _manifest[entry.key];
    markManifestDirty();
  }
  return null;
}

function hasLocalVersion(productId, type, sourceUrl) {
  if (!sourceUrl) return false;
  const sk = computeSourceKey(sourceUrl);
  const key = `${productId}:${type}:${sk}`;
  const entry = _manifest[key];
  if (!entry) return false;
  if (!entryFileExists(entry)) {
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

function hasRequiredSpace(requiredBytes) {
  const cacheBytes = calculateCacheSize();
  if (cacheBytes + _reservedDownloadBytes + requiredBytes > MAX_CACHE_BYTES) return false;
  const freeBytes = getFreeDiskBytes();
  if (freeBytes < MIN_FREE_DISK_BYTES + _reservedDownloadBytes + requiredBytes) return false;
  return true;
}

function canDownload(additionalBytes = 0) {
  if (!_initialized || _disabled || _shuttingDown) return false;
  return hasRequiredSpace(additionalBytes);
}

function suspendQueue(reason) {
  if (_suspended) return;
  _suspended = true;
  console.warn(`[IMAGE-CACHE] Queue suspended: ${reason}`);
  _startResumeTimer();
}

function resumeQueue() {
  if (!_suspended) return;
  _suspended = false;
  _stopResumeTimer();
  console.log('[IMAGE-CACHE] Queue resumed');
  processQueue();
}

function _startResumeTimer() {
  if (_resumeTimer) return;
  _resumeTimer = setInterval(() => {
    if (_shuttingDown) { _stopResumeTimer(); return; }
    tryResume();
  }, RESUME_CHECK_MS);
  if (_resumeTimer.unref) _resumeTimer.unref();
}

function _stopResumeTimer() {
  if (_resumeTimer) { clearInterval(_resumeTimer); _resumeTimer = null; }
}

function tryResume() {
  if (!_suspended) return;
  reclaimDiskSpace(MAX_FILE_SIZE);
  if (canDownload(MAX_FILE_SIZE)) resumeQueue();
}

// ── Space reclamation (eviction policy) ────────────────────

function _derivePendingProductTypes() {
  const s = new Set();
  for (const key of _pendingKeys) {
    const parts = key.split(':');
    s.add(`${parts[0]}:${parts[1]}`);
  }
  for (const key of _activeDownloads.keys()) {
    const parts = key.split(':');
    s.add(`${parts[0]}:${parts[1]}`);
  }
  return s;
}

function _cancelProductType(pt) {
  const keyPrefix = `${pt}:`;

  _queue = _queue.filter((job) => {
    const jobPt = `${job.productId}:${job.type}`;
    if (jobPt !== pt) return true;
    _pendingKeys.delete(job.key);
    return false;
  });

  for (const [key, controller] of _abortControllers) {
    if (key.startsWith(keyPrefix)) controller.abort();
  }
}

function _removeEntry(key) {
  const entry = _manifest[key];
  if (!entry) return false;
  const fp = path.join(getCacheDir(), entry.fileName);
  if (fs.existsSync(fp)) {
    try { fs.unlinkSync(fp); } catch (err) {
      console.warn(`[IMAGE-CACHE] Could not delete ${entry.fileName}: ${err.message}`);
      return false;
    }
  }
  delete _manifest[key];
  markManifestDirty();
  return true;
}

function reclaimDiskSpace(requiredBytes) {
  if (!_initialized) return 0;
  const dir = getCacheDir();
  let freed = 0;
  const pendingPt = _derivePendingProductTypes();

  // Stage 1: stale .tmp files (not active, older than 1h)
  try {
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir);
      const now = Date.now();
      for (const file of entries) {
        if (!file.endsWith('.tmp')) continue;
        const fp = path.join(dir, file);
        if (_activeTempPaths.has(fp)) continue;
        try {
          const st = fs.statSync(fp);
          if (now - st.mtimeMs < STALE_TMP_AGE_MS) continue;
          fs.unlinkSync(fp);
          freed += st.size;
        } catch (_) {}
      }
    }
  } catch (_) {}

  // Stage 2: stale manifest entries (file missing)
  for (const key of Object.keys(_manifest)) {
    if (_activeDownloads.has(key) || _pendingKeys.has(key)) continue;
    if (!entryFileExists(_manifest[key])) {
      freed += _manifest[key].size || 0;
      delete _manifest[key];
      markManifestDirty();
    }
  }

  // Stage 3: old versions (keep only latest by revisionCreatedAt per productId:type)
  {
    const latest = new Map(); // "productId:type" → { key, revisionCreatedAt }
    for (const key of Object.keys(_manifest)) {
      if (_activeDownloads.has(key) || _pendingKeys.has(key)) continue;
      const parts = key.split(':');
      const pt = `${parts[0]}:${parts[1]}`;
      const entry = _manifest[key];
      const prev = latest.get(pt);
      if (!prev || (entry.revisionCreatedAt || 0) > (prev.revisionCreatedAt || 0)) {
        latest.set(pt, { key, revisionCreatedAt: entry.revisionCreatedAt || 0 });
      }
    }
    for (const key of Object.keys(_manifest)) {
      if (_activeDownloads.has(key) || _pendingKeys.has(key)) continue;
      const parts = key.split(':');
      const pt = `${parts[0]}:${parts[1]}`;
      const best = latest.get(pt);
      if (best && key !== best.key) {
        const oldSize = _manifest[key] ? (_manifest[key].size || 0) : 0;
        if (_removeEntry(key)) freed += oldSize;
      }
    }
  }

  // Stage 4: LRU full images (skip if product:type has desired version pending)
  while (!hasRequiredSpace(requiredBytes)) {
    const candidates = [];
    for (const key of Object.keys(_manifest)) {
      if (_activeDownloads.has(key) || _pendingKeys.has(key)) continue;
      if (!key.includes(':image:')) continue;
      const parts = key.split(':');
      if (pendingPt.has(`${parts[0]}:${parts[1]}`)) continue;
      candidates.push({ key, lastAccessedAt: _manifest[key].lastAccessedAt || '', size: _manifest[key].size || 0 });
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) => a.lastAccessedAt.localeCompare(b.lastAccessedAt));
    if (_removeEntry(candidates[0].key)) {
      freed += candidates[0].size;
    } else {
      break; // couldn't delete this one — avoid infinite loop
    }
  }

  // Stage 5: LRU thumbnails (last resort)
  while (!hasRequiredSpace(requiredBytes)) {
    const candidates = [];
    for (const key of Object.keys(_manifest)) {
      if (_activeDownloads.has(key) || _pendingKeys.has(key)) continue;
      if (!key.includes(':thumbnail:')) continue;
      const parts = key.split(':');
      if (pendingPt.has(`${parts[0]}:${parts[1]}`)) continue;
      candidates.push({ key, lastAccessedAt: _manifest[key].lastAccessedAt || '', size: _manifest[key].size || 0 });
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) => a.lastAccessedAt.localeCompare(b.lastAccessedAt));
    if (_removeEntry(candidates[0].key)) {
      freed += candidates[0].size;
    } else {
      break;
    }
  }

  if (freed > 0) console.log(`[IMAGE-CACHE] Reclaimed ${freed} bytes`);
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

// ── Atomic download (pipeline-based, ENOSPC-safe, AbortSignal) ──

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

async function downloadFile(sourceUrl, destPath, signal) {
  const tmpPath = destPath + '.tmp';
  _activeTempPaths.add(tmpPath);

  const parentDir = path.dirname(destPath);
  if (!fs.existsSync(parentDir)) {
    try {
      fs.mkdirSync(parentDir, { recursive: true });
    } catch (err) {
      _activeTempPaths.delete(tmpPath);
      if (isDiskFullError(err)) {
        throw Object.assign(new Error('Disk full — cannot create cache directory'), { code: 'ENOSPC', diskFull: true });
      }
      throw err;
    }
  }

  try {
    const { response, contentType } = await fetchWithRedirects(sourceUrl, 0, signal);

    let received = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_FILE_SIZE) {
          this.destroy(new Error('File too large'));
          return;
        }
        this.push(chunk);
        callback();
      },
    });

    const writeStream = fs.createWriteStream(tmpPath);

    const abortHandler = () => {
      writeStream.destroy();
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    try {
      await pipeline(response, counter, writeStream, { signal });
    } finally {
      signal.removeEventListener('abort', abortHandler);
      // pipeline destroys streams on error; ensure writeStream is closed
      try { writeStream.destroy(); } catch (_) {}
      // Drain response in case of early abort
      try { response.destroy(); } catch (_) {}
    }

    // pipeline resolved → file is fully written and closed
    const stat = fs.statSync(tmpPath);
    if (stat.size === 0) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      throw new Error('Downloaded file is empty');
    }

    fs.renameSync(tmpPath, destPath);
    _activeTempPaths.delete(tmpPath);
    return { contentType, size: stat.size };

  } catch (err) {
    _activeTempPaths.delete(tmpPath);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}

    if (err.name === 'AbortError') {
      throw Object.assign(new Error('Download aborted'), { aborted: true });
    }
    if (isDiskFullError(err)) {
      throw Object.assign(new Error('Disk full during download'), { code: err.code, diskFull: true });
    }
    throw err;
  }
}

function fetchWithRedirects(url, redirectCount, signal) {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError', aborted: true }));

    const req = transport.get(url, { signal }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectCount >= MAX_REDIRECTS) {
          return reject(new Error('Too many redirects'));
        }
        const nextUrl = new URL(res.headers.location, url).href;
        resolve(fetchWithRedirects(nextUrl, redirectCount + 1, signal));
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const contentType = (res.headers['content-type'] || '').toLowerCase();
      if (!contentType.startsWith('image/')) {
        res.resume();
        return reject(new Error(`Unexpected Content-Type: ${contentType}`));
      }

      const contentLength = parseInt(res.headers['content-length'], 10);
      if (contentLength === 0 || (!isNaN(contentLength) && contentLength > MAX_FILE_SIZE)) {
        res.resume();
        return reject(new Error(`Invalid content-length: ${contentLength}`));
      }

      resolve({ response: res, contentType });
    });

    // Inactivity timeout: if no bytes received in DOWNLOAD_TIMEOUT_MS, abort
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error('Download inactivity timeout'), { code: 'ETIMEDOUT' }));
    });

    req.on('error', (err) => {
      if (err.name === 'AbortError') {
        reject(Object.assign(new Error('Download aborted'), { name: 'AbortError', aborted: true }));
      } else {
        reject(err);
      }
    });
  });
}

// ── Enqueue / queue management ─────────────────────────────

function processQueue() {
  if (_shuttingDown || _disabled || _suspended || _queue.length === 0) return;

  while (_running < MAX_CONCURRENCY && _queue.length > 0) {
    const job = _queue.shift();
    _running++;
    _processJob(job);
  }
}

async function _processJob(job) {
  const { productId, type, sourceUrl, key, versionHint } = job;
  const pt = `${productId}:${type}`;
  _activeDownloads.set(key, job);

  let requeued = false;
  let reservationHeld = false;
  const expectedBytes = MAX_FILE_SIZE;
  const startTime = Date.now();

  // Create AbortController for this job
  const controller = new AbortController();
  _abortControllers.set(key, controller);

  try {
    const sk = computeSourceKey(sourceUrl, versionHint);
    if (!sk) throw new Error('Empty sourceKey');

    // Space check with reservation
    if (!canDownload(expectedBytes)) {
      reclaimDiskSpace(expectedBytes);
      if (!canDownload(expectedBytes)) {
        _queue.unshift(job);
        requeued = true;
        suspendQueue('disk-full');
        console.warn(`[IMAGE-CACHE] Disk full — #${productId} ${type} requeued, queue suspended`);
        return;
      }
    }

    _reservedDownloadBytes += expectedBytes;
    reservationHeld = true;

    // Total timeout for the entire job (60s)
    const JOB_TIMEOUT_MS = 60_000;
    const jobTimeout = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);
    if (jobTimeout.unref) jobTimeout.unref();

    try {
      const ext = '.jpg';
      const fileName = `${productId}_${type}_${sk}${ext}`;
      const destPath = path.join(getCacheDir(), fileName);

      const { contentType, size } = await downloadFile(sourceUrl, destPath, controller.signal);
      const actualExt = getExtension(contentType);

      let finalFileName = fileName;
      if (actualExt !== ext) {
        finalFileName = `${productId}_${type}_${sk}${actualExt}`;
        const newPath = path.join(getCacheDir(), finalFileName);
        if (destPath !== newPath) fs.renameSync(destPath, newPath);
      }

      // Race check: only publish if still the desired version
      if (_desiredKeys.get(pt) !== key) {
        try { const fp = path.join(getCacheDir(), finalFileName); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
        console.log(`[IMAGE-CACHE] Discarded stale download #${productId} ${type}`);
        return;
      }

      // Publish: add to manifest first, persist, THEN remove old versions
      _manifest[key] = {
        sourceKey: sk,
        normalizedSourceUrl: normalizeSourceUrl(sourceUrl),
        versionHint: versionHint || '',
        revisionCreatedAt: Date.now(),
        fileName: finalFileName,
        contentType,
        size,
        lastAccessedAt: null,
      };
      markManifestDirty();

      if (!saveManifest(true)) {
        try { const fp = path.join(getCacheDir(), finalFileName); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
        delete _manifest[key];
        throw Object.assign(new Error('Disk full — manifest save failed'), { code: 'ENOSPC', diskFull: true });
      }

      // Now safe to remove old versions via _removeEntry
      const prefix = `${productId}:${type}:`;
      const oldKeys = Object.keys(_manifest).filter(k => k.startsWith(prefix) && k !== key);
      for (const ok of oldKeys) _removeEntry(ok);

      console.log(`[IMAGE-CACHE] Downloaded #${productId} ${type} (${size} bytes, ${Date.now() - startTime}ms)`);
    } finally {
      clearTimeout(jobTimeout);
    }
  } catch (err) {
    if (err.diskFull) {
      reclaimDiskSpace(expectedBytes);
      if (_desiredKeys.get(pt) === key && !_shuttingDown) {
        job.diskRetryCount = (job.diskRetryCount || 0) + 1;
        _queue.unshift(job);
        requeued = true;
        if (!canDownload(expectedBytes) || job.diskRetryCount >= 2) {
          suspendQueue('disk-full');
        }
      }
      console.warn(`[IMAGE-CACHE] Disk full — #${productId} ${type} ${requeued ? 'requeued' : 'deferred'}`);
    } else if (err.aborted) {
      console.log(`[IMAGE-CACHE] Aborted #${productId} ${type}`);
    } else {
      console.error(`[IMAGE-CACHE] Failed ${type} for #${productId}: ${err.message}`);
    }
  } finally {
    // Release reservation exactly once
    if (reservationHeld) {
      _reservedDownloadBytes = Math.max(0, _reservedDownloadBytes - expectedBytes);
    }
    _abortControllers.delete(key);
    _activeDownloads.delete(key);
    if (!requeued) _pendingKeys.delete(key);
    _running--;

    // Flush manifest when queue is idle
    if (_running === 0 && _queue.length === 0 && _manifestDirty) {
      doManifestFlush();
    }
    processQueue();
  }
}

function enqueue(productId, type, sourceUrl, versionHint = '', { setDesired = true, force = false } = {}) {
  if (!_initialized || _disabled || _shuttingDown) return;
  if (!sourceUrl) return;

  const key = cacheKey(productId, type, sourceUrl, versionHint);
  if (!key || _pendingKeys.has(key) || _activeDownloads.has(key)) return;

  const pt = `${productId}:${type}`;
  if (setDesired) _desiredKeys.set(pt, key);

  const cachedEntry = _manifest[key];
  if (!force && cachedEntry && entryFileExists(cachedEntry)) return;

  _pendingKeys.add(key);
  _queue.push({ productId, type, sourceUrl, key, versionHint });
  processQueue();
}

function enqueueProduct(product) {
  if (!product || !product.id) return;
  if (product.imageUrl) enqueue(product.id, 'image', product.imageUrl);
  if (product.thumbnailUrl) enqueue(product.id, 'thumbnail', product.thumbnailUrl);
}

function invalidateAndEnqueueProduct(product) {
  if (!_initialized || _disabled || _shuttingDown) return;
  if (!product || !product.id) return;

  const versionHint = product.imageVersion || product.imageUpdatedAt || Date.now().toString(36);

  if (product.imageUrl) {
    enqueue(product.id, 'image', product.imageUrl, versionHint, { setDesired: true, force: true });
  }
  if (product.thumbnailUrl) {
    enqueue(product.id, 'thumbnail', product.thumbnailUrl, versionHint, { setDesired: true, force: true });
  }
}

// ── Reconcile (sync / login) ───────────────────────────────

function reconcileProducts(products) {
  if (!_initialized || _disabled || _shuttingDown) return;
  if (!Array.isArray(products)) return;

  const activeCacheKeys = new Set();
  const nextDesiredPt = new Set();

  for (const p of products) {
    if (!p || !p.id) continue;
    _reconcileOneType(p, 'image', p.imageUrl || p.ImageUrl || p.image_url, activeCacheKeys, nextDesiredPt);
    _reconcileOneType(p, 'thumbnail', p.thumbnailUrl || p.ThumbnailUrl || p.thumbnail_url, activeCacheKeys, nextDesiredPt);
  }

  // Podar _desiredKeys para productos que ya no estan en el catalogo
  for (const pt of [..._desiredKeys.keys()]) {
    if (!nextDesiredPt.has(pt)) {
      _cancelProductType(pt);
      _desiredKeys.delete(pt);
    }
  }

  setImmediate(() => clearOrphans(activeCacheKeys));
  tryResume();
}

function _reconcileOneType(product, type, sourceUrl, activeCacheKeys, nextDesiredPt) {
  if (!sourceUrl) return;
  const normalized = normalizeSourceUrl(sourceUrl);
  const pt = `${product.id}:${type}`;
  nextDesiredPt.add(pt);

  // If a valid entry already exists with matching normalizedSourceUrl, reuse its key
  const existing = findEntryByNormalizedUrlValid(product.id, type, normalized);
  if (existing) {
    activeCacheKeys.add(existing.key);
    _desiredKeys.set(pt, existing.key);
    return;
  }

  // Compute fresh key without versionHint
  const key = cacheKey(product.id, type, sourceUrl);
  activeCacheKeys.add(key);
  _desiredKeys.set(pt, key);

  // Only enqueue if not already cached (setDesired=false: already set above)
  const cachedEntry = _manifest[key];
  if (!cachedEntry || !entryFileExists(cachedEntry)) {
    enqueue(product.id, type, sourceUrl, '', { setDesired: false, force: false });
  }
}

// ── Serve cached file ──────────────────────────────────────

function buildLocalUrl(productId, type, sourceKey) {
  return `/api/local-product-images/${productId}/${type}?v=${sourceKey}`;
}

function serveRequest(req, res, productId, type) {
  if (!_initialized || _disabled) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Cache not ready');
    return;
  }

  // Parse ?v=sourceKey
  let requestedSk = '';
  try {
    const qIdx = req.url.indexOf('?');
    if (qIdx !== -1) {
      const params = new URLSearchParams(req.url.slice(qIdx));
      requestedSk = params.get('v') || '';
    }
  } catch (_) {}

  // Exact lookup
  let entry = null;
  let entryKey = null;
  if (requestedSk) {
    entryKey = `${productId}:${type}:${requestedSk}`;
    entry = _manifest[entryKey];
  }

  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const filePath = path.join(getCacheDir(), entry.fileName);
  if (!fs.existsSync(filePath)) {
    delete _manifest[entryKey];
    markManifestDirty();
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  touchEntry(entryKey);

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
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('[IMAGE-CACHE] Read error:', err.message);
      if (!res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

function getLocalUrl(productId, type, sourceUrl) {
  if (!_initialized || _disabled || !sourceUrl) return null;

  // Try exact match
  const sk = computeSourceKey(sourceUrl);
  const exactKey = `${productId}:${type}:${sk}`;
  const exact = _manifest[exactKey];
  if (exact && entryFileExists(exact)) {
    return buildLocalUrl(productId, type, sk);
  }

  // Fallback: any valid entry for this product:type
  const fallback = findLatestValidEntry(productId, type);
  if (fallback) {
    return buildLocalUrl(productId, type, fallback.sourceKey);
  }

  return null;
}

// ── Cleanup ────────────────────────────────────────────────

function removeProduct(productId) {
  if (!_initialized || _disabled || !productId) return;

  // Abort active downloads for this product
  for (const [key, controller] of _abortControllers) {
    if (key.startsWith(`${productId}:`)) {
      controller.abort();
    }
  }

  // Cancel pending queue jobs for this product
  _queue = _queue.filter(job => {
    if (job.productId === productId) {
      _pendingKeys.delete(job.key);
      return false;
    }
    return true;
  });

  // Clean desiredKeys
  for (const pt of _desiredKeys.keys()) {
    if (pt.startsWith(`${productId}:`)) _desiredKeys.delete(pt);
  }

  // Delete files + manifest entries
  const prefixes = [`${productId}:image:`, `${productId}:thumbnail:`];
  const keysToDelete = Object.keys(_manifest).filter(k =>
    prefixes.some(p => k.startsWith(p))
  );
  for (const key of keysToDelete) {
    _removeEntry(key);
  }

  if (keysToDelete.length > 0) doManifestFlush();
}

function clearOrphans(activeCacheKeys) {
  if (!_initialized || _disabled) return;
  if (!(activeCacheKeys instanceof Set)) return;

  const pendingPt = _derivePendingProductTypes();

  const keysToDelete = [];
  for (const key of Object.keys(_manifest)) {
    if (activeCacheKeys.has(key)) continue;
    if (_activeDownloads.has(key) || _pendingKeys.has(key)) continue;
    // Don't delete if a newer version is pending for this product:type
    const parts = key.split(':');
    if (pendingPt.has(`${parts[0]}:${parts[1]}`)) continue;

    keysToDelete.push(key);
  }

  for (const key of keysToDelete) {
    _removeEntry(key);
  }

  if (keysToDelete.length > 0) {
    console.log(`[IMAGE-CACHE] Cleaned ${keysToDelete.length} orphaned images`);
  }

  // Clean stale .tmp files (not active, older than 1h)
  try {
    const dir = getCacheDir();
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir);
    const now = Date.now();
    for (const file of entries) {
      if (!file.endsWith('.tmp')) continue;
      const fp = path.join(dir, file);
      if (_activeTempPaths.has(fp)) continue;
      try {
        const st = fs.statSync(fp);
        if (now - st.mtimeMs < STALE_TMP_AGE_MS) continue;
        fs.unlinkSync(fp);
      } catch (_) {}
    }
  } catch (_) {}
}

// ── Stats ──────────────────────────────────────────────────

function getStats() {
  if (!_initialized) return null;
  if (_disabled) return { disabled: true };

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
    disabled: false,
    fileCount,
    imageCount,
    thumbnailCount,
    totalBytes: totalSize,
    totalMB: (totalSize / (1024 * 1024)).toFixed(1),
    cacheLimitBytes: MAX_CACHE_BYTES,
    cacheLimitMB: (MAX_CACHE_BYTES / (1024 * 1024)).toFixed(0),
    freeDiskBytes: freeBytes,
    freeDiskGB: freeBytes === Infinity ? 'N/A' : (freeBytes / (1024 * 1024 * 1024)).toFixed(1),
    reservedBytes: _reservedDownloadBytes,
    pendingJobs: _queue.length,
    activeDownloads: _activeDownloads.size,
    suspended: _suspended,
  };
}

// ── Shutdown ───────────────────────────────────────────────

async function shutdown() {
  _shuttingDown = true;

  // Stop all timers
  _stopResumeTimer();
  if (_accessFlushTimer) { clearTimeout(_accessFlushTimer); _accessFlushTimer = null; }
  if (_manifestFlushTimer) { clearTimeout(_manifestFlushTimer); _manifestFlushTimer = null; }

  // Abort all active downloads
  for (const [key, controller] of _abortControllers) {
    controller.abort();
  }

  _queue = [];
  _pendingKeys.clear();
  _suspended = false;

  // Wait for active downloads to drain (with timeout)
  const drainStart = Date.now();
  while (_running > 0 && Date.now() - drainStart < SHUTDOWN_DRAIN_MS) {
    await new Promise(r => setTimeout(r, 100));
  }

  // Cancel any manifest flush timer that may have been scheduled during drain
  if (_manifestFlushTimer) { clearTimeout(_manifestFlushTimer); _manifestFlushTimer = null; }

  if (_running > 0) {
    console.warn(`[IMAGE-CACHE] Shutdown timeout: ${_running} downloads still active`);
    saveManifest(true);
    return;
  }

  _activeTempPaths.clear();
  _abortControllers.clear();
  _desiredKeys.clear();
  _reservedDownloadBytes = 0;

  saveManifest(true);
  _initialized = false;
  _disabled = false;
  _cacheDir = null;
  _manifest = null;
  _manifestDirty = false;
  _lastAccessDirty = 0;
  console.log('[IMAGE-CACHE] Shut down');
}

function doManifestFlush() {
  if (_manifestFlushTimer) { clearTimeout(_manifestFlushTimer); _manifestFlushTimer = null; }
  _doManifestFlush();
}

// ── Exports ────────────────────────────────────────────────

module.exports = {
  initialize,
  shutdown,
  getStats,
  // Queue management
  enqueueProduct,
  invalidateAndEnqueueProduct,
  reconcileProducts,
  tryResume,
  // Serving + URLs
  serveRequest,
  getLocalUrl,
  // Cleanup
  removeProduct,
  clearOrphans,
  doManifestFlush,
  // Internal (for testing / diagnostics)
  _getQueueSize: () => _queue.length,
  _getActiveCount: () => _activeDownloads.size,
  _isSuspended: () => _suspended,
  _isDisabled: () => _disabled,
};
