/**
 * IP address classification used by the SSRF guard.
 *
 * Every address that LinkMedic is willing to connect to must pass `classifyIp()`.
 * We are deliberately strict: if *any* address returned for a hostname is not a
 * globally routable unicast address, the whole host is rejected. This blocks
 * localhost, RFC1918, CGNAT, link-local, cloud metadata (169.254.169.254),
 * multicast, documentation, benchmark and reserved ranges, for both IPv4 and IPv6,
 * including IPv4-mapped / NAT64 / 6to4 / Teredo encodings of private addresses.
 */

export type IpVersion = 4 | 6;

export type IpVerdict =
  | { version: 4; public: true; normalized: string }
  | { version: 6; public: true; normalized: string }
  | { version: IpVersion; public: false; normalized: string; reason: string };

interface Range {
  /** first address, as a 32-bit unsigned integer */
  start: number;
  /** last address, as a 32-bit unsigned integer */
  end: number;
  reason: string;
}

const v4 = (a: number, b: number, c: number, d: number): number => ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;

const BLOCKED_V4: Range[] = [
  { start: v4(0, 0, 0, 0), end: v4(0, 255, 255, 255), reason: 'this-network' },
  { start: v4(10, 0, 0, 0), end: v4(10, 255, 255, 255), reason: 'private' },
  { start: v4(100, 64, 0, 0), end: v4(100, 127, 255, 255), reason: 'cgnat' },
  { start: v4(127, 0, 0, 0), end: v4(127, 255, 255, 255), reason: 'loopback' },
  { start: v4(169, 254, 0, 0), end: v4(169, 254, 255, 255), reason: 'link-local' },
  { start: v4(172, 16, 0, 0), end: v4(172, 31, 255, 255), reason: 'private' },
  { start: v4(192, 0, 0, 0), end: v4(192, 0, 0, 255), reason: 'ietf-protocol' },
  { start: v4(192, 0, 2, 0), end: v4(192, 0, 2, 255), reason: 'documentation' },
  { start: v4(192, 88, 99, 0), end: v4(192, 88, 99, 255), reason: '6to4-relay' },
  { start: v4(192, 168, 0, 0), end: v4(192, 168, 255, 255), reason: 'private' },
  { start: v4(198, 18, 0, 0), end: v4(198, 19, 255, 255), reason: 'benchmark' },
  { start: v4(198, 51, 100, 0), end: v4(198, 51, 100, 255), reason: 'documentation' },
  { start: v4(203, 0, 113, 0), end: v4(203, 0, 113, 255), reason: 'documentation' },
  { start: v4(224, 0, 0, 0), end: v4(239, 255, 255, 255), reason: 'multicast' },
  { start: v4(240, 0, 0, 0), end: v4(255, 255, 255, 255), reason: 'reserved' },
];

/** Parse a strict dotted-quad IPv4 address. Returns null for anything unusual. */
export function parseIpv4(input: string): number | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    // Reject leading zeros: `010` is ambiguous (octal in some resolvers).
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8) + n;
  }
  return value >>> 0;
}

export function formatIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/** Expand an IPv6 address into 8 hextets, or null when unparsable. */
export function parseIpv6(input: string): number[] | null {
  let text = input;
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (text.includes('%')) text = text.slice(0, text.indexOf('%')); // zone id
  if (!text.includes(':')) return null;

  let tail: number[] = [];
  // Embedded IPv4 (e.g. ::ffff:127.0.0.1)
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const parsed = parseIpv4(maybeV4);
    if (parsed === null) return null;
    tail = [parsed >>> 16, parsed & 0xffff];
    text = text.slice(0, lastColon + 1) + (text.slice(0, lastColon + 1).endsWith('::') ? '' : '');
    if (text.endsWith(':')) text = text.slice(0, -1);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const toHextets = (segment: string): number[] | null => {
    if (segment === '') return [];
    const out: number[] = [];
    for (const piece of segment.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };

  const head = toHextets(halves[0]);
  if (head === null) return null;
  const rest = halves.length === 2 ? toHextets(halves[1]) : [];
  if (rest === null) return null;

  const groups =
    halves.length === 2
      ? [...head, ...new Array(Math.max(0, 8 - head.length - rest.length - tail.length)).fill(0), ...rest, ...tail]
      : [...head, ...tail];
  if (groups.length !== 8) return null;
  return groups;
}

const inV6Prefix = (groups: number[], prefix: number[], bits: number): boolean => {
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((groups[i] & mask) !== (prefix[i] & mask)) return false;
    remaining -= take;
  }
  return true;
};

