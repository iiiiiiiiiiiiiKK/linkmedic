import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { classifyIp, isIpLiteral } from '../core/ip';
import type { CertificateInfo } from '../core/types';
import { sanitizeMessage, type HopResult, type RequestOptions, type Transport } from '../core/transport';

/**
 * Node.js transport — the strict reference implementation, used by the bundled
 * self-host server and by the test suite.
 *
 * Unlike the edge transport this one *pins* the connection: the host is resolved
 * once, every answer is validated, and the socket is forced to that exact IP via
 * a custom `lookup`. A DNS-rebinding attacker cannot swap the record between the
 * check and the connect, because the connect never asks the resolver again.
 * Because we own the socket we can also read the leaf certificate.
 */
export class NodeTransport implements Transport {
  readonly runtime = 'node' as const;
  readonly kind = 'node-socket' as const;
  readonly ipPinning = true;
  readonly certificateDetails = true;

  async resolve(hostname: string): Promise<{ address: string; family: 4 | 6 }[]> {
    if (isIpLiteral(hostname)) {
      const verdict = classifyIp(hostname);
      return verdict ? [{ address: verdict.normalized, family: verdict.version }] : [];
    }
    const [v4, v6] = await Promise.all([
      dns.promises.resolve4(hostname).catch(() => [] as string[]),
      dns.promises.resolve6(hostname).catch(() => [] as string[]),
    ]);
    return [
      ...v4.map((address) => ({ address, family: 4 as const })),
      ...v6.map((address) => ({ address, family: 6 as const })),
    ];
  }

  async request(url: string, opts: RequestOptions): Promise<HopResult> {
    const started = Date.now();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return failure(started, 'invalid_url', 'The URL could not be parsed.');
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    let pinned: { address: string; family: 4 | 6 };
    try {
      const addresses = await this.resolve(hostname);
      const chosen = addresses.find((entry) => classifyIp(entry.address)?.public);
      if (!chosen) {
        return failure(started, 'blocked_target', 'That host does not resolve to a publicly routable address.');
      }
      pinned = chosen;
    } catch (err) {
      return failure(started, 'dns_error', sanitizeMessage(err));
    }

    return new Promise<HopResult>((resolve) => {
      let settled = false;
      let ttfb: number | null = null;
      const finish = (result: HopResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const isHttps = parsed.protocol === 'https:';
      const lookup = ((_host: string, _options: unknown, callback: unknown) => {
        (callback as (e: null, address: string, family: number) => void)(null, pinned.address, pinned.family);
      }) as unknown as net.LookupFunction;

      const requestOptions: https.RequestOptions = {
        protocol: parsed.protocol,
        host: pinned.address,
        port: parsed.port === '' ? (isHttps ? 443 : 80) : Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method: opts.method,
        timeout: opts.timeoutMs,
        agent: false,
        lookup,
        headers: {
          host: parsed.host,
          'user-agent': opts.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': opts.acceptLanguage ?? 'en-US,en;q=0.9',
          'accept-encoding': 'gzip, deflate, br',
          connection: 'close',
        },
      };
      if (isHttps) {
        requestOptions.servername = hostname;
        // The chain is validated by us (see certificateOf) so a broken certificate
        // can be *reported* instead of merely failing the whole request.
        requestOptions.rejectUnauthorized = false;
      }

      const req = (isHttps ? https : http).request(requestOptions, (res) => {
        ttfb = Date.now() - started;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
        }
        const certificate = isHttps ? certificateOf(res.socket) : null;

        if (opts.method === 'HEAD') {
          res.resume();
          finish({
            status: res.statusCode ?? 0,
            headers,
            body: '',
            bodyBytes: 0,
            truncated: false,
            durationMs: Date.now() - started,
            ttfbMs: ttfb,
            ip: pinned.address,
            certificate,
            error: null,
          });
          res.destroy();
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        let done = false;

        const settle = () => {
          if (done) return;
          done = true;
          const raw = Buffer.concat(chunks, total);
          const decoded = decodeBody(raw, headers['content-encoding'], opts.maxBytes);
          finish({
            status: res.statusCode ?? 0,
            headers,
            body: decoded.text,
            bodyBytes: decoded.bytes,
            truncated: truncated || decoded.truncated,
            durationMs: Date.now() - started,
            ttfbMs: ttfb,
            ip: pinned.address,
            certificate,
            error: null,
          });
        };

        res.on('data', (chunk: Buffer) => {
          const room = opts.maxBytes - total;
          if (room <= 0) {
            truncated = true;
            res.destroy();
            settle();
            return;
          }
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, room));
            total = opts.maxBytes;
            truncated = true;
            res.destroy();
            settle();
            return;
          }
          chunks.push(chunk);
          total += chunk.length;
        });
        res.on('end', settle);
        res.on('close', settle);
        res.on('error', () => settle());
      });

      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err: NodeJS.ErrnoException) => {
        const code = err.code ?? 'network_error';
        const tlsFailure = /CERT|SSL|TLS|EPROTO|ALTNAME/i.test(String(code)) || /certificate/i.test(err.message);
        const message =
          code === 'ETIMEDOUT' || err.message === 'timeout'
            ? `The request timed out after ${Math.round(opts.timeoutMs / 1000)}s.`
            : tlsFailure
              ? 'The TLS handshake failed: the certificate is invalid, expired or issued for another hostname.'
              : sanitizeMessage(err);
        const result = failure(started, code === 'ETIMEDOUT' ? 'timeout' : tlsFailure ? 'tls_error' : code, message);
        finish({
          ...result,
          ip: pinned.address,
          certificate: tlsFailure ? { valid: false, source: 'tls-inspection', error: message } : null,
        });
      });

      req.end();
    });
  }
}

