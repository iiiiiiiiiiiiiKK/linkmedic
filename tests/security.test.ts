import { describe, expect, it, vi } from 'vitest';
import { sanitizeMessage } from '../shared/core/transport';
import {
  apiError,
  clientKey,
  json,
  rateLimit,
  readJson,
  SECURITY_HEADERS,
  withSecurityHeaders,
} from '../functions/lib/http';
import type { Env } from '../functions/lib/env';

describe('sanitizeMessage', () => {
  it('redacts IPv4 addresses from transport errors', () => {
    const message = sanitizeMessage(new Error('connect ECONNREFUSED 10.1.2.3:443'));
    expect(message).not.toMatch(/\b10\.1\.2\.3\b/);
    expect(message).toContain('[redacted-ip]');
  });

  it('never returns a stack trace', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at secret/path/file.ts:1:1';
    const message = sanitizeMessage(error);
    expect(message).not.toContain('at secret/path');
  });

  it('collapses whitespace and caps the length', () => {
    const message = sanitizeMessage(`a\n\n\nb   c ${'x'.repeat(500)}`);
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThanOrEqual(200);
  });

  it('falls back to a generic message for empty input', () => {
    expect(sanitizeMessage('')).toMatch(/unknown reason/i);
    expect(sanitizeMessage(null)).toMatch(/unknown reason/i);
  });

  it('does not echo a private URL path', () => {
    expect(sanitizeMessage(new Error('ENOTFOUND internal.corp'))).toBe('ENOTFOUND internal.corp');
  });
});

describe('security headers', () => {
  it('blocks framing, sniffing and inline script', () => {
    expect(SECURITY_HEADERS['x-frame-options']).toBe('DENY');
    expect(SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(SECURITY_HEADERS['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(SECURITY_HEADERS['content-security-policy']).toContain("object-src 'none'");
    expect(SECURITY_HEADERS['content-security-policy']).toContain("script-src 'self'");
    // Inline styles are required by React's style prop usages; scripts are not.
    expect(SECURITY_HEADERS['content-security-policy']).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(SECURITY_HEADERS['strict-transport-security']).toContain('max-age=');
    expect(SECURITY_HEADERS['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('applies headers to an existing response without dropping the body', async () => {
    const response = withSecurityHeaders(new Response('hello', { status: 201 }));
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('hello');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('json helper', () => {
  it('sets no-store and a JSON content type', () => {
    const response = json({ ok: true });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('carries retry-after for rate limiting', () => {
    const response = apiError('rate_limited', 'slow down', 429, 42);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
  });
});

describe('clientKey', () => {
  it('prefers cf-connecting-ip and never returns undefined', () => {
    const request = new Request('https://x.test/', { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    expect(clientKey(request)).toBe('203.0.113.9');

    const forwarded = new Request('https://x.test/', {
      headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' },
    });
    expect(clientKey(forwarded)).toBe('198.51.100.1');

    expect(clientKey(new Request('https://x.test/'))).toBe('unknown');
  });
});

describe('readJson', () => {
  it('parses a valid body', async () => {
    const request = new Request('https://x.test/', { method: 'POST', body: JSON.stringify({ url: 'a' }) });
    await expect(readJson<{ url: string }>(request)).resolves.toEqual({ url: 'a' });
  });

  it('rejects oversized bodies before parsing', async () => {
    const request = new Request('https://x.test/', {
      method: 'POST',
      body: JSON.stringify({ url: 'x'.repeat(20_000) }),
    });
    await expect(readJson(request)).rejects.toThrow(/payload_too_large|invalid_json/);
  });

  it('rejects broken JSON', async () => {
    const request = new Request('https://x.test/', { method: 'POST', body: '{oops' });
    await expect(readJson(request)).rejects.toThrow('invalid_json');
  });
});

describe('rateLimit', () => {
  function fakeKv() {
    const store = new Map<string, string>();
    return {
      store,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    } as unknown as KVNamespace & { store: Map<string, string> };
  }

  it('allows requests up to the limit then refuses', async () => {
    const kv = fakeKv();
    const env = { LINKMEDIC_KV: kv } as Env;
    for (let i = 0; i < 3; i++) {
      const result = await rateLimit(env, 'ip-1', 3, 60);
      expect(result.allowed).toBe(true);
      expect(result.enforced).toBe(true);
    }
    const blocked = await rateLimit(env, 'ip-1', 3, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it('tracks separate clients independently', async () => {
    const env = { LINKMEDIC_KV: fakeKv() } as Env;
    await rateLimit(env, 'a', 1, 60);
    expect((await rateLimit(env, 'a', 1, 60)).allowed).toBe(false);
    expect((await rateLimit(env, 'b', 1, 60)).allowed).toBe(true);
  });

  it('fails open but reports that it is not enforced when KV is missing', async () => {
    const result = await rateLimit({} as Env, 'ip', 1, 60);
    expect(result.allowed).toBe(true);
    expect(result.enforced).toBe(false);
  });

  it('fails open when the store throws', async () => {
    const env = {
      LINKMEDIC_KV: {
        get: async () => {
          throw new Error('kv down');
        },
        put: async () => undefined,
      } as unknown as KVNamespace,
    } as Env;
    const result = await rateLimit(env, 'ip', 1, 60);
    expect(result.allowed).toBe(true);
    expect(result.enforced).toBe(false);
  });
});
