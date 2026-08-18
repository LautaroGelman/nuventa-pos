// ============================================================
// Nuventa POS — Simple JSON Config Store
// ============================================================
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// ── Environment detection ────────────────────────────────
// --dev flag  → dev mode  (localhost:3000 + localhost:8080)
// otherwise   → prod mode (web on nuventa.com.ar, API on api.nuventa.com.ar)
const _isDev = process.argv.includes('--dev');

const ENV_URLS = {
  dev:  { webAppUrl: 'http://localhost:3000', backendApiUrl: 'http://localhost:8080' },
  prod: { webAppUrl: 'https://nuventa.com.ar', backendApiUrl: 'https://api.nuventa.com.ar' },
};

function isDev() { return _isDev; }
function getEnvName() { return _isDev ? 'dev' : 'prod'; }
function getEnvUrls() { return _isDev ? ENV_URLS.dev : ENV_URLS.prod; }

const DEFAULTS = {
  windowWidth: 1280,
  windowHeight: 800,
};

let _config = null;
let _configPath = null;

function _getConfigPath() {
  if (!_configPath) {
    _configPath = path.join(app.getPath('userData'), 'nuventa-pos-config.json');
  }
  return _configPath;
}

function loadConfig() {
  try {
    const filePath = _getConfigPath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      _config = { ...DEFAULTS, ...JSON.parse(raw) };
    } else {
      _config = { ...DEFAULTS };
    }
  } catch (err) {
    console.error('[CONFIG] Error loading config:', err.message);
    _config = { ...DEFAULTS };
  }
  return _config;
}

function saveConfig(data) {
  try {
    _config = { ..._config, ...data };
    const filePath = _getConfigPath();
    fs.writeFileSync(filePath, JSON.stringify(_config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[CONFIG] Error saving config:', err.message);
  }
}

function getConfig() {
  if (!_config) loadConfig();
  return _config;
}

function get(key) {
  // For URL keys, always derive from environment
  if (key === 'webAppUrl') return getEnvUrls().webAppUrl;
  if (key === 'backendApiUrl') return getEnvUrls().backendApiUrl;
  const cfg = getConfig();
  return cfg[key] !== undefined ? cfg[key] : DEFAULTS[key];
}

function set(key, value) {
  saveConfig({ [key]: value });
}

module.exports = { loadConfig, saveConfig, getConfig, get, set, DEFAULTS, isDev, getEnvName, getEnvUrls };
