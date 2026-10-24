import { describe, expect, it, vi } from 'vitest';
import { toCsvFile, toJsonFile, toPlainText, addHistoryEntry, type HistoryEntry } from '../src/lib/history';
import { formatBytes, formatMs, hostLabel, shortUrl } from '../src/lib/i18n';
import type { DiagnosticReport } from '../shared/core/types';

const report: DiagnosticReport = {
  schemaVersion: 1,
  id: 'abc123456789def012',
  createdAt: '2026-01-02T03:04:05.000Z',
  engine: {
    runtime: 'cloudflare-workers',
    transport: 'edge-fetch',
    ipPinning: false,
    certificateDetails: false,
  },
  input: { raw: 'example.com', normalizedUrl: 'https://example.com/', linkCheckLimit: 5, sameOriginLinksOnly: false },
  target: {
    requestedUrl: 'https://example.com/',
    host: 'example.com',
    hostname: 'example.com',
    port: 443,
    protocol: 'https',
    path: '/',
  },
  page: {
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: '',
    bodyBytes: 1024,
    truncated: false,
    redirects: [{ url: 'https://example.com/', status: 200, location: null, method: 'GET', durationMs: 20, ip: null }],
    timing: { ttfbMs: 30, totalMs: 40 },
    certificate: { valid: true, source: 'edge-validation' },
    ip: null,
    contentType: 'text/html',
    charset: 'utf-8',
  },
  metadata: null,
  links: { checked: [], totalFound: 0, broken: 0, skipped: 0, truncated: false },
  findings: [
    {
      id: 'f1',
      check: 'metadata',
      severity: 'high',
      status: 'fail',
      title: { zh: '缺少标题', en: 'Missing title' },
      detail: { zh: '详情', en: 'Detail text' },
      recommendation: { zh: '建议', en: 'Do this' },
      evidence: 'line1\nline2',
      weight: 20,
    },
    {
      id: 'f2',
      check: 'links',
      severity: 'pass',
      status: 'pass',
      title: { zh: '正常', en: 'Fine' },
      detail: { zh: '好', en: 'Good' },
      recommendation: { zh: '无需处理', en: 'Nothing to do' },
      weight: 0,
    },
  ],
  score: { value: 71, grade: 'C', counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0, pass: 1 } },
  timings: { totalMs: 1234, fetchMs: 40, linkCheckMs: 0 },
  warnings: [],
};

describe('CSV export', () => {
  const csv = toCsvFile(report, 'en').content;

  it('has a metadata block and a findings table', () => {
    expect(csv).toContain('"report_id","abc123456789def012"');
    expect(csv).toContain('"severity","status","check","title","detail","recommendation","evidence"');
    expect(csv).toContain('"high","fail","metadata","Missing title"');
  });

  it('quotes every cell and doubles embedded quotes', () => {
    const withQuote = structuredClone(report);
    withQuote.findings[0].title.en = 'He said "hi"';
    const out = toCsvFile(withQuote, 'en').content;
    expect(out).toContain('"He said ""hi"""');
  });

  it('neutralises spreadsheet formula injection', () => {
    const risky = structuredClone(report);
    risky.findings[0].title.en = '=HYPERLINK("http://evil")';
    risky.findings[0].evidence = '+1+1';
    risky.findings[0].detail.en = '@SUM(A1)';
    const out = toCsvFile(risky, 'en').content;
    expect(out).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(out).toContain(`"'+1+1"`);
    expect(out).toContain(`"'@SUM(A1)"`);
  });

  it('uses CRLF and produces a stable file name', () => {
    const file = toCsvFile(report, 'en');
    expect(file.filename).toMatch(/^linkmedic-example\.com-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.csv$/);
    expect(file.content.includes('\r\n')).toBe(true);
  });

  it('localises the finding text', () => {
    expect(toCsvFile(report, 'zh').content).toContain('缺少标题');
    expect(toCsvFile(report, 'en').content).toContain('Missing title');
  });

  it('appends a link table only when links were checked', () => {
    expect(toCsvFile(report, 'en').content).not.toContain('link_url');
    const withLinks = structuredClone(report);
    withLinks.links.checked = [
      {
        url: 'https://example.com/a',
        text: 'a',
        status: 404,
        ok: false,
        finalUrl: null,
        redirected: false,
        durationMs: 12,
        error: null,
      },
    ];
    expect(toCsvFile(withLinks, 'en').content).toContain('"link_url","link_text","status"');
  });
});

describe('JSON export', () => {
  it('round-trips the whole report', () => {
    const file = toJsonFile(report);
    expect(file.mime).toBe('application/json');
    expect(JSON.parse(file.content)).toEqual(report);
  });
});

describe('plain-text export', () => {
  it('includes the score, findings and recommendations', () => {
    const text = toPlainText(report, 'en');
    expect(text).toContain('Health: 71/100 (C)');
    expect(text).toContain('[HIGH] Missing title');
    expect(text).toContain('Recommendation: Do this');
    expect(text).toContain('Evidence: line1 | line2');
  });

  it('switches language', () => {
    expect(toPlainText(report, 'zh')).toContain('缺少标题');
  });
});

describe('history', () => {
  const storage = new Map<string, string>();

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  });

  it('prepends new entries and de-duplicates by report id', () => {
    let entries: HistoryEntry[] = [];
    entries = addHistoryEntry(entries, report);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(report.id);
    expect(entries[0].issues).toBe(1);

    entries = addHistoryEntry(entries, { ...report, id: 'second000000000000' });
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe('second000000000000');

    entries = addHistoryEntry(entries, report);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(report.id);
  });

  it('caps the stored history', () => {
    let entries: HistoryEntry[] = [];
    for (let i = 0; i < 30; i++) {
      entries = addHistoryEntry(entries, { ...report, id: `id${String(i).padStart(16, '0')}` });
    }
    expect(entries.length).toBeLessThanOrEqual(12);
  });
});

describe('formatting helpers', () => {
  it('formats durations', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(42)).toBe('42ms');
    expect(formatMs(1500)).toBe('1.50s');
    expect(formatMs(15300)).toBe('15.3s');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(2048)).toBe('2.0KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00MB');
    expect(formatBytes(null)).toBe('—');
  });

  it('builds compact host labels', () => {
    expect(hostLabel('https://example.com/')).toBe('example.com');
    expect(hostLabel('https://example.com/a/b')).toBe('example.com/a/b');
    expect(hostLabel('not a url')).toBe('not a url');
  });

  it('truncates long URLs', () => {
    expect(shortUrl('https://example.com/short')).toBe('https://example.com/short');
    expect(shortUrl('x'.repeat(80), 10)).toHaveLength(10);
  });
});
