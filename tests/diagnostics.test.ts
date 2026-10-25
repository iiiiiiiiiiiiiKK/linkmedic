import { describe, expect, it } from 'vitest';
import { runDiagnostics, MAX_LINK_CHECK_LIMIT } from '../shared/core/diagnostics';
import type { HopResult, RequestOptions, Transport } from '../shared/core/transport';

const HTML_OK = `<!doctype html>
<html lang="en"><head>
  <title>A perfectly fine page title for testing</title>
  <meta name="description" content="This description is long enough to pass the length heuristic used by LinkMedic.">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="canonical" href="https://good.test/">
  <meta property="og:title" content="T">
  <meta property="og:description" content="D">
  <meta property="og:image" content="https://good.test/og.png">
</head><body>
  <h1>Heading</h1>
  <a href="/a">a</a>
  <a href="/b">b</a>
</body></html>`;

interface Script {
  pages: Record<string, Partial<HopResult>>;
  links?: Record<string, { status: number } | 'error'>;
  dns?: Record<string, string[]>;
}

function makeTransport(script: Script) {
  const calls: string[] = [];
  const transport: Transport = {
    runtime: 'node',
    kind: 'node-socket',
    ipPinning: true,
    certificateDetails: true,
    async resolve(hostname: string) {
      const answer = script.dns?.[hostname] ?? ['93.184.216.34'];
      return answer.map((address) => ({ address, family: address.includes(':') ? (6 as const) : (4 as const) }));
    },
    async request(url: string, opts: RequestOptions): Promise<HopResult> {
      calls.push(`${opts.method} ${url}`);
      const base: HopResult = {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'strict-transport-security': 'max-age=31536000',
          'content-security-policy': "default-src 'self'",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'strict-origin-when-cross-origin',
          'content-encoding': 'gzip',
        },
        body: HTML_OK,
        bodyBytes: HTML_OK.length,
        truncated: false,
        durationMs: 40,
        ttfbMs: 35,
        ip: '93.184.216.34',
        certificate: { valid: true, source: 'tls-inspection' },
        error: null,
      };

      const pageOverride = script.pages[url];
      if (pageOverride) return { ...base, ...pageOverride };

      const linkEntry = script.links?.[url];
      if (linkEntry === 'error') {
        return {
          ...base,
          status: 0,
          headers: {},
          body: '',
          error: { code: 'timeout', message: 'The request timed out.' },
        };
      }
      if (linkEntry) {
        return { ...base, status: linkEntry.status, body: '', bodyBytes: 0 };
      }
      return base;
    },
  };
  return { transport, calls };
}

describe('runDiagnostics — happy path', () => {
  it('produces a high score for a well-built page', async () => {
    const { transport } = makeTransport({ pages: {} });
    const { report } = await runDiagnostics(transport, 'https://good.test/', { linkCheckLimit: 2 });

    expect(report.page?.status).toBe(200);
    expect(report.page?.finalUrl).toBe('https://good.test/');
    expect(report.metadata?.title).toBe('A perfectly fine page title for testing');
    expect(report.score.value).toBeGreaterThanOrEqual(90);
    expect(report.score.grade).toBe('A');
    expect(report.findings.some((f) => f.severity === 'critical')).toBe(false);
  });

  it('records the engine capabilities it was given', async () => {
    const { transport } = makeTransport({ pages: {} });
    const { report } = await runDiagnostics(transport, 'https://good.test/', { linkCheckLimit: 0 });
    expect(report.engine).toEqual({
      runtime: 'node',
      transport: 'node-socket',
      ipPinning: true,
      certificateDetails: true,
    });
  });
});

