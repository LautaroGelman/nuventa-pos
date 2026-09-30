// ============================================================
// Explicit unpackaged QA mode. Loopback-only URLs and a fresh profile
// keep local integration tests away from the installed POS and cloud.
// ============================================================
const fs = require('node:fs');
const path = require('node:path');

function loopbackOrigin(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Configurá ${name} con un origen local válido.`); }
  if (!['http:', 'https:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error(`${name} sólo admite un origen HTTP(S) de loopback, sin credenciales ni ruta.`);
  return url.origin;
}

function resolveQaEnvironment({ argv = process.argv, env = process.env, packaged = false } = {}) {
  if (!argv.includes('--qa')) return null;
  if (!argv.includes('--dev') || packaged)
    throw new Error('El modo QA requiere --dev y una aplicación sin empaquetar.');
  return {
    webAppUrl: loopbackOrigin(env.NUVENTA_POS_QA_WEB_URL, 'NUVENTA_POS_QA_WEB_URL'),
    backendApiUrl: loopbackOrigin(env.NUVENTA_POS_QA_API_URL, 'NUVENTA_POS_QA_API_URL'),
  };
}

function initializeQaEnvironment(app, options = {}) {
  const urls = resolveQaEnvironment({ ...options, packaged: app.isPackaged });
  if (!urls) return null;
  const profile = fs.mkdtempSync(path.join(app.getPath('temp'), 'nuventa-pos-qa-'));
  app.setPath('userData', profile);
  return { ...urls, profile };
}

module.exports = { resolveQaEnvironment, initializeQaEnvironment };
