import { classifyIp, isIpLiteral } from './ip';
import type { NormalizedTarget } from './types';

/** Ports we are willing to talk to. Anything else is refused as port scanning. */
export const ALLOWED_PORTS = new Set([80, 443]);

export class InputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}

/**
 * Turn whatever the user pasted into a canonical http(s) URL, or throw an
 * `InputError` with a machine-readable code (the UI maps codes to localised copy).
 *
 * This is the first of three SSRF gates: syntax + literal-address checks happen
 * here, DNS answers are checked in `resolveAndValidate`, and every redirect hop
 * goes back through both.
 */
export function normalizeUrl(raw: string): NormalizedTarget {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') throw new InputError('empty', 'Enter a URL to diagnose.');

  if (trimmed.length > 2048) {
    throw new InputError('too_long', 'That URL is too long (2048 characters max).');
  }
  // Reject whitespace and control characters before the URL parser normalises
  // them away. Written as a char-code scan so the intent (and eslint) is clear.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x20) {
      throw new InputError('invalid_characters', 'The URL contains spaces or control characters.');
    }
  }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  let candidate = trimmed;
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new InputError('unsupported_scheme', `Only http:// and https:// URLs can be checked (got "${scheme}:").`);
    }
  } else {
    candidate = `https://${trimmed}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new InputError('invalid_url', 'That does not look like a valid URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InputError('unsupported_scheme', 'Only http:// and https:// URLs can be checked.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new InputError('credentials_not_allowed', 'URLs with embedded credentials are not accepted.');
  }
  if (url.hostname === '') throw new InputError('missing_host', 'The URL is missing a hostname.');

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    host === 'metadata'
  ) {
    throw new InputError('blocked_target', 'Localhost and cloud-metadata hostnames are not allowed.');
  }
  if (!host.includes('.') && !isIpLiteral(host)) {
    throw new InputError('invalid_host', 'The hostname must be a fully qualified domain name or an IP address.');
  }

  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const port = url.port === '' ? defaultPort : Number(url.port);
  // The port is validated before the address so a scan attempt reports "blocked
  // port" instead of a vague target error. Either way the request never happens.
  if (!ALLOWED_PORTS.has(port)) {
    throw new InputError('blocked_port', 'Only the standard web ports (80 and 443) are allowed.');
  }

  if (isIpLiteral(host)) {
    const verdict = classifyIp(host);
    if (!verdict) throw new InputError('invalid_host', 'That IP address could not be parsed.');
    if (!verdict.public) {
      throw new InputError(
        'blocked_target',
        `That address is ${verdict.reason}; private, loopback, link-local and metadata targets are blocked.`,
      );
    }
  }

  url.hash = '';
  const path = url.pathname + url.search;

  return {
    requestedUrl: url.toString(),
    host,
    hostname: url.hostname,
    port,
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    path,
  };
}

/** Resolve a possibly-relative redirect target against the current URL. */
export function resolveLocation(current: string, location: string): string {
  const next = new URL(location, current);
  next.hash = '';
  return next.toString();
}

export function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return /text\/html|application\/xhtml\+xml/i.test(contentType);
}

/** Parse `charset=` from a Content-Type header. */
export function charsetFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const match = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType);
  return match ? match[1].toLowerCase() : null;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
