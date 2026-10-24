#!/usr/bin/env node
/**
 * LinkMedic self-host server.
 *
 * Serves the built SPA from `dist/` and exposes the same `/api/*` contract as the
 * Cloudflare deployment, but backed by NodeTransport: connections are pinned to
 * the IP validated by the SSRF guard and full certificate details are readable.
 *
 *   node server/index.mjs            # http://127.0.0.1:8787
 *   PORT=8080 node server/index.mjs
 *
 * This file is plain JavaScript (not compiled) and imports the TypeScript core
 * through tsx-less dynamic transpilation? No — it imports the *built* bundle, so
 * run `npm run build:server` first. See README "Self-hosting".
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const LINK_LIMIT_DEFAULT = Number(process.env.LINKMEDIC_RATE_LIMIT ?? 30);
const MAX_LINKS = Number(process.env.LINKMEDIC_MAX_LINKS ?? 25);
const WINDOW_MS = 60_000;

async function loadBundle(relativePath) {
  try {
    return await import(pathToFileURL(join(ROOT, relativePath)).href);
  } catch (err) {
    console.error(`Cannot load ${relativePath}: ${err.message}`);
    console.error('Run `npm run build:server` first.');
    process.exit(1);
  }
}

const { NodeTransport } = await loadBundle('build/server.js');
const core = await loadBundle('build/core.js');

const transport = new NodeTransport();
const buckets = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
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

function sendJson(res, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(payload);
}

function clientIp(req) {
  return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}

function rateLimited(ip) {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || now > bucket.reset) {
    buckets.set(ip, { count: 1, reset: now + WINDOW_MS });
    return { limited: false, remaining: LINK_LIMIT_DEFAULT - 1 };
  }
  if (bucket.count >= LINK_LIMIT_DEFAULT) {
    return { limited: true, retryAfter: Math.ceil((bucket.reset - now) / 1000), remaining: 0 };
  }
  bucket.count += 1;
  return { limited: false, remaining: LINK_LIMIT_DEFAULT - bucket.count };
}

async function readBody(req, maxBytes = 8192) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('payload_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleAnalyze(req, res) {
  const limit = rateLimited(clientIp(req));
  if (limit.limited) {
    sendJson(
      res,
      429,
      {
        error: {
          code: 'rate_limited',
          message: `Too many diagnoses. Retry in ${limit.retryAfter}s.`,
          retryAfter: limit.retryAfter,
        },
      },
      { 'retry-after': String(limit.retryAfter) },
    );
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    const code = err.message === 'payload_too_large' ? 413 : 400;
    sendJson(res, code, {
      error: {
        code: err.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json',
        message:
          err.message === 'payload_too_large'
            ? 'The request body is too large.'
            : 'The body must be JSON: {"url":"https://example.com"}',
      },
    });
    return;
  }

  if (typeof body.url !== 'string') {
    sendJson(res, 400, { error: { code: 'missing_url', message: 'Provide a "url" field.' } });
    return;
  }

  const { runDiagnostics, DEFAULT_OPTIONS } = core;
  const linkCheckLimit = Math.max(0, Math.min(MAX_LINKS, Number(body.linkCheckLimit ?? 10) || 0));

  try {
    const { report, error } = await runDiagnostics(transport, body.url, {
      linkCheckLimit,
      sameOriginLinksOnly: body.sameOriginLinksOnly === true,
      budgetMs: Number(process.env.LINKMEDIC_BUDGET_MS ?? 30_000),
      pageTimeoutMs: DEFAULT_OPTIONS.pageTimeoutMs,
      linkTimeoutMs: DEFAULT_OPTIONS.linkTimeoutMs,
      linkConcurrency: DEFAULT_OPTIONS.linkConcurrency,
      maxPageBytes: DEFAULT_OPTIONS.maxPageBytes,
    });
    sendJson(res, error ? 422 : 200, error ? { report, error } : { report }, {
      'x-ratelimit-limit': String(LINK_LIMIT_DEFAULT),
      'x-ratelimit-remaining': String(limit.remaining),
    });
  } catch (err) {
    console.error('analyze_failed', err?.name ?? 'Error');
    sendJson(res, 500, { error: { code: 'internal_error', message: 'The diagnosis failed unexpectedly.' } });
  }
}

function health(res) {
  sendJson(res, 200, {
    status: 'ok',
    service: 'linkmedic',
    version: '1.0.0',
    runtime: 'node',
    capabilities: {
      ipPinning: true,
      certificateDetails: true,
      certificateVerdict: true,
      linkChecking: true,
      history: false,
      sameOriginFilter: true,
    },
    limits: { rateLimitPerMinute: LINK_LIMIT_DEFAULT, maxLinks: MAX_LINKS, rateLimitEnforced: true },
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const candidate = normalize(join(DIST, pathname));
  // Path traversal guard: the resolved file must stay inside dist/.
  if (!candidate.startsWith(DIST)) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end('Forbidden');
    return;
  }

  try {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(candidate);
    const type = MIME[extname(candidate)] ?? 'application/octet-stream';
    const immutable = pathname.startsWith('/assets/');
    res.writeHead(200, {
      'content-type': type,
      'content-length': data.length,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  } catch {
    // SPA fallback so deep links such as /#/r/... still boot the app.
    try {
      const data = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        ...SECURITY_HEADERS,
      });
      res.end(data);
    } catch {
      res.writeHead(404, SECURITY_HEADERS);
      res.end('Not found');
    }
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/api/health') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Use GET.' } });
    return health(res);
  }
  if (url.pathname === '/api/analyze') {
    if (req.method !== 'POST')
      return sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Use POST.' } });
    return handleAnalyze(req, res).catch(() =>
      sendJson(res, 500, { error: { code: 'internal_error', message: 'Unexpected failure.' } }),
    );
  }
  if (url.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: { code: 'not_found', message: 'Unknown endpoint.' } });
  }
  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`LinkMedic (node) listening on http://${HOST}:${PORT}`);
  console.log(`Serving ${DIST}`);
});
