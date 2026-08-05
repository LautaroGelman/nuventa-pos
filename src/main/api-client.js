// ============================================================
// Nuventa POS — API Client (HTTP calls to Nuventa cloud)
// ============================================================

const CONFIG_DEFAULTS = {
  baseUrl: 'https://api.nuventa.com.ar',
};

class ApiClient {
  constructor() {
    this.baseUrl = CONFIG_DEFAULTS.baseUrl;
    this.token = null;
    this.clientId = null;
    this.sucursalId = null;
    this.employeeId = null;
    this.lastHeartbeatAuthed = false; // R4-#33: último isOnline() respondió 2xx (no 401)
    this.authEpoch = 0;               // R4-#38: cambia en cada login/logout; el sync detecta re-apuntado
  }

  setAuth({ token, clientId, sucursalId, employeeId }) {
    this.token = token;
    this.clientId = clientId;
    this.sucursalId = sucursalId;
    this.employeeId = employeeId;
    this.authEpoch++; // R4-#38
  }

  clearAuth() {
    this.token = null;
    this.clientId = null;
    this.sucursalId = null;
    this.employeeId = null;
    this.authEpoch++; // R4-#38
  }

  setBaseUrl(url) {
    if (url) this.baseUrl = url.replace(/\/+$/, '');
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  _branchPath() {
    return `${this.baseUrl}/api/client-panel/${this.clientId}/sucursales/${this.sucursalId}`;
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
      return res.ok || res.status === 401;
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
    return this._fetch(url, {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    });
  }

  async resendVerificationCode(email) {
    return this._fetch(`${this.baseUrl}/api/auth/resend-verification-code`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
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