/**
 * Build a prefix from explicit 16-bit hextets. Each argument is one group, so
 * `prefix(0x2002)` means `2002::` and `prefix(0x2001, 0x0db8)` means `2001:db8::`.
 */
const prefix = (...groups: number[]): number[] => {
  const out = groups.map((group) => group & 0xffff);
  while (out.length < 8) out.push(0);
  return out.slice(0, 8);
};

const BLOCKED_V6: { prefix: number[]; bits: number; reason: string }[] = [
  { prefix: prefix(0x0000), bits: 128, reason: 'unspecified' },
  { prefix: prefix(0x0000), bits: 127, reason: 'loopback' },
  { prefix: prefix(0x0064, 0xff9b), bits: 96, reason: 'nat64' },
  { prefix: prefix(0x0100), bits: 64, reason: 'discard-only' },
  { prefix: prefix(0x2001, 0x0000), bits: 32, reason: 'teredo' },
  { prefix: prefix(0x2001, 0x0db8), bits: 32, reason: 'documentation' },
  { prefix: prefix(0x2002), bits: 16, reason: '6to4' },
  { prefix: prefix(0xfc00), bits: 7, reason: 'unique-local' },
  { prefix: prefix(0xfe80), bits: 10, reason: 'link-local' },
  { prefix: prefix(0xff00), bits: 8, reason: 'multicast' },
];

/** Normalised text form of an IPv6 address (RFC 5952-ish, good enough for reporting). */
export function formatIpv6(groups: number[]): string {
  const parts = groups.map((g) => g.toString(16));
  // compress the longest run of zero groups
  let bestStart = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; i++) {
    if (groups[i] !== 0) continue;
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestStart >= 0) {
    return `${parts.slice(0, bestStart).join(':')}::${parts.slice(bestStart + bestLen).join(':')}`;
  }
  return parts.join(':');
}

/** Classify an address literal. Non-literals return null (callers must resolve first). */
export function classifyIp(input: string): IpVerdict | null {
  const text = input.trim();
  if (text === '') return null;

  const v4 = parseIpv4(text);
  if (v4 !== null) {
    for (const range of BLOCKED_V4) {
      if (v4 >= range.start && v4 <= range.end) {
        return { version: 4, public: false, normalized: formatIpv4(v4), reason: range.reason };
      }
    }
    return { version: 4, public: true, normalized: formatIpv4(v4) };
  }

  const groups = parseIpv6(text);
  if (groups === null) return null;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible addresses inherit the v4 verdict.
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isCompat = groups.slice(0, 6).every((g) => g === 0) && (groups[6] !== 0 || groups[7] > 1);
  if (isMapped || isCompat) {
    const embedded = ((groups[6] << 16) | groups[7]) >>> 0;
    for (const range of BLOCKED_V4) {
      if (embedded >= range.start && embedded <= range.end) {
        return { version: 6, public: false, normalized: formatIpv6(groups), reason: `ipv4-mapped-${range.reason}` };
      }
    }
    return { version: 6, public: true, normalized: formatIpv6(groups) };
  }

  for (const entry of BLOCKED_V6) {
    if (inV6Prefix(groups, entry.prefix, entry.bits)) {
      return { version: 6, public: false, normalized: formatIpv6(groups), reason: entry.reason };
    }
  }
  return { version: 6, public: true, normalized: formatIpv6(groups) };
}

/** True when the hostname is an IP literal (v4 or bracketed/plain v6). */
export function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[') || hostname.includes(':')) return parseIpv6(hostname) !== null;
  return parseIpv4(hostname) !== null;
}
