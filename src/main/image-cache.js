// ============================================================
// Nuventa POS — offline product image cache
// ============================================================
'use strict';

const path = require('path');
const nodeFs = require('fs');
const crypto = require('crypto');
const nodeHttp = require('http');
const nodeHttps = require('https');
const { pipeline: nodePipeline } = require('stream/promises');
const { Transform } = require('stream');

let electronApp = null;
try {
  const electron = require('electron');
  electronApp = electron && electron.app ? electron.app : null;
} catch (_) { /* Tests inject getUserDataPath. */ }

const DEFAULTS = Object.freeze({
  cacheDirName: path.join('cache', 'product-images'),
  manifestFile: 'manifest.json',
  maxConcurrency: 3,
  inactivityTimeoutMs: 20_000,
  jobTimeoutMs: 60_000,
  maxRedirects: 3,
  maxFileSize: 10 * 1024 * 1024,
  maxCacheBytes: 1024 * 1024 * 1024,
  minFreeDiskBytes: 1024 * 1024 * 1024,
  manifestFlushMs: 2_000,
  resumeCheckMs: 300_000,
  staleTempAgeMs: 3_600_000,
  shutdownDrainMs: 3_000,
  accessFlushMs: 30_000,
  accessFlushCount: 50,
  manifestRetryDelaysMs: [50, 200, 500],
  networkRetryDelaysMs: [5_000, 30_000, 120_000, 600_000],
  retryJitter: 0.20,
  allowHttp: process.argv.includes('--dev'),
});

const TEMP_QUERY_PARAMS = new Set([
  'Expires', 'Signature', 'Key-Pair-Id', 'Policy',
  'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-Signature',
  'X-Amz-Credential', 'X-Amz-SignedHeaders',
]);

const GENERATED_FILE_RE = /^(\d+)_(image|thumbnail)_([0-9a-f]{12})\.(jpg|jpeg|png|webp|gif|bmp|avif)$/i;
const CACHE_KEY_RE = /^(\d+):(image|thumbnail):([0-9a-f]{12})$/;
const SAFE_RASTER_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif',
]);

function normalizeMediaType(contentType = '') {
  return String(contentType).split(';')[0].trim().toLowerCase();
}

function extensionContentType(extension) {
  const ext = String(extension).toLowerCase();
  return {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif',
  }[ext] || null;
}

