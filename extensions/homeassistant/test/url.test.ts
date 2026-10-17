import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl } from '../src/contract/url.ts';

const url = (raw: string) => normalizeBaseUrl(raw)?.url ?? null;

describe('normalizeBaseUrl', () => {
	it('accepts http and https addresses, with a port', () => {
		expect(url('http://192.168.1.20:8123')).toBe('http://192.168.1.20:8123');
		expect(url('https://ha.example.net')).toBe('https://ha.example.net');
		expect(url('  https://ha.example.net:8443  ')).toBe('https://ha.example.net:8443');
		expect(normalizeBaseUrl('http://192.168.1.20:8123')).toEqual({
			url: 'http://192.168.1.20:8123',
			scheme: 'http',
			host: '192.168.1.20',
			port: 8123,
			path: null,
		});
		expect(normalizeBaseUrl('https://ha.example.net')).toMatchObject({ port: null });
		expect(url('http://[fd00::20]:8123')).toBe('http://[fd00::20]:8123');
	});

	it('lowercases the host and drops the default port', () => {
		expect(url('HTTPS://HA.Example.NET')).toBe('https://ha.example.net');
		expect(url('http://ha.example.net:80')).toBe('http://ha.example.net');
	});

	it('removes a trailing slash and a trailing /api', () => {
		expect(url('http://192.168.1.20:8123/')).toBe('http://192.168.1.20:8123');
		expect(url('http://192.168.1.20:8123///')).toBe('http://192.168.1.20:8123');
		expect(url('http://192.168.1.20:8123/api')).toBe('http://192.168.1.20:8123');
		expect(url('http://192.168.1.20:8123/api/')).toBe('http://192.168.1.20:8123');
		expect(url('http://192.168.1.20:8123/API/')).toBe('http://192.168.1.20:8123');
	});

	it('keeps a path prefix a reverse proxy serves Home Assistant under', () => {
		expect(url('https://example.net/ha')).toBe('https://example.net/ha');
		expect(url('https://example.net/ha/')).toBe('https://example.net/ha');
		expect(url('https://example.net/ha/api')).toBe('https://example.net/ha');
		expect(url('https://example.net/ha/api/')).toBe('https://example.net/ha');
		expect(normalizeBaseUrl('https://example.net/ha/api')).toMatchObject({ path: '/ha' });
		// Only a final /api segment is removed.
		expect(url('https://example.net/apiary')).toBe('https://example.net/apiary');
		expect(url('https://example.net/api/ha')).toBe('https://example.net/api/ha');
	});

	it('refuses credentials, queries and fragments', () => {
		expect(url('http://user:pass@192.168.1.20:8123')).toBeNull();
		expect(url('http://user@192.168.1.20:8123')).toBeNull();
		expect(url('http://192.168.1.20:8123?token=abc')).toBeNull();
		expect(url('http://192.168.1.20:8123/?')).toBeNull();
		expect(url('http://192.168.1.20:8123/#dashboard')).toBeNull();
		expect(url('http://192.168.1.20:8123#')).toBeNull();
	});

	it('refuses other schemes and things that are not addresses', () => {
		expect(url('ftp://192.168.1.20')).toBeNull();
		expect(url('webcal://ha.example.net')).toBeNull();
		expect(url('ws://192.168.1.20:8123')).toBeNull();
		expect(url('javascript:alert(1)')).toBeNull();
		expect(url('192.168.1.20:8123')).toBeNull();
		expect(url('ha.example.net')).toBeNull();
		expect(url('')).toBeNull();
		expect(url('   ')).toBeNull();
		expect(url('http://')).toBeNull();
		expect(url('http://192.168 .1.20')).toBeNull();
		expect(url('http://ha.example.net/a b')).toBeNull();
		expect(url(`https://example.net/${'a'.repeat(2000)}`)).toBeNull();
	});
});
