// ============================================================
// Nuventa POS — API Client (HTTP calls to Nuventa cloud)
// ============================================================

const CONFIG_DEFAULTS = {
  baseUrl: 'https://api.nuventa.com.ar',
};

const POS_VERSION = require('../../package.json').version;
const POS_CONTRACT_VERSION = String(require('../../pos-contract.json').contractVersion);

const EventEmitter = require('events');

class ApiClient extends EventEmitter {
  constructor() {
    super();
    this.baseUrl = CONFIG_DEFAULTS.baseUrl;
    this.token = null;
    this.clientId = null;
    this.sucursalId = null;
    this.employeeId = null;
    this.lastHeartbeatAuthed = false; // R4-#33: último isOnline() respondió 2xx (no 401)
    this.authEpoch = 0;               // R4-#38: cambia en cada login/logout; el sync detecta re-apuntado
    this._revocationNotifiedForToken = null;
  }

  setAuth({ token, clientId, sucursalId, employeeId }) {
    if (token !== this.token) this._revocationNotifiedForToken = null;
    this.token = token;
    this.clientId = clientId;
    this.sucursalId = this._normalizeId(sucursalId);
    this.employeeId = employeeId;
    this.authEpoch++; // R4-#38
  }

  setActiveBranch(sucursalId) {
    const normalized = this._normalizeId(sucursalId);
    if (normalized === this.sucursalId) return;
    this.sucursalId = normalized;
    this.authEpoch++; // A branch change must abort any in-flight sync for the previous branch.
  }

  clearAuth() {
    this.token = null;
    this.clientId = null;
    this.sucursalId = null;
    this.employeeId = null;
    this._revocationNotifiedForToken = null;
    this.authEpoch++; // R4-#38
  }

  setBaseUrl(url) {
    if (url) this.baseUrl = url.replace(/\/+$/, '');
  }