function createImageCache(dependencies = {}, optionOverrides = {}) {
  const fs = dependencies.fs || nodeFs;
  const http = dependencies.http || nodeHttp;
  const https = dependencies.https || nodeHttps;
  const pipeline = dependencies.pipeline || nodePipeline;
  const now = dependencies.now || (() => Date.now());
  const random = dependencies.random || Math.random;
  const setTimer = dependencies.setTimeout || setTimeout;
  const clearTimer = dependencies.clearTimeout || clearTimeout;
  const setRepeatingTimer = dependencies.setInterval || setInterval;
  const clearRepeatingTimer = dependencies.clearInterval || clearInterval;
  const defer = dependencies.setImmediate || setImmediate;
  const logger = dependencies.logger || console;
  const getUserDataPath = dependencies.getUserDataPath || (() => {
    if (!electronApp || typeof electronApp.getPath !== 'function') {
      throw new Error('Electron app is not ready and getUserDataPath was not provided');
    }
    return electronApp.getPath('userData');
  });
  const options = { ...DEFAULTS, ...optionOverrides };

  let cacheDir = null;
  let manifest = Object.create(null);
  let initialized = false;
  let disabled = false;
  let shuttingDown = false;
  let suspended = false;
  let suspensionReason = null;
  let queue = [];
  const jobs = new Map();
  const activeDownloads = new Map();
  const abortControllers = new Map();
  const activeTempPaths = new Set();
  const desiredKeys = new Map();
  const failedJobs = new Map();
  let running = 0;
  let reservedDownloadBytes = 0;
  let retryWakeTimer = null;
  let retryWakeAt = null;
  let resumeTimer = null;
  let manifestFlushTimer = null;
  let manifestFlushPromise = null;
  let manifestGeneration = 0;
  let persistedGeneration = 0;
  let lastAccessDirty = 0;
  let accessFlushTimer = null;
  let recoveredFiles = 0;
  let lastError = null;
  let latestActiveCacheKeys = new Set();
  let orphanCleanupScheduled = false;

  const log = (level, message) => {
    const fn = logger && typeof logger[level] === 'function' ? logger[level] : null;
    if (fn) fn.call(logger, message);
  };

  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimer(resolve, ms);
    if (timer && timer.unref) timer.unref();
  });

  function getCacheDir() {
    if (!cacheDir) cacheDir = path.join(getUserDataPath(), options.cacheDirName);
    return cacheDir;
  }

  function getManifestPath() {
    return path.join(getCacheDir(), options.manifestFile);
  }

  function normalizeSourceUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      for (const key of [...parsed.searchParams.keys()]) {
        if (TEMP_QUERY_PARAMS.has(key)) parsed.searchParams.delete(key);
      }
      const query = parsed.searchParams.toString();
      return parsed.origin + parsed.pathname + (query ? `?${query}` : '');
    } catch (_) {
      return String(url);
    }
  }

  function computeSourceKey(sourceUrl) {
    const normalized = normalizeSourceUrl(sourceUrl);
    if (!normalized) return '';
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  }

  function cacheKey(productId, type, sourceUrl) {
    const sourceKey = computeSourceKey(sourceUrl);
    return sourceKey ? `${productId}:${type}:${sourceKey}` : '';
  }

  function productType(productId, type) {
    return `${productId}:${type}`;
  }

  function isDiskFullError(error) {
    return !!error && (error.code === 'ENOSPC' || error.code === 'EDQUOT');
  }

  function isManifestRetryable(error) {
    return !!error && ['EBUSY', 'EPERM', 'EACCES'].includes(error.code);
  }

  function isTransientNetworkError(error, job) {
    if (!error) return false;
    if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(error.code)) {
      return true;
    }
    if ([408, 425, 429].includes(error.httpStatus) || error.httpStatus >= 500) return true;
    return error.httpStatus === 404 && job.reason === 'upload';
  }

  function setLastError(scope, error) {
    lastError = {
      scope,
      code: error && (error.code || error.httpStatus) ? String(error.code || error.httpStatus) : null,
      message: error && error.message ? error.message : String(error),
      at: new Date(now()).toISOString(),
    };
  }

  function scheduleManifestFlush(delay = options.manifestFlushMs) {
    if (shuttingDown || disabled) return;
    if (manifestFlushTimer) clearTimer(manifestFlushTimer);
    manifestFlushTimer = setTimer(() => {
      manifestFlushTimer = null;
      void flushManifest().catch((error) => {
        setLastError('manifest', error);
        log('error', `[IMAGE-CACHE] Manifest flush failed: ${error.message}`);
      });
    }, delay);
    if (manifestFlushTimer && manifestFlushTimer.unref) manifestFlushTimer.unref();
  }

  function markManifestDirty({ schedule = true } = {}) {
    manifestGeneration++;
    if (schedule) scheduleManifestFlush();
  }

  async function writeManifestSnapshot(snapshot) {
    const dir = getCacheDir();
    const destination = getManifestPath();
    const tempPath = `${destination}.tmp`;
    let lastFailure = null;
    const retryDelays = [0, ...options.manifestRetryDelaysMs];

    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      if (retryDelays[attempt] > 0) await sleep(retryDelays[attempt]);
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        await fs.promises.writeFile(tempPath, snapshot, 'utf8');
        await fs.promises.rename(tempPath, destination);
        return;
      } catch (error) {
        lastFailure = error;
        try { await fs.promises.unlink(tempPath); } catch (_) {}
        if (!isManifestRetryable(error) || attempt === retryDelays.length - 1) break;
      }
    }
    throw lastFailure || new Error('Unknown manifest persistence error');
  }

  async function flushManifest({ force = false } = {}) {
    if (!initialized || disabled) return false;
    if (!force && manifestGeneration === persistedGeneration) return true;
    if (manifestFlushTimer) {
      clearTimer(manifestFlushTimer);
      manifestFlushTimer = null;
    }
    if (manifestFlushPromise) {
      await manifestFlushPromise;
      if (!force && manifestGeneration === persistedGeneration) return true;
    }

    manifestFlushPromise = (async () => {
      while (persistedGeneration !== manifestGeneration) {
        const generation = manifestGeneration;
        const snapshot = JSON.stringify(manifest, null, 2);
        await writeManifestSnapshot(snapshot);
        persistedGeneration = generation;
      }
      return true;
    })();

    try {
      return await manifestFlushPromise;
    } finally {
      manifestFlushPromise = null;
    }
  }

  function readMagic(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(16);
      const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, length);
    } finally {
      fs.closeSync(fd);
    }
  }

  function hasValidRasterSignature(filePath, contentType) {
    let bytes;
    try { bytes = readMagic(filePath); } catch (_) { return false; }
    if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (contentType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (contentType === 'image/gif') return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
    if (contentType === 'image/webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (contentType === 'image/bmp') return bytes.length >= 2 && bytes.subarray(0, 2).toString('ascii') === 'BM';
    if (contentType === 'image/avif') return bytes.length >= 12 && bytes.subarray(4, 12).toString('ascii').startsWith('ftypavi');
    return false;
  }

  function safeGeneratedPath(fileName) {
    if (!fileName || path.basename(fileName) !== fileName || !GENERATED_FILE_RE.test(fileName)) return null;
    const base = path.resolve(getCacheDir());
    const resolved = path.resolve(base, fileName);
    return resolved.startsWith(base + path.sep) ? resolved : null;
  }

  function validateManifestEntry(key, entry) {
    const keyMatch = CACHE_KEY_RE.exec(key);
    if (!keyMatch || !entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const filePath = safeGeneratedPath(entry.fileName);
    if (!filePath) return null;
    const fileMatch = GENERATED_FILE_RE.exec(entry.fileName);
    if (!fileMatch || fileMatch[1] !== keyMatch[1] || fileMatch[2].toLowerCase() !== keyMatch[2] || fileMatch[3] !== keyMatch[3]) return null;

    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > options.maxFileSize) return null;
      const contentType = normalizeMediaType(entry.contentType) || extensionContentType(fileMatch[4]);
      if (!SAFE_RASTER_TYPES.has(contentType) || !hasValidRasterSignature(filePath, contentType)) return null;
      return {
        sourceKey: keyMatch[3],
        normalizedSourceUrl: typeof entry.normalizedSourceUrl === 'string' ? entry.normalizedSourceUrl : null,
        revisionCreatedAt: Number.isFinite(Number(entry.revisionCreatedAt)) ? Number(entry.revisionCreatedAt) : stat.mtimeMs,
        fileName: entry.fileName,
        contentType,
        size: stat.size,
        lastAccessedAt: typeof entry.lastAccessedAt === 'string' ? entry.lastAccessedAt : null,
        recovered: !!entry.recovered,
      };
    } catch (_) {
      return null;
    }
  }

  function recoverGeneratedFile(fileName) {
    const match = GENERATED_FILE_RE.exec(fileName);
    if (!match) return null;
    const filePath = safeGeneratedPath(fileName);
    if (!filePath) return null;
    try {
      const stat = fs.lstatSync(filePath);
      const contentType = extensionContentType(match[4]);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > options.maxFileSize) return null;
      if (!contentType || !hasValidRasterSignature(filePath, contentType)) return null;
      return {
        key: `${match[1]}:${match[2].toLowerCase()}:${match[3]}`,
        entry: {
          sourceKey: match[3], normalizedSourceUrl: null, revisionCreatedAt: stat.mtimeMs,
          fileName, contentType, size: stat.size, lastAccessedAt: null, recovered: true,
        },
      };
    } catch (_) {
      return null;
    }
  }

  function loadAndRecoverManifest() {
    const manifestPath = getManifestPath();
    let rawManifest = Object.create(null);
    let changed = false;
    if (fs.existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rawManifest = parsed;
        else changed = true;
      } catch (error) {
        changed = true;
        setLastError('manifest-load', error);
        log('error', `[IMAGE-CACHE] Invalid manifest, recovering files: ${error.message}`);
      }
    }

    const validated = Object.create(null);
    const referencedFiles = new Set();
    for (const [key, entry] of Object.entries(rawManifest)) {
      const valid = validateManifestEntry(key, entry);
      if (!valid) { changed = true; continue; }
      validated[key] = valid;
      referencedFiles.add(valid.fileName);
      if (valid.size !== entry.size || normalizeMediaType(entry.contentType) !== valid.contentType) changed = true;
    }

    const directory = getCacheDir();
    const timestamp = now();
    for (const fileName of fs.readdirSync(directory)) {
      if (fileName === options.manifestFile) continue;
      const filePath = path.join(directory, fileName);
      if (fileName.endsWith('.tmp')) {
        try {
          const stat = fs.statSync(filePath);
          if (timestamp - stat.mtimeMs >= options.staleTempAgeMs) fs.unlinkSync(filePath);
        } catch (_) {}
        continue;
      }
      if (referencedFiles.has(fileName) || !GENERATED_FILE_RE.test(fileName)) continue;
      const recovered = recoverGeneratedFile(fileName);
      if (recovered && !validated[recovered.key]) {
        validated[recovered.key] = recovered.entry;
        recoveredFiles++;
        changed = true;
      } else if (!recovered) {
        try { fs.unlinkSync(filePath); changed = true; } catch (_) {}
      }
    }

    manifest = validated;
    manifestGeneration = changed ? 1 : 0;
    persistedGeneration = 0;
  }

  function initialize() {
    if (initialized) return;
    shuttingDown = false;
    disabled = false;
    try {
      const directory = getCacheDir();
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
      loadAndRecoverManifest();
      initialized = true;
      if (manifestGeneration !== persistedGeneration) scheduleManifestFlush(0);
      log('log', `[IMAGE-CACHE] Initialized in ${directory} (${Object.keys(manifest).length} entries, ${recoveredFiles} recovered)`);
    } catch (error) {
      manifest = Object.create(null);
      initialized = true;
      disabled = true;
      setLastError('initialize', error);
      log('error', `[IMAGE-CACHE] Cache disabled — init failed: ${error.message}`);
    }
  }

  function entryFileExists(entry) {
    const filePath = entry ? safeGeneratedPath(entry.fileName) : null;
    if (!filePath) return false;
    try {
      const stat = fs.lstatSync(filePath);
      return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
    } catch (_) { return false; }
  }

  function removeEntry(key) {
    const entry = manifest[key];
    if (!entry) return false;
    const filePath = safeGeneratedPath(entry.fileName);
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); }
      catch (error) {
        log('warn', `[IMAGE-CACHE] Could not delete ${entry.fileName}: ${error.message}`);
        return false;
      }
    }
    delete manifest[key];
    markManifestDirty();
    return true;
  }

  function findEntryByNormalizedUrl(productId, type, normalizedUrl) {
    if (!normalizedUrl) return null;
    const prefix = `${productId}:${type}:`;
    const candidates = [];
    for (const [key, entry] of Object.entries(manifest)) {
      if (key.startsWith(prefix) && entry.normalizedSourceUrl === normalizedUrl) candidates.push({ key, ...entry });
    }
    candidates.sort((a, b) => b.revisionCreatedAt - a.revisionCreatedAt);
    for (const candidate of candidates) {
      if (entryFileExists(candidate)) return candidate;
      delete manifest[candidate.key];
      markManifestDirty();
    }
    return null;
  }

  function findExactEntry(productId, type, sourceUrl) {
    const key = cacheKey(productId, type, sourceUrl);
    const entry = manifest[key];
    if (entry && entryFileExists(entry)) return { key, ...entry };
    if (entry) { delete manifest[key]; markManifestDirty(); }
    return findEntryByNormalizedUrl(productId, type, normalizeSourceUrl(sourceUrl));
  }

  function calculateCacheSize() {
    return Object.values(manifest).reduce((total, entry) => total + (entry.size || 0), 0);
  }

  function getFreeDiskBytes() {
    try {
      const stat = fs.statfsSync(getCacheDir());
      return stat.bavail * stat.bsize;
    } catch (_) { return Infinity; }
  }

  function hasRequiredSpace(requiredBytes) {
    if (calculateCacheSize() + reservedDownloadBytes + requiredBytes > options.maxCacheBytes) return false;
    const freeBytes = getFreeDiskBytes();
    return freeBytes >= options.minFreeDiskBytes + reservedDownloadBytes + requiredBytes;
  }

  function protectedProductTypes() {
    const result = new Set();
    for (const job of jobs.values()) {
      if (!job.cancelled) result.add(job.pt);
    }
    return result;
  }

  function reclaimDiskSpace(requiredBytes) {
    if (!initialized || disabled) return 0;
    let freed = 0;
    const protectedTypes = protectedProductTypes();

    for (const [key, entry] of Object.entries(manifest)) {
      if (!entryFileExists(entry)) {
        freed += entry.size || 0;
        delete manifest[key];
        markManifestDirty();
      }
    }

    const newest = new Map();
    for (const [key, entry] of Object.entries(manifest)) {
      const match = CACHE_KEY_RE.exec(key);
      if (!match) continue;
      const pt = `${match[1]}:${match[2]}`;
      const previous = newest.get(pt);
      if (!previous || entry.revisionCreatedAt > previous.entry.revisionCreatedAt) newest.set(pt, { key, entry });
    }
    for (const [key, entry] of Object.entries(manifest)) {
      const match = CACHE_KEY_RE.exec(key);
      if (!match) continue;
      const pt = `${match[1]}:${match[2]}`;
      if (protectedTypes.has(pt)) continue;
      if (newest.get(pt) && newest.get(pt).key !== key && removeEntry(key)) freed += entry.size || 0;
    }

    for (const type of ['image', 'thumbnail']) {
      const failedDeletes = new Set();
      while (!hasRequiredSpace(requiredBytes)) {
        const candidates = Object.entries(manifest)
          .filter(([key]) => key.includes(`:${type}:`) && !failedDeletes.has(key))
          .filter(([key]) => {
            const match = CACHE_KEY_RE.exec(key);
            return match && !protectedTypes.has(`${match[1]}:${match[2]}`);
          })
          .map(([key, entry]) => ({ key, entry }))
          .sort((a, b) => String(a.entry.lastAccessedAt || '').localeCompare(String(b.entry.lastAccessedAt || '')));
        if (candidates.length === 0) break;
        const candidate = candidates[0];
        if (removeEntry(candidate.key)) freed += candidate.entry.size || 0;
        else failedDeletes.add(candidate.key);
      }
    }
    if (freed > 0) log('log', `[IMAGE-CACHE] Reclaimed ${freed} bytes`);
    return freed;
  }

  function startResumeTimer() {
    if (resumeTimer) return;
    resumeTimer = setRepeatingTimer(() => {
      if (shuttingDown) return stopResumeTimer();
      tryResume();
    }, options.resumeCheckMs);
    if (resumeTimer && resumeTimer.unref) resumeTimer.unref();
  }

  function stopResumeTimer() {
    if (resumeTimer) clearRepeatingTimer(resumeTimer);
    resumeTimer = null;
  }

  function suspendQueue(reason) {
    suspended = true;
    suspensionReason = reason;
    startResumeTimer();
    log('warn', `[IMAGE-CACHE] Queue suspended: ${reason}`);
  }

  function tryResume() {
    if (!suspended || shuttingDown) return;
    reclaimDiskSpace(options.maxFileSize);
    if (hasRequiredSpace(options.maxFileSize)) {
      suspended = false;
      suspensionReason = null;
      stopResumeTimer();
      processQueue();
    }
  }

  function validateDownloadUrl(value, previousUrl = null) {
    let parsed;
    try { parsed = new URL(value); }
    catch (_) { throw Object.assign(new Error('Invalid image URL'), { code: 'ERR_INVALID_URL' }); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('Unsupported image URL protocol'), { code: 'ERR_INVALID_PROTOCOL' });
    if (parsed.protocol === 'http:' && !options.allowHttp) throw Object.assign(new Error('Insecure image URL is not allowed'), { code: 'ERR_INSECURE_URL' });
    if (previousUrl && new URL(previousUrl).protocol === 'https:' && parsed.protocol !== 'https:') {
      throw Object.assign(new Error('HTTPS redirect downgrade is not allowed'), { code: 'ERR_REDIRECT_DOWNGRADE' });
    }
    return parsed;
  }

  function fetchWithRedirects(url, redirectCount, signal, previousUrl = null) {
    const parsed = validateDownloadUrl(url, previousUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(Object.assign(new Error('Download aborted'), { aborted: true }));
      const request = transport.get(parsed.href, { signal }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirectCount >= options.maxRedirects) return reject(Object.assign(new Error('Too many redirects'), { code: 'ERR_TOO_MANY_REDIRECTS' }));
          const nextUrl = new URL(response.headers.location, parsed).href;
          Promise.resolve(fetchWithRedirects(nextUrl, redirectCount + 1, signal, parsed.href)).then(resolve, reject);
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          return reject(Object.assign(new Error(`HTTP ${response.statusCode}`), { httpStatus: response.statusCode }));
        }
        const contentType = normalizeMediaType(response.headers['content-type']);
        if (contentType !== 'image/jpeg') {
          response.resume();
          return reject(Object.assign(new Error(`Unexpected Content-Type: ${contentType}`), { code: 'ERR_CONTENT_TYPE' }));
        }
        const contentLength = Number.parseInt(response.headers['content-length'], 10);
        if (contentLength === 0 || (Number.isFinite(contentLength) && contentLength > options.maxFileSize)) {
          response.resume();
          return reject(Object.assign(new Error(`Invalid content-length: ${contentLength}`), { code: 'ERR_FILE_SIZE' }));
        }
        resolve({ response, contentType });
      });
      request.setTimeout(options.inactivityTimeoutMs, () => request.destroy(Object.assign(new Error('Download inactivity timeout'), { code: 'ETIMEDOUT' })));
      request.on('error', (error) => {
        if (error.name === 'AbortError' || signal.aborted) reject(Object.assign(new Error('Download aborted'), { aborted: true }));
        else reject(error);
      });
    });
  }

  async function downloadFile(sourceUrl, destination, signal) {
    const tempPath = `${destination}.tmp`;
    activeTempPaths.add(tempPath);
    try {
      const { response, contentType } = await fetchWithRedirects(sourceUrl, 0, signal);
      let received = 0;
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > options.maxFileSize) return callback(Object.assign(new Error('File too large'), { code: 'ERR_FILE_SIZE' }));
          callback(null, chunk);
        },
      });
      const writeStream = fs.createWriteStream(tempPath);
      try { await pipeline(response, counter, writeStream, { signal }); }
      finally { try { response.destroy(); } catch (_) {} }
      const stat = fs.statSync(tempPath);
      if (stat.size <= 0) throw Object.assign(new Error('Downloaded file is empty'), { code: 'ERR_FILE_SIZE' });
      if (!hasValidRasterSignature(tempPath, 'image/jpeg')) throw Object.assign(new Error('Downloaded JPEG has an invalid signature'), { code: 'ERR_IMAGE_SIGNATURE' });
      fs.renameSync(tempPath, destination);
      return { contentType, size: stat.size };
    } catch (error) {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
      if (error.name === 'AbortError') throw Object.assign(new Error('Download aborted'), { aborted: true });
      throw error;
    } finally {
      activeTempPaths.delete(tempPath);
    }
  }

  function removeQueuedJob(job) {
    queue = queue.filter((candidate) => candidate !== job);
    if (job.status === 'active') {
      job.cancelled = true;
      const controller = abortControllers.get(job.key);
      if (controller) controller.abort();
    } else {
      jobs.delete(job.key);
      job.cancelled = true;
    }
    armRetryWake();
  }

  function cancelProductType(pt) {
    for (const job of [...jobs.values()]) if (job.pt === pt) removeQueuedJob(job);
  }

  function armRetryWake() {
    const delayed = [...jobs.values()].filter((job) => !job.cancelled && job.status === 'delayed');
    const nextAt = delayed.length ? Math.min(...delayed.map((job) => job.nextAttemptAt)) : null;
    if (retryWakeTimer && retryWakeAt === nextAt) return;
    if (retryWakeTimer) clearTimer(retryWakeTimer);
    retryWakeTimer = null;
    retryWakeAt = nextAt;
    if (nextAt === null || shuttingDown) return;
    retryWakeTimer = setTimer(() => {
      retryWakeTimer = null;
      retryWakeAt = null;
      const timestamp = now();
      for (const job of jobs.values()) {
        if (!job.cancelled && job.status === 'delayed' && job.nextAttemptAt <= timestamp) {
          job.status = 'queued';
          queue.push(job);
        }
      }
      armRetryWake();
      processQueue();
    }, Math.max(0, nextAt - now()));
    if (retryWakeTimer && retryWakeTimer.unref) retryWakeTimer.unref();
  }

  function delayedRetry(job) {
    if (job.networkRetryCount >= options.networkRetryDelaysMs.length) return false;
    const base = options.networkRetryDelaysMs[job.networkRetryCount++];
    const jitter = 1 + ((random() * 2) - 1) * options.retryJitter;
    job.status = 'delayed';
    job.nextAttemptAt = now() + Math.max(0, Math.round(base * jitter));
    armRetryWake();
    return true;
  }

  function enqueue(productId, type, sourceUrl, { reason = 'catalog', priority = false } = {}) {
    if (!initialized || disabled || shuttingDown || !productId || !['image', 'thumbnail'].includes(type) || !sourceUrl) return null;
    const key = cacheKey(productId, type, sourceUrl);
    if (!key) return null;
    const pt = productType(productId, type);
    const previousDesired = desiredKeys.get(pt);
    if (previousDesired && previousDesired !== key) cancelProductType(pt);
    desiredKeys.set(pt, key);

    const existing = findExactEntry(productId, type, sourceUrl);
    if (existing) return existing.key;
    const currentJob = jobs.get(key);
    if (currentJob) {
      if (currentJob.cancelled) {
        currentJob.requeueAfterCancel = { productId, type, sourceUrl, reason, priority };
        return key;
      }
      if (reason === 'upload') currentJob.reason = 'upload';
      return key;
    }
    failedJobs.delete(key);
    const job = {
      productId, type, sourceUrl, normalizedSourceUrl: normalizeSourceUrl(sourceUrl), key, pt,
      reason, status: 'queued', networkRetryCount: 0, diskRetryCount: 0,
      nextAttemptAt: null, cancelled: false, priority,
    };
    jobs.set(key, job);
    if (priority) queue.unshift(job); else queue.push(job);
    processQueue();
    return key;
  }

  async function executeJob(job, controller) {
    const sourceKey = computeSourceKey(job.sourceUrl);
    const fileName = `${job.productId}_${job.type}_${sourceKey}.jpg`;
    const destination = path.join(getCacheDir(), fileName);
    const startedAt = now();
    const { contentType, size } = await downloadFile(job.sourceUrl, destination, controller.signal);
    if (job.cancelled || desiredKeys.get(job.pt) !== job.key || shuttingDown) {
      try { if (fs.existsSync(destination)) fs.unlinkSync(destination); } catch (_) {}
      return;
    }

    const previous = manifest[job.key];
    manifest[job.key] = {
      sourceKey, normalizedSourceUrl: job.normalizedSourceUrl, revisionCreatedAt: now(),
      fileName, contentType, size, lastAccessedAt: null, recovered: false,
    };
    markManifestDirty({ schedule: false });
    try {
      await flushManifest({ force: true });
    } catch (error) {
      if (previous) manifest[job.key] = previous; else delete manifest[job.key];
      // The failed snapshot was never published. Restore this entry in memory,
      // but keep the manifest dirty so unrelated mutations are not lost.
      manifestGeneration = Math.max(manifestGeneration, persistedGeneration) + 1;
      scheduleManifestFlush();
      try { if (fs.existsSync(destination)) fs.unlinkSync(destination); } catch (_) {}
      throw error;
    }

    for (const oldKey of Object.keys(manifest)) {
      if (oldKey !== job.key && oldKey.startsWith(`${job.pt}:`)) removeEntry(oldKey);
    }
    log('log', `[IMAGE-CACHE] Downloaded #${job.productId} ${job.type} (${size} bytes, ${now() - startedAt}ms)`);
  }

  function recordFailedJob(job, error) {
    failedJobs.set(job.key, {
      productId: job.productId, type: job.type, sourceUrl: job.sourceUrl,
      attempts: job.networkRetryCount + 1, error: error.message, at: new Date(now()).toISOString(),
    });
    setLastError('download', error);
  }

  function processQueue() {
    if (!initialized || disabled || shuttingDown || suspended) return;
    while (running < options.maxConcurrency && queue.length > 0) {
      const job = queue.shift();
      if (!job || job.cancelled || jobs.get(job.key) !== job || desiredKeys.get(job.pt) !== job.key) {
        if (job) jobs.delete(job.key);
        continue;
      }
      running++;
      job.status = 'active';
      const controller = new AbortController();
      job.abortReason = null;
      abortControllers.set(job.key, controller);
      activeDownloads.set(job.key, job);
      reservedDownloadBytes += options.maxFileSize;
      let reservationHeld = true;
      const timeout = setTimer(() => {
        job.abortReason = 'timeout';
        controller.abort();
      }, options.jobTimeoutMs);
      if (timeout && timeout.unref) timeout.unref();

      void executeJob(job, controller).then(() => {
        if (jobs.get(job.key) === job) jobs.delete(job.key);
        failedJobs.delete(job.key);
      }).catch((originalError) => {
        let error = originalError;
        if (error.aborted && job.abortReason === 'timeout') error = Object.assign(new Error('Download timed out'), { code: 'ETIMEDOUT' });
        if (reservationHeld) {
          reservedDownloadBytes = Math.max(0, reservedDownloadBytes - options.maxFileSize);
          reservationHeld = false;
        }
        if (job.cancelled || shuttingDown || (error.aborted && job.abortReason !== 'timeout')) {
          if (jobs.get(job.key) === job) jobs.delete(job.key);
          return;
        }
        if (isDiskFullError(error)) {
          reclaimDiskSpace(options.maxFileSize);
          job.diskRetryCount++;
          if (hasRequiredSpace(options.maxFileSize) && job.diskRetryCount < 2) {
            job.status = 'queued';
            queue.unshift(job);
          } else {
            job.status = 'queued';
            queue.unshift(job);
            suspendQueue('disk-full');
          }
          setLastError('disk', error);
          return;
        }
        if (isTransientNetworkError(error, job) && desiredKeys.get(job.pt) === job.key && delayedRetry(job)) {
          log('warn', `[IMAGE-CACHE] Retry ${job.networkRetryCount}/${options.networkRetryDelaysMs.length} for #${job.productId} ${job.type}: ${error.message}`);
          return;
        }
        recordFailedJob(job, error);
        if (jobs.get(job.key) === job) jobs.delete(job.key);
        log('error', `[IMAGE-CACHE] Failed ${job.type} for #${job.productId}: ${error.message}`);
      }).finally(() => {
        const replacement = job.requeueAfterCancel;
        clearTimer(timeout);
        if (reservationHeld) reservedDownloadBytes = Math.max(0, reservedDownloadBytes - options.maxFileSize);
        abortControllers.delete(job.key);
        activeDownloads.delete(job.key);
        running--;
        if (jobs.get(job.key) === job && job.cancelled) jobs.delete(job.key);
        if (replacement && !shuttingDown && desiredKeys.get(job.pt) === job.key) {
          enqueue(replacement.productId, replacement.type, replacement.sourceUrl, replacement);
        }
        processQueue();
      });
    }
  }

  function reconcileOneType(product, type, sourceUrl, activeKeys, activeTypes) {
    if (!sourceUrl) return;
    const pt = productType(product.id, type);
    const existing = findExactEntry(product.id, type, sourceUrl);
    activeTypes.add(pt);
    if (existing) {
      const previousDesired = desiredKeys.get(pt);
      if (previousDesired && previousDesired !== existing.key) cancelProductType(pt);
      desiredKeys.set(pt, existing.key);
      activeKeys.add(existing.key);
      return;
    }
    const key = cacheKey(product.id, type, sourceUrl);
    activeKeys.add(key);
    enqueue(product.id, type, sourceUrl, { reason: 'catalog' });
  }

  function scheduleOrphanCleanup() {
    if (orphanCleanupScheduled) return;
    orphanCleanupScheduled = true;
    defer(() => {
      orphanCleanupScheduled = false;
      clearOrphans(latestActiveCacheKeys);
    });
  }

  function reconcileProducts(products) {
    if (!initialized || disabled || shuttingDown || !Array.isArray(products)) return;
    const activeKeys = new Set();
    const activeTypes = new Set();
    for (const product of products) {
      if (!product || !product.id) continue;
      reconcileOneType(product, 'image', product.imageUrl || product.ImageUrl || product.image_url, activeKeys, activeTypes);
      reconcileOneType(product, 'thumbnail', product.thumbnailUrl || product.ThumbnailUrl || product.thumbnail_url, activeKeys, activeTypes);
    }
    for (const pt of [...desiredKeys.keys()]) {
      if (!activeTypes.has(pt)) {
        cancelProductType(pt);
        desiredKeys.delete(pt);
      }
    }
    for (const [key, failure] of failedJobs) {
      if (!activeTypes.has(productType(failure.productId, failure.type))) failedJobs.delete(key);
    }
    latestActiveCacheKeys = activeKeys;
    scheduleOrphanCleanup();
    tryResume();
  }

  function invalidateAndEnqueueProduct(product) {
    if (!product || !product.id) return;
    for (const [type, sourceUrl] of [['image', product.imageUrl], ['thumbnail', product.thumbnailUrl]]) {
      if (sourceUrl) enqueue(product.id, type, sourceUrl, { reason: 'upload', priority: true });
      else removeProductType(product.id, type);
    }
  }

  function enqueueProduct(product) {
    if (!product || !product.id) return;
    if (product.imageUrl) enqueue(product.id, 'image', product.imageUrl);
    if (product.thumbnailUrl) enqueue(product.id, 'thumbnail', product.thumbnailUrl);
  }

  function removeProductType(productId, type) {
    const pt = productType(productId, type);
    cancelProductType(pt);
    desiredKeys.delete(pt);
    failedJobs.forEach((_value, key) => { if (key.startsWith(`${pt}:`)) failedJobs.delete(key); });
    for (const key of Object.keys(manifest)) if (key.startsWith(`${pt}:`)) removeEntry(key);
  }

  function removeProduct(productId) {
    if (!initialized || disabled || !productId) return;
    removeProductType(productId, 'image');
    removeProductType(productId, 'thumbnail');
    scheduleManifestFlush(0);
  }

  function clearOrphans(activeCacheKeys) {
    if (!initialized || disabled || !(activeCacheKeys instanceof Set)) return;
    const protectedTypes = protectedProductTypes();
    for (const key of Object.keys(manifest)) {
      if (activeCacheKeys.has(key)) continue;
      const match = CACHE_KEY_RE.exec(key);
      if (match && protectedTypes.has(`${match[1]}:${match[2]}`)) continue;
      removeEntry(key);
    }
  }

  function buildLocalUrl(productId, type, sourceKey) {
    return `/api/local-product-images/${productId}/${type}?v=${sourceKey}`;
  }

  function getLocalUrl(productId, type, sourceUrl) {
    if (!initialized || disabled || !sourceUrl) return null;
    const entry = findExactEntry(productId, type, sourceUrl);
    return entry ? buildLocalUrl(productId, type, entry.sourceKey) : null;
  }

  function touchEntry(key) {
    const entry = manifest[key];
    if (!entry) return;
    entry.lastAccessedAt = new Date(now()).toISOString();
    lastAccessDirty++;
    markManifestDirty({ schedule: false });
    if (lastAccessDirty >= options.accessFlushCount) {
      if (accessFlushTimer) clearTimer(accessFlushTimer);
      accessFlushTimer = setTimer(flushAccesses, 0);
    } else if (!accessFlushTimer) {
      accessFlushTimer = setTimer(flushAccesses, options.accessFlushMs);
      if (accessFlushTimer && accessFlushTimer.unref) accessFlushTimer.unref();
    }
  }

  function flushAccesses() {
    accessFlushTimer = null;
    lastAccessDirty = 0;
    void flushManifest().catch((error) => setLastError('manifest-access', error));
  }

  function serveRequest(req, res, productId, type) {
    if (!initialized || disabled) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('Cache not ready');
    }
    let requestedSourceKey = '';
    try {
      const queryIndex = req.url.indexOf('?');
      if (queryIndex !== -1) requestedSourceKey = new URLSearchParams(req.url.slice(queryIndex)).get('v') || '';
    } catch (_) {}
    const key = `${productId}:${type}:${requestedSourceKey}`;
    const entry = requestedSourceKey ? manifest[key] : null;
    if (!entry || !SAFE_RASTER_TYPES.has(normalizeMediaType(entry.contentType))) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }
    const filePath = safeGeneratedPath(entry.fileName);
    if (!filePath || !entryFileExists(entry)) {
      delete manifest[key];
      markManifestDirty();
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }
    touchEntry(key);
    const etag = `"${entry.sourceKey}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    try {
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': entry.contentType, 'Content-Length': stat.size, ETag: etag,
        'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff',
      });
      const stream = fs.createReadStream(filePath);
      stream.on('error', (error) => {
        setLastError('serve', error);
        if (!res.headersSent) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); }
        else res.destroy(error);
      });
      stream.pipe(res);
    } catch (_) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }

  function getStats() {
    if (!initialized) return null;
    if (disabled) return { disabled: true, lastError };
    const entries = Object.keys(manifest);
    const freeBytes = getFreeDiskBytes();
    return {
      disabled: false,
      fileCount: entries.length,
      imageCount: entries.filter((key) => key.includes(':image:')).length,
      thumbnailCount: entries.filter((key) => key.includes(':thumbnail:')).length,
      totalBytes: calculateCacheSize(),
      totalMB: (calculateCacheSize() / (1024 * 1024)).toFixed(1),
      cacheLimitBytes: options.maxCacheBytes,
      cacheLimitMB: (options.maxCacheBytes / (1024 * 1024)).toFixed(0),
      freeDiskBytes: freeBytes,
      freeDiskGB: freeBytes === Infinity ? 'N/A' : (freeBytes / (1024 * 1024 * 1024)).toFixed(1),
      reservedBytes: reservedDownloadBytes,
      pendingJobs: queue.length,
      delayedJobs: [...jobs.values()].filter((job) => job.status === 'delayed').length,
      activeDownloads: activeDownloads.size,
      failedJobs: failedJobs.size,
      recoveredFiles,
      suspended,
      suspensionReason,
      lastError,
    };
  }

  async function shutdown() {
    if (!initialized) return;
    shuttingDown = true;
    stopResumeTimer();
    if (retryWakeTimer) clearTimer(retryWakeTimer);
    retryWakeTimer = null;
    retryWakeAt = null;
    if (manifestFlushTimer) clearTimer(manifestFlushTimer);
    manifestFlushTimer = null;
    if (accessFlushTimer) clearTimer(accessFlushTimer);
    accessFlushTimer = null;
    queue = [];
    for (const job of jobs.values()) job.cancelled = true;
    for (const controller of abortControllers.values()) controller.abort();
    const deadline = now() + options.shutdownDrainMs;
    while (running > 0 && now() < deadline) await sleep(Math.min(50, Math.max(1, deadline - now())));
    try { await flushManifest({ force: true }); }
    catch (error) { setLastError('shutdown-manifest', error); }
    jobs.clear();
    activeDownloads.clear();
    abortControllers.clear();
    activeTempPaths.clear();
    desiredKeys.clear();
    failedJobs.clear();
    reservedDownloadBytes = 0;
    running = 0;
    initialized = false;
    disabled = false;
    suspended = false;
    suspensionReason = null;
    cacheDir = null;
    manifest = Object.create(null);
    manifestGeneration = 0;
    persistedGeneration = 0;
    log('log', '[IMAGE-CACHE] Shut down');
  }

  return {
    initialize, shutdown, getStats,
    enqueueProduct, invalidateAndEnqueueProduct, reconcileProducts, tryResume,
    serveRequest, getLocalUrl,
    removeProduct, clearOrphans,
    doManifestFlush: () => flushManifest({ force: true }),
    _getQueueSize: () => queue.length,
    _getActiveCount: () => activeDownloads.size,
    _isSuspended: () => suspended,
    _isDisabled: () => disabled,
    _getManifest: () => manifest,
    _getJobs: () => [...jobs.values()].map((job) => ({ ...job })),
    _hasRetryWakeTimer: () => !!retryWakeTimer,
    _normalizeSourceUrl: normalizeSourceUrl,
    _computeSourceKey: computeSourceKey,
    _reclaimDiskSpace: reclaimDiskSpace,
  };
}

const defaultCache = createImageCache();
module.exports = defaultCache;
module.exports.createImageCache = createImageCache;
