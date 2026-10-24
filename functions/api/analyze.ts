import { EdgeTransport } from '../../shared/transport/edge';
import { MAX_LINK_CHECK_LIMIT, runDiagnostics, DEFAULT_OPTIONS } from '../../shared/core/diagnostics';
import { apiError, clientKey, json, rateLimit, readJson } from '../lib/http';
import type { Env } from '../lib/env';

interface AnalyzeBody {
  url?: unknown;
  linkCheckLimit?: unknown;
  sameOriginLinksOnly?: unknown;
}

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context;

  const limit = clampInt(env.LINKMEDIC_RATE_LIMIT, 20, 1, 600);
  const rl = await rateLimit(env, clientKey(request), limit, 60);
  if (!rl.allowed) {
    return apiError(
      'rate_limited',
      `Too many diagnoses from this address. Try again in ${rl.retryAfter}s.`,
      429,
      rl.retryAfter,
    );
  }

  let body: AnalyzeBody;
  try {
    body = await readJson<AnalyzeBody>(request);
  } catch (err) {
    const message = (err as Error).message;
    if (message === 'payload_too_large') return apiError('payload_too_large', 'The request body is too large.', 413);
    return apiError('invalid_json', 'The request body must be JSON: {"url": "https://example.com"}', 400);
  }

  if (typeof body.url !== 'string') {
    return apiError('missing_url', 'Provide a "url" field containing the address to diagnose.', 400);
  }

  const maxLinks = clampInt(env.LINKMEDIC_MAX_LINKS, MAX_LINK_CHECK_LIMIT, 0, MAX_LINK_CHECK_LIMIT);
  const linkCheckLimit =
    body.linkCheckLimit === undefined
      ? Math.min(10, maxLinks)
      : clampInt(body.linkCheckLimit, Math.min(10, maxLinks), 0, maxLinks);
  const sameOriginLinksOnly = body.sameOriginLinksOnly === true;

  const transport = new EdgeTransport();

  try {
    const { report, error } = await runDiagnostics(transport, body.url, {
      linkCheckLimit,
      sameOriginLinksOnly,
      // The Workers free plan allows 10ms CPU per request but wall-clock waits do
      // not consume CPU; we keep the wall clock under the platform limit anyway.
      budgetMs: 24_000,
      pageTimeoutMs: 12_000,
      linkTimeoutMs: 6_000,
      linkConcurrency: 5,
      maxPageBytes: DEFAULT_OPTIONS.maxPageBytes,
    });

    if (error) {
      // Input problems are a 422 with the report attached, so the UI can show the
      // same finding layout it uses for real diagnoses.
      return json({ report, error: { code: error.code, message: error.message } }, { status: 422 });
    }

    return json(
      { report },
      {
        headers: {
          'x-ratelimit-limit': String(limit),
          'x-ratelimit-remaining': String(rl.remaining),
          'x-ratelimit-enforced': String(rl.enforced),
        },
      },
    );
  } catch (err) {
    // Never leak stack traces or internal detail to the client.
    console.error('analyze_failed', (err as Error)?.name ?? 'Error');
    return apiError('internal_error', 'The diagnosis failed unexpectedly. Please try again.', 500);
  }
};

export const onRequestGet = async (): Promise<Response> =>
  apiError('method_not_allowed', 'Use POST with a JSON body: {"url": "https://example.com"}', 405);

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
