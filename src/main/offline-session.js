// Process-local authentication capability, issued only after password validation.
// It never authorizes a cloud request and cannot survive a process restart.
const crypto = require('crypto');
const secret = crypto.randomBytes(32);
const issued = new Set();

function createOfflineSession(claims, expiresAt) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...claims, iss: 'nuventa-pos-local',
    jti: crypto.randomUUID(), exp: Math.floor(expiresAt / 1000) })).toString('base64url');
  const body = `${header}.${payload}`;
  const token = `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
  issued.add(token);
  return token;
}

function isOfflineSession(token) { return issued.has(token); }
module.exports = { createOfflineSession, isOfflineSession };
