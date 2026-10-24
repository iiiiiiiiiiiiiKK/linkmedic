import { classifyIp, isIpLiteral } from '../core/ip';
import type { CertificateInfo } from '../core/types';
import { sanitizeMessage, type HopResult, type RequestOptions, type Transport } from '../core/transport';

/**
 * Cloudflare Workers / Pages Functions transport.
 *
 * Security model on this runtime:
 *  1. Every host is resolved through `node:dns` (or DoH as a fallback) and each
 *     answer must classify as publicly routable before we connect.
 *  2. The Cloudflare edge itself refuses to open connections to private,
 *     loopback, link-local and metadata addresses (verified: `fetch` to
 *     127.0.0.1 returns a 1003 "direct IP access not allowed" error and a
 *     hostname resolving to 127.0.0.1 returns a 1016 DNS error), so a
 *     rebinding race cannot reach the internal network either.
 *  3. Redirects are never followed by `fetch`; the engine re-validates each hop.
 *
 * What this transport cannot do (reported as `null`, never guessed):
 *  - read leaf certificate subject/issuer/expiry. The edge only surfaces a
 *    boolean "the origin certificate was rejected" signal (HTTP 526).
 */

const TLS_REJECTION_HINTS = [
  'certificate',
  'cert_has_expired',
  'self_signed',
  'altname',
  'tls',
  'unable to verify',
  'ssl',
];

function isTlsRejection(message: string): boolean {
  const lower = message.toLowerCase();
  return TLS_REJECTION_HINTS.some((hint) => lower.includes(hint));
}

export class EdgeTransport implements Transport {
  readonly runtime = 'cloudflare-workers' as const;
  readonly kind = 'edge-fetch' as const;
  /** The edge re-resolves DNS itself, so the connection cannot be pinned to our answer. */
  readonly ipPinning = false;
  readonly certificateDetails = false;

  async resolve(hostname: string): Promise<{ address: string; family: 4 | 6 }[]> {
    try {
      const dns = await import('node:dns');
      const [v4, v6] = await Promise.all([
        dns.promises.resolve4(hostname).catch(() => [] as string[]),
        dns.promises.resolve6(hostname).catch(() => [] as string[]),
      ]);
      const out: { address: string; family: 4 | 6 }[] = [
        ...v4.map((address) => ({ address, family: 4 as const })),
        ...v6.map((address) => ({ address, family: 6 as const })),
      ];
      if (out.length > 0) return out;
    } catch {
      /* fall through to DoH */
    }
    return this.resolveViaDoh(hostname);
  }

  /** DNS-over-HTTPS fallback so a resolver hiccup does not look like a dead site. */
  private async resolveViaDoh(hostname: string): Promise<{ address: string; family: 4 | 6 }[]> {
    const out: { address: string; family: 4 | 6 }[] = [];
    for (const type of ['A', 'AAAA'] as const) {
      try {
        const res = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
          { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) },
        );
        if (!res.ok) continue;
        const json = (await res.json()) as { Answer?: { type: number; data: string }[] };
        for (const answer of json.Answer ?? []) {
          const expected = type === 'A' ? 1 : 28;
          if (answer.type !== expected) continue;
          if (classifyIp(answer.data)) out.push({ address: answer.data, family: type === 'A' ? 4 : 6 });
        }
      } catch {
        /* ignore and report the failure upstream */
      }
    }
    return out;
  }

  async request(url: string, opts: RequestOptions): Promise<HopResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    // Defence in depth: refuse to even try a literal private address.
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^\[|\]$/g, '');
      if (isIpLiteral(host)) {
        const verdict = classifyIp(host);
        if (!verdict?.public) {
          return this.failure(started, 'blocked_target', 'That address is not publicly routable.');
        }
      }
    } catch {
      return this.failure(started, 'invalid_url', 'The URL could not be parsed.');
    }

    try {
      const response = await fetch(url, {
        method: opts.method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': opts.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': opts.acceptLanguage ?? 'en-US,en;q=0.9',
          'accept-encoding': 'gzip, deflate, br',
        },
      });
      const ttfb = Date.now() - started;

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      // Cloudflare signals "the origin's certificate was rejected" as 526 with a
      // tiny `error code: 526` body. That is the only certificate signal the
      // edge exposes, so we report validity without inventing details.
      const bodyText = await this.readCapped(response, opts.maxBytes, opts.method === 'HEAD');
      const certificate = this.certificateFromResponse(url, response.status, headers, bodyText.text);

      return {
        status: response.status,
        headers,
        body: bodyText.text,
        bodyBytes: bodyText.bytes,
        truncated: bodyText.truncated,
        durationMs: Date.now() - started,
        ttfbMs: ttfb,
        ip: null,
        certificate,
        error: null,
      };
    } catch (err) {
      const message = sanitizeMessage(err);
      const code = controller.signal.aborted ? 'timeout' : isTlsRejection(message) ? 'tls_error' : 'network_error';
      const friendly =
        code === 'timeout'
          ? `The request timed out after ${Math.round(opts.timeoutMs / 1000)}s.`
          : code === 'tls_error'
            ? 'The TLS handshake failed. The certificate is invalid, expired or issued for a different hostname.'
            : message;
      const certificate: CertificateInfo | null =
        code === 'tls_error'
          ? { valid: false, source: 'edge-validation', error: 'TLS handshake rejected by the network edge.' }
          : null;
      return {
        ...this.failure(started, code, friendly),
        certificate,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private certificateFromResponse(
    url: string,
    status: number,
    headers: Record<string, string>,
    body: string,
  ): CertificateInfo | null {
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      return null;
    }
    if (protocol !== 'https:') return null;

    const isEdgeRejection = status === 526 || (headers.server === 'cloudflare' && body.trim() === 'error code: 526');
    if (isEdgeRejection) {
      return {
        valid: false,
        source: 'edge-validation',
        error:
          'The origin certificate was rejected during the TLS handshake (expired, self-signed or hostname mismatch).',
      };
    }
    return {
      valid: true,
      source: 'edge-validation',
      error: undefined,
      protocol: headers['cf-alt-svc'] ?? undefined,
    };
  }

  private async readCapped(
    response: Response,
    maxBytes: number,
    skipBody: boolean,
  ): Promise<{ text: string; bytes: number; truncated: boolean }> {
    if (skipBody || !response.body) return { text: '', bytes: 0, truncated: false };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const room = maxBytes - total;
        if (value.byteLength >= room) {
          chunks.push(value.subarray(0, room));
          total = maxBytes;
          truncated = true;
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* the body is already closed */
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: new TextDecoder('utf-8').decode(merged), bytes: total, truncated };
  }

  private failure(started: number, code: string, message: string): HopResult {
    return {
      status: 0,
      headers: {},
      body: '',
      bodyBytes: 0,
      truncated: false,
      durationMs: Date.now() - started,
      ttfbMs: null,
      ip: null,
      certificate: null,
      error: { code, message },
    };
  }
}