  _headers() {
    const h = {
      'Content-Type': 'application/json',
      'X-Nuventa-POS-Version': POS_VERSION,
      'X-Nuventa-POS-Contract': POS_CONTRACT_VERSION,
    };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  _normalizeId(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  _branchPath() {
    const clientId = this._normalizeId(this.clientId);
    const sucursalId = this._normalizeId(this.sucursalId);
    if (!clientId || !sucursalId) {
      throw new Error('No hay una sucursal activa válida para sincronizar.');
    }
    return `${this.baseUrl}/api/client-panel/${clientId}/sucursales/${sucursalId}`;
  }

  async _fetch(url, opts = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        ...opts,
        headers: this._headers(),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        await this.handleAuthFailure(res.status, { path: url, responseBody: body });
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  // ── Connectivity check ─────────────────────────────────

  _parseResponseBody(body) {
    if (!body) return {};
    if (typeof body === 'object') return body;
    try { return JSON.parse(body); }
    catch { return {}; }
  }

  _notifySessionRevoked(info = {}) {
    if (!this.token || this._revocationNotifiedForToken === this.token) return;
    this._revocationNotifiedForToken = this.token;
    this.emit('session-revoked', {
      reason: info.reason || 'cloud-auth-rejected',
      message: info.message || '',
      path: info.path || '',
    });
  }

  /**
   * Confirma un 403 contra session-status antes de tratarlo como revocación.
   * Un 403 normal puede ser solamente falta de permisos y no debe expulsar al usuario.
   */
  async handleAuthFailure(status, { path = '', responseBody = '' } = {}) {
    if (!this.token || (status !== 401 && status !== 403)) return false;

    const originalBody = this._parseResponseBody(responseBody);
    if (status === 401) {
      this._notifySessionRevoked({
        reason: originalBody.reason || 'cloud-401',
        message: originalBody.message || originalBody.error || '',
        path,
      });
      return true;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      let sessionRes;
      try {
        sessionRes = await fetch(`${this.baseUrl}/api/auth/session-status`, {
          method: 'GET',
          headers: this._headers(),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      const text = await sessionRes.text().catch(() => '');
      const body = this._parseResponseBody(text);
      const revoked = sessionRes.status === 401
        || sessionRes.status === 403
        || body.active === false;
      if (!revoked) return false;

      this._notifySessionRevoked({
        reason: body.reason || 'cloud-403-session-invalid',
        message: body.message || body.error || '',
        path,
      });
      return true;
    } catch {
      // Si no se pudo confirmar, conservar el 403 original como error funcional.
      return false;
    }
  }

  async isOnline() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${this.baseUrl}/api/auth/session-status`, {
        method: 'GET',
        headers: this._headers(),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      // Online means the backend actually answered, not that it errored.
      // A degraded backend (5xx) is treated as offline so we don't run
      // useless sync cycles or refresh last_online_at against a dead service.
      // 401 still counts as online (server is alive, token just expired).
      // R4-#33: distinguir "vivo + AUTENTICADO" (2xx) de "vivo pero 401". El heartbeat 401 NO debe
      // refrescar la ventana de gracia offline (de lo contrario una sesión revocada operaría para
      // siempre mientras haya red). El sync lee lastHeartbeatAuthed para decidirlo.
      this.lastHeartbeatAuthed = res.ok;
      if (res.status === 401 || res.status === 403) {
        const body = await res.text().catch(() => '');
        const parsed = this._parseResponseBody(body);
        this._notifySessionRevoked({
          reason: parsed.reason || `cloud-${res.status}`,
          message: parsed.message || parsed.error || '',
          path: '/api/auth/session-status',
        });
      }
      return res.ok || res.status === 401 || res.status === 403;
    } catch {
      this.lastHeartbeatAuthed = false;
      return false;
    }
  }

  // ── Auth ─────────────────────────────────────────────

  async login(email, password, forceLogout = false) {
    const url = `${this.baseUrl}/api/auth/login?forceLogout=${forceLogout}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ email, password }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (res.status === 403) return { ...body, _httpStatus: 403 };
      if (res.status === 409) return { ...body, _httpStatus: 409, activeSessionConflict: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
      return body;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  async verifyDevice(email, code, forceLogout = false) {
    const url = `${this.baseUrl}/api/auth/verify-device?forceLogout=${forceLogout}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ email, code }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (!res.ok) return { ...body, _httpStatus: res.status };
      return body;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  async resendVerificationCode(email) {
    const url = `${this.baseUrl}/api/auth/resend-verification-code`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ email }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (!res.ok) return { ...body, _httpStatus: res.status };
      return body;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  async logout() {
    try {
      await this._fetch(`${this.baseUrl}/api/auth/logout`, { method: 'POST' });
    } catch { /* ignore */ }
    this.clearAuth();
  }

  async getMe() {
    return this._fetch(`${this.baseUrl}/api/auth/me`);
  }

  // ── Products ─────────────────────────────────────────

  async getProducts() {
    return this._fetch(`${this._branchPath()}/items`);
  }

  async getProductById(productId) {
    return this._fetch(`${this._branchPath()}/items/${productId}`);
  }

  /** Configuración de lectura de etiquetas de balanza (productos pesables). */
  async getScaleSettings() {
    return this._fetch(`${this._branchPath()}/scale-settings`);
  }

  // ── Sales ────────────────────────────────────────────

  async createSale(salePayload) {
    return this._fetch(`${this._branchPath()}/sales`, {
      method: 'POST',
      body: JSON.stringify(salePayload),
    });
  }

  async getSales(params = '') {
    return this._fetch(`${this._branchPath()}/sales${params ? '?' + params : ''}`);
  }

  async getSaleById(saleId) {
    return this._fetch(`${this._branchPath()}/sales/${saleId}`);
  }

  // ── Returns ──────────────────────────────────────────

  async createReturn(returnPayload) {
    return this._fetch(`${this._branchPath()}/returns`, {
      method: 'POST',
      body: JSON.stringify(returnPayload),
    });
  }

  async getReturns(params = '') {
    return this._fetch(`${this._branchPath()}/returns${params ? '?' + params : ''}`);
  }

  async retryReturnFiscalDocument(saleReturnId) {
    return this._fetch(`${this._branchPath()}/returns/${saleReturnId}/fiscal-document/retry`, {
      method: 'POST',
      body: '{}',
    });
  }

  // ── Cash Movements ──────────────────────────────────

  async createCashMovement(movementPayload) {
    return this._fetch(`${this._branchPath()}/cash-movements`, {
      method: 'POST',
      body: JSON.stringify(movementPayload),
    });
  }

  // ── Cash Registers ──────────────────────────────────

  async listRegisters(onlyActive = true) {
    return this._fetch(
      `${this._branchPath()}/registers?onlyActive=${onlyActive}`
    );
  }

  async getRegisterAvailability(onlyActive = true) {
    return this._fetch(
      `${this._branchPath()}/registers/availability?onlyActive=${onlyActive}`
    );
  }

  // ── Cash Sessions ────────────────────────────────────

  async getCurrentSession() {
    return this._fetch(`${this._branchPath()}/cash-sessions/current`);
  }

  async openSession(body) {
    return this._fetch(`${this._branchPath()}/cash-sessions/open`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async closeSession(sessionId, body) {
    return this._fetch(`${this._branchPath()}/cash-sessions/${sessionId}/close-with-tracking`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  // ── Sucursales ───────────────────────────────────────

  async getSucursales() {
    return this._fetch(`${this.baseUrl}/api/client-panel/${this.clientId}/sucursales`);
  }
}

const apiClient = new ApiClient();

module.exports = { apiClient, ApiClient };