/**
 * Decode a compressed response body.
 *
 * We ask for `accept-encoding: gzip, deflate, br`, so the bytes on the wire are
 * compressed while `content-length` counts compressed bytes. HTML checks must run
 * on the decoded document, so decompress here and report the decoded size (which
 * is what the "response size" panel means).
 */
function decodeBody(
  raw: Buffer,
  encoding: string | undefined,
  maxBytes: number,
): { text: string; bytes: number; truncated: boolean } {
  const kind = (encoding ?? '').toLowerCase().trim();
  if (raw.length === 0 || kind === '' || kind === 'identity') {
    return { text: raw.toString('utf8'), bytes: raw.length, truncated: false };
  }
  try {
    let decoded: Buffer;
    if (kind.includes('br')) decoded = zlib.brotliDecompressSync(raw);
    else if (kind.includes('gzip') || kind.includes('x-gzip')) decoded = zlib.gunzipSync(raw);
    else if (kind.includes('deflate')) decoded = zlib.inflateSync(raw);
    else if (kind.includes('zstd')) decoded = zlib.zstdDecompressSync(raw);
    else return { text: raw.toString('utf8'), bytes: raw.length, truncated: false };

    const truncated = decoded.length > maxBytes;
    const sliced = truncated ? decoded.subarray(0, maxBytes) : decoded;
    return { text: sliced.toString('utf8'), bytes: sliced.length, truncated };
  } catch {
    // A partially-read (truncated) compressed stream cannot be inflated; fall back
    // to the raw bytes so the caller still gets whatever text is readable.
    return { text: raw.toString('utf8'), bytes: raw.length, truncated: true };
  }
}

function failure(started: number, code: string, message: string): HopResult {
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

function humanizeCertError(code: string): string {
  if (/CERT_HAS_EXPIRED|EXPIRED/i.test(code)) return 'The certificate has expired.';
  if (/SELF_SIGNED/i.test(code)) return 'The certificate is self-signed and not trusted.';
  if (/ALTNAME|HOSTNAME/i.test(code)) return 'The certificate is not valid for this hostname.';
  if (/UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|DEPTH_ZERO/i.test(code)) {
    return 'The certificate chain could not be verified (unknown or missing issuer).';
  }
  if (/REVOKED/i.test(code)) return 'The certificate has been revoked.';
  return `Certificate validation failed (${code}).`;
}

function certificateOf(socket: unknown): CertificateInfo | null {
  const tlsSocket = socket as tls.TLSSocket | undefined;
  if (!tlsSocket || typeof tlsSocket.getPeerCertificate !== 'function') return null;
  let cert: tls.PeerCertificate;
  try {
    cert = tlsSocket.getPeerCertificate(false);
  } catch {
    return null;
  }
  if (!cert || Object.keys(cert).length === 0) return null;

  const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
  const daysRemaining =
    validTo && !Number.isNaN(validTo.getTime()) ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000) : undefined;

  const info: CertificateInfo = {
    valid: tlsSocket.authorized === true,
    source: 'tls-inspection',
    subject: cert.subject?.CN ?? undefined,
    issuer: cert.issuer?.CN ?? cert.issuer?.O ?? undefined,
    validFrom: cert.valid_from ?? undefined,
    validTo: cert.valid_to ?? undefined,
    daysRemaining,
    protocol: typeof tlsSocket.getProtocol === 'function' ? (tlsSocket.getProtocol() ?? undefined) : undefined,
    fingerprint: cert.fingerprint256 ?? cert.fingerprint ?? undefined,
  };
  if (info.valid === false && tlsSocket.authorizationError) {
    info.error = humanizeCertError(String(tlsSocket.authorizationError));
  }
  return info;
}