describe('runDiagnostics — failure modes', () => {
  it('reports an unreachable page as critical instead of throwing', async () => {
    const { transport } = makeTransport({
      pages: {
        'https://dead.test/': {
          status: 0,
          headers: {},
          body: '',
          certificate: null,
          error: { code: 'timeout', message: 'The request timed out after 12s.' },
        },
      },
    });
    const { report } = await runDiagnostics(transport, 'https://dead.test/', { linkCheckLimit: 0 });
    expect(report.page).toBeNull();
    expect(report.findings[0].severity).toBe('critical');
    expect(report.findings[0].id).toBe('page-unreachable');
    expect(report.score.value).toBeLessThanOrEqual(45);
    // A timeout must get latency advice, not "check your DNS".
    expect(report.findings[0].recommendation.en).toMatch(/did not answer|timeout/i);
  });

  it('gives DNS advice when the host does not resolve', async () => {
    const { transport } = makeTransport({
      pages: {
        'https://nxdomain.test/': {
          status: 0,
          headers: {},
          body: '',
          certificate: null,
          error: { code: 'dns_error', message: 'The host could not be resolved.' },
        },
      },
    });
    const { report } = await runDiagnostics(transport, 'https://nxdomain.test/', { linkCheckLimit: 0 });
    expect(report.findings[0].id).toBe('page-unreachable');
    expect(report.findings[0].recommendation.en).toMatch(/domain resolves|DNS/i);
  });

  it('flags 5xx as critical', async () => {
    const { transport } = makeTransport({ pages: { 'https://err.test/': { status: 503 } } });
    const { report } = await runDiagnostics(transport, 'https://err.test/', { linkCheckLimit: 0 });
    expect(report.findings.some((f) => f.id === 'server-error')).toBe(true);
    expect(report.score.value).toBeLessThanOrEqual(45);
  });

  it('flags 404 as high severity with a concrete recommendation', async () => {
    const { transport } = makeTransport({ pages: { 'https://gone.test/': { status: 404 } } });
    const { report } = await runDiagnostics(transport, 'https://gone.test/', { linkCheckLimit: 0 });
    const finding = report.findings.find((f) => f.id === 'client-error');
    expect(finding?.severity).toBe('high');
    expect(finding?.recommendation.en).toMatch(/301/);
  });

  it('flags an invalid certificate as critical', async () => {
    const { transport } = makeTransport({
      pages: {
        'https://badcert.test/': {
          certificate: { valid: false, source: 'tls-inspection', error: 'The certificate has expired.' },
        },
      },
    });
    const { report } = await runDiagnostics(transport, 'https://badcert.test/', { linkCheckLimit: 0 });
    const finding = report.findings.find((f) => f.id === 'certificate-invalid');
    expect(finding?.severity).toBe('critical');
  });

  it('warns about a certificate expiring soon', async () => {
    const { transport } = makeTransport({
      pages: {
        'https://soon.test/': {
          certificate: { valid: true, source: 'tls-inspection', daysRemaining: 4, validTo: 'in 4 days' },
        },
      },
    });
    const { report } = await runDiagnostics(transport, 'https://soon.test/', { linkCheckLimit: 0 });
    expect(report.findings.some((f) => f.id === 'certificate-expiring' && f.severity === 'high')).toBe(true);
  });

  it('flags plain HTTP as critical', async () => {
    const { transport } = makeTransport({ pages: {} });
    const { report } = await runDiagnostics(transport, 'http://insecure.test/', { linkCheckLimit: 0 });
    expect(report.findings.some((f) => f.id === 'no-https' && f.severity === 'critical')).toBe(true);
  });

  it('marks certificates as unknown rather than valid when details are unavailable', async () => {
    const { transport } = makeTransport({
      pages: { 'https://edge.test/': { certificate: { valid: null, source: 'unavailable' } } },
    });
    const { report } = await runDiagnostics(transport, 'https://edge.test/', { linkCheckLimit: 0 });
    const finding = report.findings.find((f) => f.id === 'certificate-unknown');
    expect(finding?.severity).toBe('info');
    expect(report.findings.some((f) => f.id === 'certificate-valid')).toBe(false);
  });

  it('returns a 422-style report for an invalid URL instead of a network error', async () => {
    const { transport, calls } = makeTransport({ pages: {} });
    const { report, error } = await runDiagnostics(transport, 'http://127.0.0.1/', { linkCheckLimit: 0 });
    expect(error?.code).toBe('blocked_target');
    expect(report.findings[0].severity).toBe('high');
    expect(calls).toEqual([]); // never touched the network
  });

  it('refuses to follow a redirect into a private address', async () => {
    const { transport, calls } = makeTransport({
      pages: {
        'https://redir.test/': { status: 301, headers: { location: 'http://10.0.0.5/admin' }, body: '' },
      },
    });
    const { report } = await runDiagnostics(transport, 'https://redir.test/', { linkCheckLimit: 0 });
    expect(calls).toEqual(['GET https://redir.test/']);
    expect(report.page).toBeNull();
    expect(report.findings.some((f) => f.id === 'blocked-target')).toBe(true);
  });

  it('stops after the redirect budget', async () => {
    // A chain longer than the 5-hop budget: /0 -> /1 -> /2 -> ... every hop is a 302.
    const pages: Record<string, Partial<HopResult>> = {};
    const chain = ['https://loop.test/0'];
    for (let i = 1; i <= 12; i++) chain.push(`https://loop.test/${i}`);
    for (let i = 0; i < chain.length - 1; i++) {
      pages[chain[i]] = { status: 302, headers: { location: chain[i + 1] }, body: '' };
    }
    const { transport, calls } = makeTransport({ pages });
    const { report } = await runDiagnostics(transport, 'https://loop.test/0', { linkCheckLimit: 0 });
    expect(calls.length).toBeLessThanOrEqual(7);
    expect(report.page).toBeNull();
    expect(report.findings.some((f) => f.id === 'too-many-redirects' && f.severity === 'critical')).toBe(true);
  });

  it('reports a redirect loop explicitly', async () => {
    const { transport } = makeTransport({
      pages: {
        'https://cycle.test/': { status: 302, headers: { location: 'https://cycle.test/' }, body: '' },
      },
    });
    const { report } = await runDiagnostics(transport, 'https://cycle.test/', { linkCheckLimit: 0 });
    expect(report.page).toBeNull();
    expect(report.findings.some((f) => f.id === 'redirect-loop')).toBe(true);
  });
});

