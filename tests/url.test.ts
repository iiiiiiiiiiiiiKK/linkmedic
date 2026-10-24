import { describe, expect, it } from 'vitest';
import {
  InputError,
  normalizeUrl,
  resolveLocation,
  isHtmlContentType,
  charsetFromContentType,
} from '../shared/core/url';

const codes = (fn: () => unknown): string => {
  try {
    fn();
    return 'NO_THROW';
  } catch (err) {
    return err instanceof InputError ? err.code : `OTHER:${(err as Error).message}`;
  }
};

describe('normalizeUrl — accepted inputs', () => {
  it('fills in https when the scheme is omitted', () => {
    const target = normalizeUrl('example.com');
    expect(target.requestedUrl).toBe('https://example.com/');
    expect(target.protocol).toBe('https');
    expect(target.host).toBe('example.com');
    expect(target.port).toBe(443);
  });

  it('keeps explicit http', () => {
    const target = normalizeUrl('http://example.com/a?b=1');
    expect(target.protocol).toBe('http');
    expect(target.port).toBe(80);
    expect(target.path).toBe('/a?b=1');
  });

  it('drops the fragment', () => {
    expect(normalizeUrl('https://example.com/page#section').requestedUrl).toBe('https://example.com/page');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeUrl('   example.com  ').requestedUrl).toBe('https://example.com/');
  });

  it('accepts public IP literals', () => {
    expect(normalizeUrl('https://93.184.216.34/').host).toBe('93.184.216.34');
    expect(normalizeUrl('http://[2606:4700:4700::1111]/').host).toBe('2606:4700:4700::1111');
  });

  it('keeps non-standard but allowed paths and queries', () => {
    const target = normalizeUrl('https://example.com/a/b/c?x=1&y=%20');
    expect(target.path).toBe('/a/b/c?x=1&y=%20');
  });
});

describe('normalizeUrl — rejected inputs', () => {
  it('rejects empty input', () => {
    expect(codes(() => normalizeUrl(''))).toBe('empty');
    expect(codes(() => normalizeUrl('   '))).toBe('empty');
  });

  it('rejects non-http schemes', () => {
    expect(codes(() => normalizeUrl('file:///etc/passwd'))).toBe('unsupported_scheme');
    expect(codes(() => normalizeUrl('ftp://example.com'))).toBe('unsupported_scheme');
    expect(codes(() => normalizeUrl('javascript:alert(1)'))).toBe('unsupported_scheme');
    expect(codes(() => normalizeUrl('gopher://example.com'))).toBe('unsupported_scheme');
    expect(codes(() => normalizeUrl('data:text/html,<script>alert(1)</script>'))).toBe('unsupported_scheme');
  });

  it('rejects embedded credentials', () => {
    expect(codes(() => normalizeUrl('https://user:pass@example.com'))).toBe('credentials_not_allowed');
  });

  it('rejects loopback, private, and metadata targets', () => {
    expect(codes(() => normalizeUrl('http://localhost/'))).toBe('blocked_target');
    expect(codes(() => normalizeUrl('http://localhost:8080/'))).toBe('blocked_target');
    expect(codes(() => normalizeUrl('http://127.0.0.1/'))).toBe('blocked_target');
    expect(codes(() => normalizeUrl('http://127.0.0.1:22/'))).toBe('blocked_port');
    expect(codes(() => normalizeUrl('http://10.0.0.5/'))).toBe('blocked_target');
    expect(codes(() => normalizeUrl('http://192.168.0.1/'))).toBe('blocked_target');
    expect(codes(() => normalizeUrl('http://172.16.5.4/'))).toBe('blocked_target');
    expect(codes(() => normalizeUrl('http://169.254.169.254/latest/meta-data/'))).toBe('blocked_target');
    expect(codes(() => normalizeUrl('http://[::1]/'))).toBe('blocked_target');
    expect(codes(() => normalizeUrl('http://[fd00::1]/'))).toBe('blocked_target');
    expect(codes(() => normalizeUrl('http://metadata.google.internal/'))).toBe('blocked_target');
    expect(codes(() => normalizeUrl('http://printer.local/'))).toBe('blocked_target');
  });

  it('rejects non-web ports to stop port scanning', () => {
    expect(codes(() => normalizeUrl('https://example.com:8443/'))).toBe('blocked_port');
    expect(codes(() => normalizeUrl('https://example.com:22/'))).toBe('blocked_port');
    expect(codes(() => normalizeUrl('https://example.com:3306/'))).toBe('blocked_port');
  });

  it('rejects bare single-label hostnames', () => {
    expect(codes(() => normalizeUrl('http://intranet/'))).toBe('invalid_host');
  });

  it('rejects control characters and spaces', () => {
    expect(codes(() => normalizeUrl('https://exa mple.com'))).toBe('invalid_characters');
    expect(codes(() => normalizeUrl('https://example.com/\u0000'))).toBe('invalid_characters');
  });

  it('rejects over-long input', () => {
    expect(codes(() => normalizeUrl(`https://example.com/${'a'.repeat(2100)}`))).toBe('too_long');
  });

  it('rejects unparsable input', () => {
    expect(codes(() => normalizeUrl('https://'))).toBe('invalid_url');
  });
});

describe('resolveLocation', () => {
  it('resolves absolute and relative redirect targets', () => {
    expect(resolveLocation('https://a.com/x', 'https://b.com/y')).toBe('https://b.com/y');
    expect(resolveLocation('https://a.com/x/y', '/z')).toBe('https://a.com/z');
    expect(resolveLocation('https://a.com/x/y', 'z')).toBe('https://a.com/x/z');
    expect(resolveLocation('https://a.com/x', '//c.com/p')).toBe('https://c.com/p');
  });

  it('drops fragments from the redirect target', () => {
    expect(resolveLocation('https://a.com/', '/next#frag')).toBe('https://a.com/next');
  });
});

describe('content type helpers', () => {
  it('detects HTML', () => {
    expect(isHtmlContentType('text/html; charset=utf-8')).toBe(true);
    expect(isHtmlContentType('application/xhtml+xml')).toBe(true);
    expect(isHtmlContentType('application/json')).toBe(false);
    expect(isHtmlContentType(null)).toBe(false);
  });

  it('extracts charsets', () => {
    expect(charsetFromContentType('text/html; charset=UTF-8')).toBe('utf-8');
    expect(charsetFromContentType('text/html;charset="gbk"')).toBe('gbk');
    expect(charsetFromContentType('text/html')).toBeNull();
    expect(charsetFromContentType(null)).toBeNull();
  });
});
