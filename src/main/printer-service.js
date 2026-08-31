'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const AUTO_PRINT_MODES = new Set(['NONE', 'ARCA_ONLY', 'ALL_SALES']);
const PAPER_FORMATS = new Set(['A4', 'TICKET_80', 'TICKET_58']);
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TICKET_ITEMS = 500;
const MAX_AUTOMATIC_DEDUPE_KEYS = 2_000;

const LEGACY_DEFAULT_CONFIG = Object.freeze({
  setupCompleted: false,
  autoPrintMode: 'ARCA_ONLY',
  selectedPrinter: null,
  paperFormat: null,
});

function cleanString(value, maxLength, required = false) {
  if (value == null) {
    if (required) throw new Error('Falta un texto requerido en el ticket.');
    return '';
  }
  const result = String(value).trim();
  if (required && !result) throw new Error('Falta un texto requerido en el ticket.');
  if (result.length > maxLength) throw new Error(`Un texto del ticket supera ${maxLength} caracteres.`);
  return result;
}

function finiteMoney(value, field) {
  const result = Number(value);
  if (!Number.isFinite(result) || Math.abs(result) > 999_999_999_999) {
    throw new Error(`Importe inválido en ${field}.`);
  }
  return result;
}

function normalizePrinterConfig(raw = {}, legacySelected = null) {
  const setupCompleted = raw.setupCompleted === true;
  const autoPrintMode = AUTO_PRINT_MODES.has(raw.autoPrintMode)
    ? raw.autoPrintMode
    : LEGACY_DEFAULT_CONFIG.autoPrintMode;
  const selectedCandidate = raw.selectedPrinter ?? legacySelected;
  const selectedPrinter = typeof selectedCandidate === 'string' && selectedCandidate.trim()
    ? selectedCandidate.trim().slice(0, 200)
    : null;
  const paperFormat = PAPER_FORMATS.has(raw.paperFormat) ? raw.paperFormat : null;
  return { setupCompleted, autoPrintMode, selectedPrinter, paperFormat };
}

function validatePrinterConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Configuración de impresora inválida.');
  }
  if (typeof raw.setupCompleted !== 'boolean') {
    throw new Error('setupCompleted debe ser booleano.');
  }
  if (!AUTO_PRINT_MODES.has(raw.autoPrintMode)) {
    throw new Error('Modo de impresión automática inválido.');
  }
  const selectedPrinter = raw.selectedPrinter == null ? null : cleanString(raw.selectedPrinter, 200);
  const paperFormat = raw.paperFormat == null ? null : raw.paperFormat;
  if (paperFormat != null && !PAPER_FORMATS.has(paperFormat)) {
    throw new Error('Formato de papel inválido.');
  }
  if (raw.setupCompleted && raw.autoPrintMode !== 'NONE' && (!selectedPrinter || !paperFormat)) {
    throw new Error('Elegí una impresora y un formato de papel para activar la impresión automática.');
  }
  return {
    setupCompleted: raw.setupCompleted,
    autoPrintMode: raw.autoPrintMode,
    selectedPrinter,
    paperFormat,
  };
}

function normalizePrinters(printers) {
  if (!Array.isArray(printers)) return [];
  return printers
    .filter((printer) => printer && typeof printer.name === 'string' && printer.name.trim())
    .map((printer) => ({
      name: printer.name,
      displayName: printer.displayName || printer.name,
      description: printer.description || '',
      status: Number.isFinite(Number(printer.status)) ? Number(printer.status) : 0,
      isDefault: printer.isDefault === true,
      availability: 'UNKNOWN',
    }));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeTicketPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Ticket inválido.');
  }
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0 || items.length > MAX_TICKET_ITEMS) {
    throw new Error(`El ticket debe tener entre 1 y ${MAX_TICKET_ITEMS} ítems.`);
  }
  const payments = Array.isArray(payload.paymentMethods) ? payload.paymentMethods : [];
  if (payments.length > 20) throw new Error('El ticket tiene demasiados medios de pago.');

  return {
    requestId: cleanString(payload.requestId, 160, true),
    saleId: cleanString(payload.saleId, 100, true),
    business: {
      name: cleanString(payload.business?.name, 160, true),
      address: cleanString(payload.business?.address, 240),
      phone: cleanString(payload.business?.phone, 80),
    },
    date: cleanString(payload.date, 80, true),
    items: items.map((item, index) => ({
      quantity: finiteMoney(item?.quantity, `cantidad del ítem ${index + 1}`),
      description: cleanString(item?.description, 300, true),
      unitPrice: finiteMoney(item?.unitPrice, `precio del ítem ${index + 1}`),
      total: finiteMoney(item?.total, `total del ítem ${index + 1}`),
    })),
    subtotal: finiteMoney(payload.subtotal, 'subtotal'),
    discount: finiteMoney(payload.discount ?? 0, 'descuento'),
    total: finiteMoney(payload.total, 'total'),
    paymentMethods: payments.map((method) => cleanString(method, 80, true)),
  };
}

