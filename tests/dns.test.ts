import { describe, expect, it, vi } from 'vitest';
import { BlockedTargetError, resolveAndValidate } from '../shared/core/dns';
import type { HopResult, RequestOptions, Transport } from '../shared/core/transport';

/** A transport stub: DNS is scripted, network calls are recorded but never made. */
function stubTransport(answers: Record<string, string[]>, hop: Partial<HopResult> = {}) {
  const requests: string[] = [];
  const transport: Transport & { requests: string[] } = {
    runtime: 'node',
    kind: 'node-socket',
    ipPinning: true,
    certificateDetails: true,
    requests,
    async resolve(hostname: string) {
      const list = answers[hostname];
      if (!list) throw new Error('ENOTFOUND');
      return list.map((address) => ({ address, family: address.includes(':') ? (6 as const) : (4 as const) }));
    },
    async request(url: string, opts: RequestOptions): Promise<HopResult> {
      requests.push(`${opts.method} ${url}`);
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<html><head><title>OK</title></head><body><p>hello</p></body></html>',
        bodyBytes: 68,
        truncated: false,
        durationMs: 12,
        ttfbMs: 10,
        ip: '93.184.216.34',
        certificate: { valid: true, source: 'tls-inspection' },
        error: null,
        ...hop,
      };
    },
  };
  return transport;
}

describe('resolveAndValidate', () => {
  it('returns public answers unchanged', async () => {
    const transport = stubTransport({ 'example.com': ['93.184.216.34'] });
    const result = await resolveAndValidate(transport, 'example.com');
    expect(result).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects a hostname that resolves to loopback (DNS rebinding)', async () => {
    const transport = stubTransport({ 'evil.test': ['127.0.0.1'] });
    await expect(resolveAndValidate(transport, 'evil.test')).rejects.toBeInstanceOf(BlockedTargetError);
  });

  it('rejects a mixed answer set containing a private address', async () => {
    const transport = stubTransport({ 'rebind.test': ['93.184.216.34', '10.0.0.7'] });
    await expect(resolveAndValidate(transport, 'rebind.test')).rejects.toThrow(/non-public address/);
  });

  it('rejects metadata and link-local answers', async () => {
    const transport = stubTransport({ 'meta.test': ['169.254.169.254'] });
    await expect(resolveAndValidate(transport, 'meta.test')).rejects.toBeInstanceOf(BlockedTargetError);
  });

  it('rejects IPv6 loopback and unique-local answers', async () => {
    await expect(resolveAndValidate(stubTransport({ 'a.test': ['::1'] }), 'a.test')).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
    await expect(resolveAndValidate(stubTransport({ 'b.test': ['fd00::5'] }), 'b.test')).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
  });

  it('rejects hosts with no DNS answers', async () => {
    await expect(resolveAndValidate(stubTransport({ 'empty.test': [] }), 'empty.test')).rejects.toThrow(
      /no usable address/,
    );
  });

  it('rejects when DNS itself fails', async () => {
    await expect(resolveAndValidate(stubTransport({}), 'missing.test')).rejects.toThrow(/DNS lookup/);
  });

  it('short-circuits literal addresses without a DNS lookup', async () => {
    const transport = stubTransport({});
    expect(await resolveAndValidate(transport, '93.184.216.34')).toEqual([{ address: '93.184.216.34', family: 4 }]);
    await expect(resolveAndValidate(transport, '192.168.1.1')).rejects.toBeInstanceOf(BlockedTargetError);
  });

  it('never leaks the blocked address verbatim in a way that helps an attacker', async () => {
    // The message may name the reason, but must not include a URL or a port.
    await expect(resolveAndValidate(stubTransport({ 'x.test': ['10.1.2.3'] }), 'x.test')).rejects.toThrow(
      /Private|private|loopback|non-public/,
    );
  });
});

describe('transport stub contract', () => {
  it('records the method and URL it was asked for', async () => {
    const transport = stubTransport({ 'example.com': ['93.184.216.34'] });
    await transport.request('https://example.com/x', {
      method: 'GET',
      timeoutMs: 1000,
      maxBytes: 1024,
      userAgent: 'test',
    });
    expect(transport.requests).toEqual(['GET https://example.com/x']);
  });

  it('is not called by resolveAndValidate', async () => {
    const spy = vi.fn();
    const transport = stubTransport({ 'example.com': ['93.184.216.34'] });
    transport.request = spy as unknown as Transport['request'];
    await resolveAndValidate(transport, 'example.com');
    expect(spy).not.toHaveBeenCalled();
  });
});
