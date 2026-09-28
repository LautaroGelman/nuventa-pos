'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handle } = require('../src/main/purchase-receipt-routes');
const { ApiClient } = require('../src/main/api-client');
const { isPublicLegalPath, proxyPublicLegal } = require('../src/main/legal-publication-routes');

function context(method = 'GET', token = 'synthetic') {
  return { req: { method, url: '/api/client-panel/1/sucursales/2/purchase-receipts/ai-notice' }, res: {},
    body: { releaseHash: 'revision' }, query: {}, subpath: '/purchase-receipts/ai-notice', db: {},
    scope: { clientId: 1, branchId: 2, employeeId: 3 }, authEpoch: 1,
    apiClient: { token, baseUrl: 'http://localhost', authEpoch: 1, clientId: 1, sucursalId: 2 },
    jsonResponse: (_res, status, body) => ({ status, body }),
    proxyToCloud: async (_req, _res, method, url, body) => ({ method, url, body }) };
}
test('status and choice go to cloud unchanged, without persisting an offline choice', async () => {
  for (const method of ['GET', 'POST']) {
    const c = context(method);
    assert.deepEqual(await handle(c), { method, url: c.req.url, body: c.body });
  }
});
test('offline, absent identity and unsupported verbs do not record a choice', async () => {
  for (const [c, expected] of [[context('POST', null), 503], [context('DELETE'), 405],
    [{ ...context(), scope: { clientId: 1, branchId: 2 } }, 401]]) {
    c.proxyToCloud = () => assert.fail('Must not proxy');
    assert.equal((await handle(c)).status, expected);
  }
});
test('cloud failure never becomes an accepted local response', async () => {
  const c = context('POST');
  c.proxyToCloud = async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); };
  assert.equal((await handle(c)).status, 503);
});
test('invoice upload keeps its payload and never queues an offline upload', async () => {
  const c=context('POST');c.subpath='/purchase-receipts/documents/00000000-0000-4000-8000-000000000000/files';
  c.req.url='/api/client-panel/1/sucursales/2'+c.subpath;
  c.body=Buffer.from('synthetic-multipart-full-invoice');
  const result=await handle(c);assert.equal(result.body,c.body);
  c.apiClient.token=null;c.proxyToCloud=()=>assert.fail('An offline upload must not be queued or proxied');
  assert.equal((await handle(c)).status,503);
});
test('login and device verification forward only the notice actually supplied by the UI', async () => {
  const original = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, status: 200, text: async () => '{"token":"synthetic"}' }; };
  try {
    const api = new ApiClient();
    const notice = { employeeTermsVersion: '1.0', employeeTermsHash: 'a'.repeat(64), password: 'must-not-override' };
    await api.login('person@example.test', 'synthetic', false, notice);
    await api.verifyDevice('person@example.test', '123456', false, notice);
    await api.login('person@example.test', 'synthetic');
    assert.equal(requests[0].employeeTermsHash, notice.employeeTermsHash);
    assert.equal(requests[0].password, 'synthetic');
    assert.equal(requests[1].employeeTermsVersion, notice.employeeTermsVersion);
    assert.equal(requests[2].employeeTermsHash, undefined);
  } finally { global.fetch = original; }
});
test('an outdated legal document is distinguishable from a network outage', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ code: 'LEGAL_DOCUMENT_CHANGED', message: 'Recargá los documentos' }) });
  try { await assert.rejects(new ApiClient().login('person@example.test', 'synthetic'), { code: 'LEGAL_DOCUMENT_CHANGED' }); }
  finally { global.fetch = original; }
});
test('a legal 409 cannot be mistaken for another active POS session', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ code: 'LEGAL_DOCUMENT_CHANGED', message: 'Recargá los documentos' }) });
  try { await assert.rejects(new ApiClient().login('person@example.test', 'synthetic'), { code: 'LEGAL_DOCUMENT_CHANGED' }); }
  finally { global.fetch = original; }
});
test('authoritative HTTP rejection retains status so auth cannot fall back to offline credentials', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ message: 'Documento desconocido' }) });
  try { await assert.rejects(new ApiClient().login('person@example.test', 'synthetic'), { status: 400 }); }
  finally { global.fetch = original; }
});
test('legal public proxy allows only document reads, without business credentials', async () => {
  assert.equal(isPublicLegalPath('/api/register/legal-documents'), true);
  assert.equal(isPublicLegalPath('/api/register/legal-documents/text/privacy'), true);
  for (const path of ['/api/register/invitation','/api/client-panel/legal-notices','/api/register/legal-info/1','/api/super-admin/legal-publications']) assert.equal(isPublicLegalPath(path), false);
  const original=global.fetch; const requests=[];
  global.fetch=async (url,options) => { requests.push({url,options}); return {status:200,headers:new Headers({'content-type':'text/plain'}),text:async () => 'Synthetic full legal document'}; };
  let status, content;
  try {
    await proxyPublicLegal({method:'GET',url:'/api/register/legal-documents/text/privacy'}, {writeHead: value => {status=value;},end:value=>{content=value;}},'http://synthetic.test');
    assert.equal(status,200); assert.equal(content,'Synthetic full legal document');
    assert.equal(requests[0].options.headers.Authorization,undefined);
  } finally {global.fetch=original;}
});
