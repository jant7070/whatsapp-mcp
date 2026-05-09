// Media: SSRF guard + token signing.

import { describe, expect, it } from 'vitest';
import { isPrivateIp, verifyFileToken, loadOutboundFromBase64 } from '../src/media';

describe('isPrivateIp', () => {
  it('accepts public IPv4', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
  });
  it('rejects private/loopback/link-local IPv4', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true); // EC2 metadata
    expect(isPrivateIp('100.64.0.1')).toBe(true); // CGNAT
  });
  it('handles IPv6', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('2001:4860:4860::8888')).toBe(false);
  });
});

describe('verifyFileToken', () => {
  it('rejects malformed tokens', () => {
    expect(verifyFileToken('garbage')).toBeNull();
    expect(verifyFileToken('a.b')).toBeNull();
  });
});

describe('loadOutboundFromBase64', () => {
  it('rejects empty payloads', async () => {
    await expect(loadOutboundFromBase64('')).rejects.toThrow(/empty/);
  });
  it('decodes valid base64', async () => {
    const buf = await loadOutboundFromBase64(Buffer.from('hello').toString('base64'));
    expect(buf.toString()).toBe('hello');
  });
});
