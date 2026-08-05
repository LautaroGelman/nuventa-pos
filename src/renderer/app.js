// ============================================================
// Nuventa POS — Offline Fallback Login
// Used only when the web frontend is unreachable (offline).
// Authenticates via local credentials or tries the backend
// directly through auth-service's offline/online flow.
// ============================================================
(() => {
  'use strict';

  // ── DOM Elements ───────────────────────────────────────
  const envBadge        = document.getElementById('env-badge');
  const envLabel        = document.getElementById('env-label');
  const envUrls         = document.getElementById('env-urls');

  const inputEmail      = document.getElementById('input-email');
  const inputPassword   = document.getElementById('input-password');
  const btnLogin        = document.getElementById('btn-login');
  const errorMsg        = document.getElementById('error-msg');
  const statusMsg       = document.getElementById('status-msg');
  const statusText      = document.getElementById('status-text');

  // ── Init ───────────────────────────────────────────────
  async function init() {
    try {
      const env = await window.nuventaConfig.getEnv();
      if (env) {
        envLabel.textContent = env.env.toUpperCase();
        envUrls.textContent = `Web: ${env.webAppUrl}  •  API: ${env.backendApiUrl}`;
        envBadge.className = `env-badge env-${env.env}`;
      }
    } catch (err) {
      console.error('Error loading env:', err);
    }

    // Listen for status updates during login/sync
    if (window.nuventaAuth && window.nuventaAuth.onLoginStatus) {
      window.nuventaAuth.onLoginStatus((data) => {
        showStatus(data.message || data.step || '');
      });
    }
  }

  // ── Login ──────────────────────────────────────────────
  btnLogin.addEventListener('click', doLogin);

  inputPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
  });

  inputEmail.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); inputPassword.focus(); }
  });

  async function doLogin() {
    const email = inputEmail.value.trim();
    const password = inputPassword.value;

    if (!email) {
      showError('Ingresá tu email.');
      inputEmail.focus();
      return;
    }
    if (!password) {
      showError('Ingresá tu contraseña.');
      inputPassword.focus();
      return;
    }

    hideError();
    showStatus('Verificando credenciales...');
    setLoginEnabled(false);

    try {
      // Uses auth-service: offline → check local DB, online → try backend
      const result = await window.nuventaAuth.offlineLogin(email, password);

      if (result.success) {
        if (result.isOffline) {
          showStatus('Sesión offline iniciada. Funcionalidad limitada.');
        } else {
          showStatus('Sesión iniciada. Cargando interfaz web...');
        }
      } else {
        hideStatus();
        showError(result.error || 'Error al iniciar sesión.');
        setLoginEnabled(true);
      }
    } catch (err) {
      hideStatus();
      showError('Error inesperado: ' + (err.message || String(err)));
      setLoginEnabled(true);
    }
  }

  // ── UI Helpers ─────────────────────────────────────────
  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.remove('hidden');
  }

  function hideError() {
    errorMsg.classList.add('hidden');
  }

  function showStatus(msg) {
    statusText.textContent = msg;
    statusMsg.classList.remove('hidden');
  }

  function hideStatus() {
    statusMsg.classList.add('hidden');
  }

  function setLoginEnabled(enabled) {
    btnLogin.disabled = !enabled;
    inputEmail.disabled = !enabled;
    inputPassword.disabled = !enabled;
    btnLogin.textContent = enabled
      ? '🔐 Iniciar sesión (offline)'
      : '⏳ Verificando...';
  }

  init();
})();
