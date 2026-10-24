import type { CertificateInfo } from './types';

export interface RequestOptions {
  method: 'GET' | 'HEAD';
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  acceptLanguage?: string;
}

export interface HopResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyBytes: number;
  truncated: boolean;
  durationMs: number;
  ttfbMs: number | null;
  ip: string | null;
  certificate: CertificateInfo | null;
  /** transport-level failure (timeout, TLS, DNS, blocked), already sanitised */
  error: { code: string; message: string } | null;
}

/**
 * A transport owns *how* bytes are fetched. The diagnostics engine only talks to
 * this interface, which keeps the SSRF policy in one place and lets the same
 * engine run on the edge (fetch) and on Node (pinned sockets).
 */
export interface Transport {
  readonly runtime: 'cloudflare-workers' | 'node';
  readonly kind: 'edge-fetch' | 'node-socket';
  /** true when the connection is guaranteed to go to the IP we validated */
  readonly ipPinning: boolean;
  /** true when leaf certificate subject/issuer/expiry can be read */
  readonly certificateDetails: boolean;
  resolve(hostname: string): Promise<{ address: string; family: 4 | 6 }[]>;
  request(url: string, opts: RequestOptions): Promise<HopResult>;
}

/** Sanitised, user-facing transport failure. */
export class TransportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

/**
 * Errors are shown to the user, so they must never contain a stack trace, a
 * filesystem path or a resolved private IP.
 */
export function sanitizeMessage(input: unknown): string {
  const raw = input instanceof Error ? input.message : String(input ?? '');
  const cleaned = raw
    .replace(/\[?\b(?:\d{1,3}\.){3}\d{1,3}\b\]?/g, '[redacted-ip]')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return 'The request failed for an unknown reason.';
  return cleaned.slice(0, 200);
}
