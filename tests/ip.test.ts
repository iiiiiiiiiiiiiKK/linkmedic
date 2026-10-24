import { describe, expect, it } from 'vitest';
import { classifyIp, parseIpv4, parseIpv6, isIpLiteral } from '../shared/core/ip';

describe('parseIpv4', () => {
  it('parses canonical addresses', () => {
    expect(parseIpv4('93.184.216.34')).toBe(0x5db8d822);
    expect(parseIpv4('0.0.0.0')).toBe(0);
    expect(parseIpv4('255.255.255.255')).toBe(0xffffffff);
  });

  it('rejects ambiguous and malformed forms', () => {
    expect(parseIpv4('010.0.0.1')).toBeNull(); // leading zero (octal ambiguity)
    expect(parseIpv4('1.2.3')).toBeNull();
    expect(parseIpv4('1.2.3.4.5')).toBeNull();
    expect(parseIpv4('256.1.1.1')).toBeNull();
    expect(parseIpv4('1.2.3.x')).toBeNull();
    expect(parseIpv4('')).toBeNull();
  });
});

describe('parseIpv6', () => {
  it('expands compressed forms', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('2606:4700::6810:7c60')).toEqual([0x2606, 0x4700, 0, 0, 0, 0, 0x6810, 0x7c60]);
  });

  it('handles embedded IPv4', () => {
    expect(parseIpv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
    expect(parseIpv6('::ffff:93.184.216.34')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x5db8, 0xd822]);
  });

  it('accepts bracketed input and zone ids', () => {
    expect(parseIpv6('[::1]')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('rejects garbage', () => {
    expect(parseIpv6('not:an:ip')).toBeNull();
    expect(parseIpv6('1:2:3:4:5:6:7:8:9')).toBeNull();
  });
});

describe('classifyIp — private and reserved ranges must be blocked', () => {
  const blocked: [string, string][] = [
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['0.0.0.0', 'this-network'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['169.254.169.254', 'link-local'],
    ['169.254.0.1', 'link-local'],
    ['192.0.2.5', 'documentation'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2002::1', '6to4'],
    ['::ffff:127.0.0.1', 'ipv4-mapped-loopback'],
    ['::ffff:10.0.0.1', 'ipv4-mapped-private'],
    ['::ffff:169.254.169.254', 'ipv4-mapped-link-local'],
    ['64:ff9b::7f00:1', 'nat64'],
  ];

  for (const [ip, reason] of blocked) {
    it(`blocks ${ip} (${reason})`, () => {
      const verdict = classifyIp(ip);
      expect(verdict, `${ip} should be recognised as an IP`).not.toBeNull();
      expect(verdict!.public).toBe(false);
      expect(verdict!.reason).toContain(reason.split('-').pop()!);
    });
  }
});

describe('classifyIp — public addresses stay allowed', () => {
  const allowed = [
    '93.184.216.34',
    '8.8.8.8',
    '1.1.1.1',
    '104.20.23.154',
    '172.66.147.243', // 172.66/16 is public; only 172.16/12 is private
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:93.184.216.34',
  ];

  for (const ip of allowed) {
    it(`allows ${ip}`, () => {
      const verdict = classifyIp(ip);
      expect(verdict).not.toBeNull();
      expect(verdict!.public).toBe(true);
    });
  }
});

describe('classifyIp — non-literals', () => {
  it('returns null for hostnames', () => {
    expect(classifyIp('example.com')).toBeNull();
  });
});

describe('isIpLiteral', () => {
  it('detects both families and rejects hostnames', () => {
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
    expect(isIpLiteral('1.2.3')).toBe(false);
  });
});