describe('runDiagnostics — link checking', () => {
  it('reports broken links with evidence', async () => {
    const { transport } = makeTransport({
      pages: {},
      links: { 'https://good.test/a': { status: 404 } },
    });
    const { report } = await runDiagnostics(transport, 'https://good.test/', { linkCheckLimit: 2 });
    const broken = report.findings.find((f) => f.id === 'broken-links');
    expect(broken?.severity).toBe('medium');
    expect(broken?.evidence).toContain('https://good.test/a');
    expect(report.links.broken).toBe(1);
  });

  it('records a network failure on a link as broken, not as a pass', async () => {
    const { transport } = makeTransport({
      pages: {},
      links: { 'https://good.test/a': 'error' },
    });
    const { report } = await runDiagnostics(transport, 'https://good.test/', { linkCheckLimit: 2 });
    const failed = report.links.checked.find((link) => link.url === 'https://good.test/a');
    expect(failed?.ok).toBe(false);
    expect(failed?.status).toBeNull();
    expect(failed?.error).toBeTruthy();
  });

  it('respects the link limit and marks the result as sampled', async () => {
    const { transport } = makeTransport({ pages: {} });
    const { report } = await runDiagnostics(transport, 'https://good.test/', { linkCheckLimit: 1 });
    expect(report.links.checked).toHaveLength(1);
    expect(report.links.truncated).toBe(true);
    expect(report.findings.some((f) => f.id === 'links-truncated')).toBe(true);
  });

  it('clamps the limit to the documented maximum', async () => {
    const { transport } = makeTransport({ pages: {} });
    const { report } = await runDiagnostics(transport, 'https://good.test/', { linkCheckLimit: 999 });
    expect(report.input.linkCheckLimit).toBe(MAX_LINK_CHECK_LIMIT);
  });

  it('skips link checking entirely when the limit is 0', async () => {
    const { transport, calls } = makeTransport({ pages: {} });
    const { report } = await runDiagnostics(transport, 'https://good.test/', { linkCheckLimit: 0 });
    expect(calls).toEqual(['GET https://good.test/']);
    expect(report.links.checked).toHaveLength(0);
  });

  it('honours the same-origin filter', async () => {
    const html = `<html><head><title>t</title></head><body>
      <a href="/in">in</a><a href="https://elsewhere.test/out">out</a></body></html>`;
    const { transport, calls } = makeTransport({
      pages: { 'https://good.test/': { body: html, bodyBytes: html.length } },
    });
    const { report } = await runDiagnostics(transport, 'https://good.test/', {
      linkCheckLimit: 5,
      sameOriginLinksOnly: true,
    });
    expect(calls.some((call) => call.includes('elsewhere.test'))).toBe(false);
    expect(report.links.checked.every((link) => link.url.startsWith('https://good.test'))).toBe(true);
  });

  it('skips links whose host resolves to a private address', async () => {
    const html = `<html><head><title>t</title></head><body>
      <a href="http://internal.test/admin">x</a></body></html>`;
    const { transport, calls } = makeTransport({
      pages: { 'https://good.test/': { body: html, bodyBytes: html.length } },
      dns: { 'good.test': ['93.184.216.34'], 'internal.test': ['10.1.2.3'] },
    });
    const { report } = await runDiagnostics(transport, 'https://good.test/', { linkCheckLimit: 5 });
    expect(calls.some((call) => call.includes('internal.test'))).toBe(false);
    expect(report.links.skipped).toBe(1);
    expect(report.links.broken).toBe(0);
  });
});

