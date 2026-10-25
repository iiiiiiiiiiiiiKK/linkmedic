const BASE = process.env.BASE_URL ?? 'https://linkmedic.pages.dev';

const raw = await (await fetch(BASE)).text();
console.log('page bytes:', raw.length);
console.log('has root div:', raw.includes('id="root"'));
console.log('has og:title:', raw.includes('og:title'));
console.log('has favicon:', raw.includes('favicon.svg'));

const assets = [...raw.matchAll(/\/assets\/index-[A-Za-z0-9_-]+\.(?:js|css)/g)].map((m) => m[0]);
for (const asset of [...new Set(assets)]) {
  const response = await fetch(BASE + asset);
  console.log(asset, '->', response.status, '| cache:', response.headers.get('cache-control'));
}

const health = await fetch(`${BASE}/api/health`);
console.log(
  'health:',
  health.status,
  '| type:',
  health.headers.get('content-type'),
  '| cache:',
  health.headers.get('cache-control'),
  '| cors-free:',
  health.headers.get('access-control-allow-origin') === null,
);

const methodCheck = await fetch(`${BASE}/api/analyze`);
console.log('GET /api/analyze ->', methodCheck.status, (await methodCheck.text()).slice(0, 90));

const badJson = await fetch(`${BASE}/api/analyze`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{oops',
});
console.log('bad json ->', badJson.status, (await badJson.text()).slice(0, 80));

const tooBig = await fetch(`${BASE}/api/analyze`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'example.com', pad: 'x'.repeat(20000) }),
});
console.log('oversized body ->', tooBig.status, (await tooBig.text()).slice(0, 80));
