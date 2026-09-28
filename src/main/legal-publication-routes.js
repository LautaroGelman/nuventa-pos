'use strict';

// The only anonymous proxy routes added for legal documents. Never forwards a cached bearer token.
function isPublicLegalPath(pathname) {
  return pathname === '/api/register/legal-documents' || pathname === '/api/register/invoice-ai-notice'
    || /^\/api\/register\/legal-documents\/text\/(privacy|serviceTerms|employeeTerms)$/.test(pathname)
    || /^\/api\/register\/legal-documents\/[a-f0-9]{64}\/(privacy|serviceTerms|employeeTerms)$/.test(pathname);
}
async function proxyPublicLegal(req, res, baseUrl) {
  const pathname = req.url.split('?')[0];
  if (req.method !== 'GET' || !isPublicLegalPath(pathname)) throw new Error('Invalid public legal route');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${baseUrl}${req.url}`, { signal: controller.signal, headers: { Accept: 'application/json,text/plain' } });
    const text = await response.text();
    res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(text);
  } catch {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ message: 'Los documentos vigentes requieren conexión. Reintentá cuando vuelva la conexión.' }));
  } finally { clearTimeout(timer); }
}
module.exports = { isPublicLegalPath, proxyPublicLegal };
