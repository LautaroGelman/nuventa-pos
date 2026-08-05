// ============================================================
// Nuventa POS — Token Encryption Helper
// Uses Electron's safeStorage (OS-level encryption: DPAPI on
// Windows, Keychain on macOS, libsecret on Linux) to encrypt
// JWT tokens before storing them in SQLite.
// Falls back to plain text if safeStorage is unavailable.
// ============================================================
const { safeStorage } = require('electron');

const ENCRYPTED_PREFIX = 'enc:';

/**
 * Encrypt a token string using safeStorage.
 * Returns a prefixed base64 string, or the plain token if unavailable.
 */
function encryptToken(plainToken) {
  if (!plainToken) return plainToken;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(plainToken);
      return ENCRYPTED_PREFIX + encrypted.toString('base64');
    }
  } catch (err) {
    console.error('[TOKEN-CRYPTO] Encryption failed:', err.message);
  }
  // A09: NUNCA degradar a texto plano en silencio. Si safeStorage no está disponible (Linux sin
  // keyring, headless, DPAPI roto), NO se persiste el token → el usuario inicia sesión online; el JWT
  // (24h) jamás queda legible en el .db. El login offline por contraseña sigue funcionando sin token.
  console.error('[TOKEN-CRYPTO] safeStorage NO disponible — el token no se persiste (se evita texto plano).');
  return null;
}

/**
 * Decrypt a token string. Handles both encrypted (prefixed) and
 * legacy plain-text tokens transparently.
 */
function decryptToken(storedValue) {
  if (!storedValue) return storedValue;
  if (!storedValue.startsWith(ENCRYPTED_PREFIX)) {
    // A09: token legacy en texto plano (instalación previa). Se lee para no romper la sesión, pero se
    // avisa fuerte; en el próximo login se re-guardará cifrado (o no se persistirá si no hay safeStorage).
    console.warn('[TOKEN-CRYPTO] Token legacy en texto plano detectado — se recomienda re-login para cifrarlo.');
    return storedValue;
  }
  try {
    const base64 = storedValue.slice(ENCRYPTED_PREFIX.length);
    const buffer = Buffer.from(base64, 'base64');
    return safeStorage.decryptString(buffer);
  } catch (err) {
    console.warn('[TOKEN-CRYPTO] Decryption failed:', err.message);
    return null;
  }
}

module.exports = { encryptToken, decryptToken };
