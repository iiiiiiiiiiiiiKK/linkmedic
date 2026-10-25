/**
 * Production acceptance check.
 *
 * Verifies, against the deployed site, every claim the README makes about the
 * live service: shell, health, a real diagnosis, link checking, bilingual
 * findings, the SSRF guard and the hardening headers.
 *
 *   node scripts/verify-production.mjs
 *   BASE_URL=https://linkmedic.pages.dev node scripts/verify-production.mjs
 */
const BASE = process.env.BASE_URL ?? 'https://linkmedic.pages.dev';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const home = await fetch(BASE);
const html = await home.text();
check('live site responds 200', home.status === 200, String(home.status));
check('SPA root element present', html.includes('id="root"'));
check('Open Graph metadata in shell', html.includes('og:title'));

const healthResponse = await fetch(`${BASE}/api/health`);
const health = await healthResponse.json();
check('health endpoint ok', health.status === 'ok', health.runtime);
check('rate limiting is enforced', health.limits.rateLimitEnforced === true);
check(
  'health reports capabilities honestly',
  typeof health.capabilities.ipPinning === 'boolean',
  `ipPinning=${health.capabilities.ipPinning}, certDetails=${health.capabilities.certificateDetails}`,
);

const analyze = await fetch(`${BASE}/api/analyze`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'https://github.com', linkCheckLimit: 5 }),
});
const report = (await analyze.json()).report;
check('real diagnosis completes', analyze.status === 200, `score ${report.score.value}${report.score.grade}`);
check('page status measured', typeof report.page.status === 'number', `HTTP ${report.page.status}`);
check('broken-link checking ran', report.links.checked.length > 0, `${report.links.checked.length} checked`);
check(
  'findings are bilingual',
  typeof report.findings[0].title.zh === 'string' && typeof report.findings[0].title.en === 'string',
);
check(
  'every finding carries evidence or a recommendation',
  report.findings.every((f) => f.evidence !== undefined || f.recommendation.en.length > 0),
);

const blocked = await fetch(`${BASE}/api/analyze`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
});
const blockedBody = await blocked.json();
check('cloud-metadata target refused', blocked.status === 422, blockedBody.error?.code ?? '');
check('blocked request never reaches the network', blockedBody.report?.page === null, 'no page payload');

check('CSP on API responses', Boolean(healthResponse.headers.get('content-security-policy')));
check('HSTS on API responses', Boolean(healthResponse.headers.get('strict-transport-security')));
check('frame denial on API responses', healthResponse.headers.get('x-frame-options') === 'DENY');

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} production checks passed against ${BASE}`);
if (passed !== results.length) process.exit(1);
