'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PrinterService,
  normalizePrinterConfig,
  validatePrinterConfig,
  buildTicketHtml,
} = require('../src/main/printer-service');

const PDF = Buffer.from('%PDF-1.4\n%%EOF');

function createConfigStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: (key) => data[key],
    set: (key, value) => { data[key] = value; },
  };
}

function createHarness(options = {}) {
  const writes = new Map();
  const removed = [];
  const events = [];
  const printCalls = [];
  let active = 0;
  let maxActive = 0;
  const behavior = options.behavior || 'success';

  class FakeWindow {
    constructor() {
      this.destroyed = false;
      this.webContents = {
        print: (_opts, callback) => {
          printCalls.push(_opts);
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (behavior === 'timeout') return;
          setTimeout(() => {
            active -= 1;
            callback(behavior !== 'failure', behavior === 'failure' ? 'spooler error' : '');
          }, options.printDelayMs ?? 2);
        },
      };
    }
    async loadURL() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }

  const store = createConfigStore(options.config || {});
  const service = new PrinterService({
    configStore: store,
    BrowserWindow: FakeWindow,
    getTempPath: () => 'C:\\temp',
    emitStatus: (event) => events.push(event),
    timeoutMs: options.timeoutMs || 50,
    renderDelayMs: 0,
    cleanupDelayMs: 0,
    fs: {
      writeFileSync: (file, contents) => writes.set(file, contents),
      unlinkSync: (file) => { removed.push(file); writes.delete(file); },
    },
  });
  const sender = {
    getPrintersAsync: async () => options.printers || [{ name: 'Thermal', displayName: 'Thermal', isDefault: true, status: 0 }],
  };
  return { service, sender, store, writes, removed, events, printCalls, getMaxActive: () => maxActive };
}

function ticket(overrides = {}) {
  return {
    requestId: 'sale:1',
    saleId: '1',
    business: { name: 'Mi negocio', address: 'Calle 1' },
    date: '24/08/2026 10:00',
    items: [{ quantity: 1, description: 'Producto', unitPrice: 100, total: 100 }],
    subtotal: 100,
    discount: 0,
    total: 100,
    paymentMethods: ['EFECTIVO'],
    ...overrides,
  };
}

test('migrates a legacy selectedPrinter without marking setup complete', () => {
  assert.deepEqual(normalizePrinterConfig(undefined, 'Thermal'), {
    setupCompleted: false,
    autoPrintMode: 'ARCA_ONLY',
    selectedPrinter: 'Thermal',
    paperFormat: null,
  });
});

test('requires printer and paper for a completed automatic setup', () => {
  assert.throws(() => validatePrinterConfig({
    setupCompleted: true,
    autoPrintMode: 'ALL_SALES',
    selectedPrinter: null,
    paperFormat: null,
  }), /Elegí una impresora/);
});

test('serializes print jobs and reports them as spooled', async () => {
  const h = createHarness({ printDelayMs: 10 });
  const first = h.service.printPdf(h.sender, PDF, {});
  const second = h.service.printPdf(h.sender, PDF, {});
  const results = await Promise.all([first, second]);
  assert.equal(h.getMaxActive(), 1);
  assert.deepEqual(results.map((result) => result.state), ['SPOOLED', 'SPOOLED']);
  assert.equal(h.printCalls.length, 2);
});

test('deduplicates automatic jobs but allows failures to be retried', async () => {
  const h = createHarness();
  const [first, duplicate] = await Promise.all([
    h.service.printPdf(h.sender, PDF, { automatic: true, requestId: 'invoice:8' }),
    h.service.printPdf(h.sender, PDF, { automatic: true, requestId: 'invoice:8' }),
  ]);
  assert.equal(first.success, true);
  assert.equal(duplicate.skipped, true);
  assert.equal(h.printCalls.length, 1);
});

test('bounds automatic deduplication without breaking recent duplicate protection', async () => {
  const h = createHarness();
  const enqueue = (requestId) => h.service._enqueue(
    'PDF',
    requestId,
    true,
    async (jobId) => h.service._result(jobId, true, 'SPOOLED'),
  );
  for (let index = 0; index < 2_001; index += 1) {
    await enqueue(`invoice:${index}`);
  }
  const recentDuplicate = await enqueue('invoice:2000');
  const evictedOldJob = await enqueue('invoice:0');
  assert.equal(recentDuplicate.skipped, true);
  assert.equal(evictedOldJob.skipped, undefined);
  assert.equal(h.service._automaticKeys.size, 2_000);
});

test('treats null IPC options as defaults instead of throwing', async () => {
  const h = createHarness({
    config: { printerConfig: { setupCompleted: true, autoPrintMode: 'ALL_SALES', selectedPrinter: 'Thermal', paperFormat: 'TICKET_80' } },
  });
  const pdfResult = await h.service.printPdf(h.sender, PDF, null);
  const ticketResult = await h.service.printTicket(h.sender, ticket(), null);
  assert.equal(pdfResult.state, 'SPOOLED');
  assert.equal(ticketResult.state, 'SPOOLED');
});

test('does not fall back when the configured printer is missing', async () => {
  const h = createHarness({
    config: { printerConfig: { setupCompleted: true, autoPrintMode: 'ARCA_ONLY', selectedPrinter: 'Missing', paperFormat: 'TICKET_80' } },
  });
  const result = await h.service.printPdf(h.sender, PDF, {});
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'PRINTER_MISSING');
  assert.equal(h.printCalls.length, 0);
});

test('times out a stalled spooler without retrying', async () => {
  const h = createHarness({ behavior: 'timeout', timeoutMs: 10 });
  const result = await h.service.printPdf(h.sender, PDF, {});
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'PRINT_TIMEOUT');
  assert.equal(h.printCalls.length, 1);
});

test('renders a structured ticket with escaped content and restrictive CSP', () => {
  const html = buildTicketHtml(ticket({ business: { name: '<script>alert(1)</script>' } }), 'TICKET_58');
  assert.match(html, /58mm auto/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test('prints a structured ticket using the configured paper', async () => {
  const h = createHarness({
    config: { printerConfig: { setupCompleted: true, autoPrintMode: 'ALL_SALES', selectedPrinter: 'Thermal', paperFormat: 'TICKET_80' } },
  });
  const result = await h.service.printTicket(h.sender, ticket(), { automatic: true });
  assert.equal(result.state, 'SPOOLED');
  assert.equal(h.printCalls[0].deviceName, 'Thermal');
});