function formatAmount(value) {
  return new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function buildTicketHtml(payload, paperFormat) {
  const ticket = normalizeTicketPayload(payload);
  const pageSize = paperFormat === 'A4' ? 'A4' : paperFormat === 'TICKET_58' ? '58mm auto' : '80mm auto';
  const width = paperFormat === 'A4' ? '190mm' : paperFormat === 'TICKET_58' ? '52mm' : '72mm';
  const itemRows = ticket.items.map((item) => `
    <div class="item"><div>${escapeHtml(formatAmount(item.quantity))} × ${escapeHtml(item.description)}</div><div class="amount">$ ${escapeHtml(formatAmount(item.total))}</div></div>
    <div class="unit">$ ${escapeHtml(formatAmount(item.unitPrice))} c/u</div>`).join('');
  const payments = ticket.paymentMethods.length
    ? `<div class="row"><span>Pago</span><span>${escapeHtml(ticket.paymentMethods.join(' + '))}</span></div>`
    : '';

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<style>
  @page { size: ${pageSize}; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: #000; background: #fff; font-family: Arial, sans-serif; }
  body { width: ${width}; padding: 4mm 3mm; font-size: 11px; line-height: 1.25; }
  h1 { margin: 0 0 2mm; font-size: 16px; text-align: center; }
  .center { text-align: center; }
  .muted { font-size: 10px; }
  .rule { border-top: 1px dashed #000; margin: 2.5mm 0; }
  .item, .row { display: flex; justify-content: space-between; gap: 3mm; }
  .item > :first-child, .row > :first-child { min-width: 0; overflow-wrap: anywhere; }
  .amount, .row > :last-child { white-space: nowrap; text-align: right; }
  .unit { margin: 0 0 1.5mm; font-size: 9px; }
  .total { font-size: 15px; font-weight: 700; }
</style></head><body>
  <h1>${escapeHtml(ticket.business.name)}</h1>
  ${ticket.business.address ? `<div class="center muted">${escapeHtml(ticket.business.address)}</div>` : ''}
  ${ticket.business.phone ? `<div class="center muted">${escapeHtml(ticket.business.phone)}</div>` : ''}
  <div class="rule"></div>
  <div class="row"><span>Venta</span><span>${escapeHtml(ticket.saleId)}</span></div>
  <div class="row"><span>Fecha</span><span>${escapeHtml(ticket.date)}</span></div>
  <div class="rule"></div>
  ${itemRows}
  <div class="rule"></div>
  <div class="row"><span>Subtotal</span><span>$ ${escapeHtml(formatAmount(ticket.subtotal))}</span></div>
  ${ticket.discount ? `<div class="row"><span>Descuento</span><span>-$ ${escapeHtml(formatAmount(ticket.discount))}</span></div>` : ''}
  <div class="row total"><span>Total</span><span>$ ${escapeHtml(formatAmount(ticket.total))}</span></div>
  ${payments}
  <div class="rule"></div>
  <div class="center">Gracias por su compra</div>
</body></html>`;
}

class PrinterService {
  constructor(options) {
    this.configStore = options.configStore;
    this.BrowserWindow = options.BrowserWindow;
    this.getTempPath = options.getTempPath;
    this.emitStatus = options.emitStatus || (() => {});
    this.fs = options.fs || fs;
    this.timeoutMs = options.timeoutMs || 30_000;
    this.renderDelayMs = options.renderDelayMs ?? 400;
    this.cleanupDelayMs = options.cleanupDelayMs ?? 6_000;
    this._queue = Promise.resolve();
    this._automaticKeys = new Set();
  }

  getConfig() {
    const stored = this.configStore.get('printerConfig');
    return normalizePrinterConfig(stored, this.configStore.get('selectedPrinter'));
  }

  saveConfig(raw) {
    const config = validatePrinterConfig(raw);
    this.configStore.set('printerConfig', config);
    this.configStore.set('selectedPrinter', config.selectedPrinter);
    return config;
  }

  async listPrinters(webContents) {
    return normalizePrinters(await webContents.getPrintersAsync());
  }

  async getState(webContents) {
    const config = this.getConfig();
    let printers = [];
    let listError = null;
    try {
      printers = await this.listPrinters(webContents);
    } catch (error) {
      listError = error?.message || 'No se pudieron consultar las impresoras instaladas.';
    }
    const selectedPresent = !!config.selectedPrinter && printers.some((p) => p.name === config.selectedPrinter);
    let readiness = 'UNCONFIGURED';
    if (config.setupCompleted) {
      if (config.autoPrintMode === 'NONE') readiness = 'DISABLED';
      else if (!printers.length) readiness = 'NO_PRINTERS';
      else readiness = selectedPresent ? 'READY' : 'MISSING';
    }
    return { version: 2, config, printers, selectedPresent, readiness, listError };
  }

  _result(jobId, success, state, errorCode = null, error = null, extra = {}) {
    return { jobId, success, state, errorCode, error, ...extra };
  }

  _emit(job) {
    try { this.emitStatus(job); } catch { /* renderer may be gone */ }
  }

  _enqueue(kind, requestId, automatic, runner) {
    const jobId = crypto.randomUUID();
    const dedupeKey = automatic && requestId ? `${kind}:${requestId}` : null;
    if (dedupeKey && this._automaticKeys.has(dedupeKey)) {
      return Promise.resolve(this._result(jobId, true, 'SPOOLED', 'DUPLICATE_SKIPPED', null, { skipped: true }));
    }
    if (dedupeKey) {
      this._automaticKeys.add(dedupeKey);
      while (this._automaticKeys.size > MAX_AUTOMATIC_DEDUPE_KEYS) {
        this._automaticKeys.delete(this._automaticKeys.values().next().value);
      }
    }
    this._emit({ jobId, kind, requestId, state: 'QUEUED' });
    const execute = async () => {
      this._emit({ jobId, kind, requestId, state: 'PRINTING' });
      try {
        const result = await runner(jobId);
        this._emit({ ...result, kind, requestId });
        if (!result.success && dedupeKey) this._automaticKeys.delete(dedupeKey);
        return result;
      } catch (error) {
        if (dedupeKey) this._automaticKeys.delete(dedupeKey);
        const result = this._result(jobId, false, 'FAILED', error.code || 'PRINT_FAILED', error.message || 'Falló la impresión.');
        this._emit({ ...result, kind, requestId });
        return result;
      }
    };
    const pending = this._queue.then(execute, execute);
    this._queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async _resolveDevice(webContents, requestedName) {
    const config = this.getConfig();
    const deviceName = requestedName || config.selectedPrinter || '';
    if (requestedName != null && (typeof requestedName !== 'string' || requestedName.length > 200)) {
      const error = new Error('Impresora inválida.');
      error.code = 'INVALID_PRINTER';
      throw error;
    }
    if (config.setupCompleted && config.autoPrintMode !== 'NONE') {
      const printers = await this.listPrinters(webContents);
      if (!deviceName || !printers.some((printer) => printer.name === deviceName)) {
        const error = new Error('La impresora configurada ya no está instalada en Windows.');
        error.code = 'PRINTER_MISSING';
        throw error;
      }
    }
    return deviceName;
  }

  printPdf(webContents, bytes, opts = {}) {
    opts = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
    let buffer;
    if (bytes instanceof Uint8Array || Buffer.isBuffer(bytes)) buffer = Buffer.from(bytes);
    else if (bytes instanceof ArrayBuffer) buffer = Buffer.from(new Uint8Array(bytes));
    else return Promise.resolve(this._result(crypto.randomUUID(), false, 'FAILED', 'INVALID_PDF', 'Formato de PDF inválido.'));
    if (!buffer.length || buffer.length > MAX_PDF_BYTES || !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      return Promise.resolve(this._result(crypto.randomUUID(), false, 'FAILED', 'INVALID_PDF', 'PDF vacío, inválido o demasiado grande (máx. 20 MB).'));
    }
    const requestId = typeof opts.requestId === 'string' ? opts.requestId.slice(0, 160) : '';
    return this._enqueue('PDF', requestId, opts.automatic === true, async (jobId) => {
      const deviceName = await this._resolveDevice(webContents, opts.deviceName);
      const tempPath = path.join(this.getTempPath(), `nuventa-print-${jobId}.pdf`);
      this.fs.writeFileSync(tempPath, buffer);
      return this._printFile(jobId, tempPath, deviceName, true);
    });
  }

  printTicket(webContents, payload, opts = {}) {
    opts = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
    let normalized;
    try { normalized = normalizeTicketPayload(payload); }
    catch (error) { return Promise.resolve(this._result(crypto.randomUUID(), false, 'FAILED', 'INVALID_TICKET', error.message)); }
    return this._enqueue('SALE_TICKET', normalized.requestId, opts.automatic === true, async (jobId) => {
      const config = this.getConfig();
      const paperFormat = PAPER_FORMATS.has(opts.paperFormat) ? opts.paperFormat : config.paperFormat;
      if (!paperFormat) {
        const error = new Error('La caja no tiene un formato de papel configurado.');
        error.code = 'PAPER_FORMAT_MISSING';
        throw error;
      }
      const deviceName = await this._resolveDevice(webContents, opts.deviceName);
      const tempPath = path.join(this.getTempPath(), `nuventa-ticket-${jobId}.html`);
      this.fs.writeFileSync(tempPath, buildTicketHtml(normalized, paperFormat), 'utf8');
      return this._printFile(jobId, tempPath, deviceName, false);
    });
  }

  async _printFile(jobId, tempPath, deviceName, isPdf) {
    let printWindow = null;
    try {
      printWindow = new this.BrowserWindow({
        show: false,
        webPreferences: {
          plugins: isPdf,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          devTools: false,
        },
      });
      await printWindow.loadURL(pathToFileURL(tempPath).href);
      if (this.renderDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.renderDelayMs));

      const printResult = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        };
        const timeout = setTimeout(() => finish({ success: false, reason: 'La impresora no respondió dentro de 30 segundos.', code: 'PRINT_TIMEOUT' }), this.timeoutMs);
        if (!printWindow || printWindow.isDestroyed()) {
          finish({ success: false, reason: 'La ventana de impresión se cerró.', code: 'PRINT_WINDOW_CLOSED' });
          return;
        }
        printWindow.webContents.print({
          silent: true,
          printBackground: true,
          deviceName: deviceName || undefined,
          margins: { marginType: 'none' },
        }, (success, failureReason) => finish({ success, reason: failureReason || null, code: success ? null : 'SPOOLER_REJECTED' }));
      });

      return printResult.success
        ? this._result(jobId, true, 'SPOOLED')
        : this._result(jobId, false, 'FAILED', printResult.code, printResult.reason);
    } finally {
      if (printWindow && !printWindow.isDestroyed()) {
        setTimeout(() => { try { printWindow.destroy(); } catch {} }, Math.min(3_000, this.cleanupDelayMs));
      }
      setTimeout(() => { try { this.fs.unlinkSync(tempPath); } catch {} }, this.cleanupDelayMs);
    }
  }
}

module.exports = {
  PrinterService,
  LEGACY_DEFAULT_CONFIG,
  normalizePrinterConfig,
  validatePrinterConfig,
  normalizeTicketPayload,
  buildTicketHtml,
};
