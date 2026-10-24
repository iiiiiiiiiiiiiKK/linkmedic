#!/usr/bin/env node
/**
 * Live integration check — talks to the real internet.
 *
 *   node e2e/live-targets.mjs                      # against the local Node server
 *   BASE_URL=https://linkmedic.pages.dev node e2e/live-targets.mjs
 *
 * It exercises the acceptance list from the brief: a normal page, a redirect
 * chain, a 404, a timeout-prone host, an invalid URL, a private/metadata address
 * and an oversized response. Each row prints the observed verdict so the README
 * can quote real output rather than claims.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';

const CASES = [
  { name: 'normal page', url: 'https://example.com', links: 0, expect: 'report' },
  { name: 'redirect chain', url: 'http://github.com', links: 0, expect: 'report' },
  { name: '404 page', url: 'https://httpbin.org/status/404', links: 0, expect: 'report' },
  { name: 'expired certificate', url: 'https://expired.badssl.com/', links: 0, expect: 'report' },
  { name: 'self-signed certificate', url: 'https://self-signed.badssl.com/', links: 0, expect: 'report' },
  { name: 'wrong-host certificate', url: 'https://wrong.host.badssl.com/', links: 0, expect: 'report' },
  { name: 'oversized response', url: 'https://httpbin.org/bytes/2000000', links: 0, expect: 'report' },
  { name: 'slow / timing host', url: 'https://httpbin.org/delay/3', links: 0, expect: 'report' },
  { name: 'invalid url', url: 'not a url at all', links: 0, expect: 'input_error' },
  { name: 'loopback', url: 'http://127.0.0.1/', links: 0, expect: 'input_error' },
  { name: 'private range', url: 'http://10.0.0.1/', links: 0, expect: 'input_error' },
  { name: 'cloud metadata', url: 'http://169.254.169.254/latest/meta-data/', links: 0, expect: 'input_error' },
  { name: 'malformed port scan', url: 'https://example.com:22/', links: 0, expect: 'input_error' },
  { name: 'non-http scheme', url: 'file:///etc/passwd', links: 0, expect: 'input_error' },
  {
    name: 'redirect into private space',
    url: 'https://httpbin.org/redirect-to?url=http://169.254.169.254/',
    links: 0,
    expect: 'report',
  },
  { name: 'link checking enabled', url: 'https://example.com', links: 5, expect: 'report' },
];

const rows = [];
let failures = 0;

for (const testCase of CASES) {
  const started = Date.now();
  let status = 0;
  let payload = null;
  let thrown = null;
  try {
    const response = await fetch(`${BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: testCase.url, linkCheckLimit: testCase.links }),
    });
    status = response.status;
    payload = await response.json();
  } catch (err) {
    thrown = String(err?.message ?? err);
  }
  const elapsed = Date.now() - started;

  const report = payload?.report;
  const firstSeverity = report?.findings?.[0]?.severity;
  const firstTitle = report?.findings?.[0]?.title?.en ?? payload?.error?.code ?? thrown ?? '';
  const score = report?.score?.value;
  const httpStatus = report?.page?.status ?? null;
  const certValid = report?.page?.certificate?.valid ?? null;
  const redirects = report?.page ? report.page.redirects.length - 1 : null;

  let observed;
  if (thrown) observed = 'request_failed';
  else if (status === 422) observed = 'input_error';
  else if (status === 200) observed = 'report';
  else observed = `http_${status}`;

  const ok = observed === testCase.expect;
  if (!ok) failures += 1;

  const row = {
    case: testCase.name,
    input: testCase.url,
    expected: testCase.expect,
    observed,
    ok,
    http: httpStatus,
    score: score ?? null,
    grade: report?.score?.grade ?? null,
    firstSeverity: firstSeverity ?? null,
    firstTitle,
    certValid,
    redirects,
    linksChecked: report?.links?.checked?.length ?? 0,
    linksBroken: report?.links?.broken ?? 0,
    ms: elapsed,
  };
  rows.push(row);

  console.log(
    [
      ok ? 'PASS' : 'FAIL',
      row.case.padEnd(30),
      `http=${String(row.http ?? '-').padEnd(4)}`,
      `score=${String(row.score ?? '-').padEnd(4)}`,
      `${String(row.ms).padStart(5)}ms`,
      `| ${String(row.firstSeverity ?? '-').padEnd(8)}`,
      String(row.firstTitle).slice(0, 58),
    ].join(' '),
  );
}

await writeFile(
  join(ROOT, 'e2e', 'live-targets.json'),
  JSON.stringify({ base: BASE, ranAt: new Date().toISOString(), rows }, null, 2),
);

console.log(`\n${rows.length - failures}/${rows.length} live cases behaved as expected against ${BASE}`);
if (failures > 0) process.exit(1);