describe('runDiagnostics — metadata findings', () => {
  it('flags missing SEO essentials', async () => {
    const bare = '<html><body><p>nothing here</p></body></html>';
    const { transport } = makeTransport({
      pages: { 'https://bare.test/': { body: bare, bodyBytes: bare.length } },
    });
    const { report } = await runDiagnostics(transport, 'https://bare.test/', { linkCheckLimit: 0 });
    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain('title-missing');
    expect(ids).toContain('description-missing');
    expect(ids).toContain('canonical-missing');
    expect(ids).toContain('viewport-missing');
    expect(ids).toContain('h1-missing');
    expect(ids).toContain('og-missing');
    expect(ids).toContain('lang-missing');
  });

  it('warns when a page is marked noindex', async () => {
    const html =
      '<html lang="en"><head><title>Some reasonable title here</title><meta name="robots" content="noindex"></head><body><h1>h</h1></body></html>';
    const { transport } = makeTransport({
      pages: { 'https://ni.test/': { body: html, bodyBytes: html.length } },
    });
    const { report } = await runDiagnostics(transport, 'https://ni.test/', { linkCheckLimit: 0 });
    expect(report.findings.some((f) => f.id === 'robots-noindex')).toBe(true);
  });

  it('skips metadata checks for non-HTML responses', async () => {
    const { transport } = makeTransport({
      pages: {
        'https://api.test/': { headers: { 'content-type': 'application/json' }, body: '{"ok":true}', bodyBytes: 11 },
      },
    });
    const { report } = await runDiagnostics(transport, 'https://api.test/', { linkCheckLimit: 0 });
    expect(report.metadata).toBeNull();
    expect(report.findings.some((f) => f.id === 'not-html')).toBe(true);
  });

  it('flags missing security headers', async () => {
    const { transport } = makeTransport({
      pages: { 'https://bare.test/': { headers: { 'content-type': 'text/html; charset=utf-8' } } },
    });
    const { report } = await runDiagnostics(transport, 'https://bare.test/', { linkCheckLimit: 0 });
    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain('hsts-missing');
    expect(ids).toContain('csp-missing');
    expect(ids).toContain('xcto-missing');
    expect(ids).toContain('referrer-policy-missing');
  });

  it('flags an uncompressed, uncacheable HTML response', async () => {
    const html =
      '<html lang="en"><head><title>A somewhat reasonable title</title></head><body><h1>h</h1></body></html>';
    const { transport } = makeTransport({
      pages: {
        'https://slow.test/': {
          body: html,
          bodyBytes: html.length,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-length': String(200 * 1024),
            'cache-control': 'no-store',
            'strict-transport-security': 'max-age=1',
            'content-security-policy': "default-src 'self'",
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
          },
        },
      },
    });
    const { report } = await runDiagnostics(transport, 'https://slow.test/', { linkCheckLimit: 0 });
    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain('no-compression');
    expect(ids).toContain('html-uncacheable');
  });
});

describe('runDiagnostics — report shape', () => {
  it('is JSON-serialisable and carries both languages', async () => {
    const { transport } = makeTransport({ pages: {} });
    const { report } = await runDiagnostics(transport, 'https://good.test/', { linkCheckLimit: 2 });
    const round = JSON.parse(JSON.stringify(report));
    expect(round.schemaVersion).toBe(1);
    expect(round.id).toMatch(/^[0-9a-f]{18}$/);
    for (const f of round.findings) {
      expect(typeof f.title.zh).toBe('string');
      expect(typeof f.title.en).toBe('string');
      expect(typeof f.recommendation.zh).toBe('string');
    }
  });

  it('keeps the raw input alongside the normalized URL', async () => {
    const { transport } = makeTransport({ pages: {} });
    const { report } = await runDiagnostics(transport, 'good.test', { linkCheckLimit: 0 });
    expect(report.input.raw).toBe('good.test');
    expect(report.input.normalizedUrl).toBe('https://good.test/');
  });

  it('measures the wall clock it spent', async () => {
    const { transport } = makeTransport({ pages: {} });
    const { report } = await runDiagnostics(transport, 'https://good.test/', { linkCheckLimit: 0 });
    expect(report.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(report.timings.fetchMs).toBe(40);
  });
});
