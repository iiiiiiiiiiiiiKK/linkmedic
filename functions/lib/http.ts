/**
 * Shared edge API plumbing: request parsing, rate limiting, security headers and
 * error shaping. Kept in one module so every endpoint behaves identically.
 */

import type { Env } from './env';

export interface JsonInit {
  status?: number;
  headers?: Record<string, string>;
  retryAfter?: number;
}

export function json(body: unknown, init: JsonInit = {}): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // API responses carry the same hardening as the shell: this is cheap defence
    // in depth (a JSON body is never rendered, but a misconfigured proxy might
    // still sniff or frame it).
    ...SECURITY_HEADERS,
    ...init.headers,
  };
  if (init.retryAfter !== undefined) headers['retry-after'] = String(init.retryAfter);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

export function apiError(code: string, message: string, status = 400, retryAfter?: number): Response {
  return json(
    { error: { code, message, ...(retryAfter !== undefined ? { retryAfter } : {}) } },
    { status, retryAfter },
  );
}

/** Decode JSON with a hard size cap so a large body cannot burn the CPU budget. */
export async function readJson<T>(request: Request, maxBytes = 8 * 1024): Promise<T> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > maxBytes) throw new Error('payload_too_large');
  const text = await request.text();
  if (text.length > maxBytes) throw new Error('payload_too_large');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('invalid_json');
  }
}

/** Best-effort client identity for rate limiting (Cloudflare always sets this). */
export function clientKey(request: Request): string {
  const ip =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';
  return ip.slice(0, 64);
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
  /** false when the counter store is unavailable (fail-open, but flagged) */
  enforced: boolean;
}

/**
 * Fixed-window rate limit backed by KV.
 *
 * KV is eventually consistent, so this is an abuse *brake*, not a hard quota. If
 * the store fails we fail open and say so in the response metadata — silently
 * pretending to enforce a limit would be worse than admitting it is degraded.
 */
export async function rateLimit(env: Env, key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const store = env.LINKMEDIC_KV;
  if (!store) {
    return { allowed: true, remaining: limit, retryAfter: 0, enforced: false };
  }
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const storageKey = `rl:${key}:${bucket}`;
  try {
    const current = Number((await store.get(storageKey)) ?? '0');
    if (current >= limit) {
      const resetIn = (bucket + 1) * windowSeconds * 1000 - Date.now();
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil(resetIn / 1000)),
        enforced: true,
      };
    }
    await store.put(storageKey, String(current + 1), { expirationTtl: windowSeconds + 30 });
    return { allowed: true, remaining: limit - current - 1, retryAfter: 0, enforced: true };
  } catch {
    return { allowed: true, remaining: limit, retryAfter: 0, enforced: false };
  }
}

/** Headers applied to every response, including static assets. */
export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'cross-origin-opener-policy': 'same-origin',
  // The SPA only loads its own bundle; no inline scripts, no remote frames.
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '),
};

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
