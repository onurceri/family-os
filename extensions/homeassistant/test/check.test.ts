import { ExternalHttpError } from '@famos/sdk';
import { describe, expect, it } from 'vitest';
import { isApiRoot, readConfig, statusOfError } from '../src/server/check.ts';

describe('statusOfError', () => {
	it.each([
		['http_401', 'token_refused'],
		['http_403', 'token_refused'],
		['http_404', 'not_home_assistant'],
		['blocked_address', 'blocked_address'],
		['timeout', 'timeout'],
		['unreachable', 'unreachable'],
		['bad_url', 'unreachable'],
		['http_500', 'failed'],
		['http_503', 'failed'],
		['too_large', 'failed'],
		['redirect_refused', 'failed'],
	] as const)('%s is %s', (code, status) => {
		expect(statusOfError(new ExternalHttpError(code))).toBe(status);
	});

	it('is failed for anything else', () => {
		expect(statusOfError(new Error('boom'))).toBe('failed');
		expect(statusOfError('http_401')).toBe('failed');
		expect(statusOfError(undefined)).toBe('failed');
	});
});

describe('isApiRoot', () => {
	it('wants JSON with a text message, whatever it says', () => {
		expect(isApiRoot('{"message":"API running."}')).toBe(true);
		expect(isApiRoot('{"message":"Another sentence"}')).toBe(true);
		expect(isApiRoot('{"message":7}')).toBe(false);
		expect(isApiRoot('{"msg":"API running."}')).toBe(false);
		expect(isApiRoot('[]')).toBe(false);
		expect(isApiRoot('null')).toBe(false);
		expect(isApiRoot('<html>API running.</html>')).toBe(false);
		expect(isApiRoot('')).toBe(false);
	});
});

describe('readConfig', () => {
	it('picks the version and the name and nothing else', () => {
		const found = readConfig(
			JSON.stringify({
				latitude: 52.3601,
				longitude: 4.8866,
				elevation: 1,
				location_name: 'Home',
				version: '2026.10.2',
				time_zone: 'Europe/Amsterdam',
			}),
		);
		expect(found).toEqual({ version: '2026.10.2', name: 'Home' });
	});

	it('cuts long texts and leaves out what is not text', () => {
		expect(
			readConfig(JSON.stringify({ version: 'v'.repeat(500), location_name: 'n'.repeat(500) })),
		).toEqual({
			version: 'v'.repeat(100),
			name: 'n'.repeat(100),
		});
		expect(readConfig(JSON.stringify({ version: 3, location_name: '  ' }))).toEqual({
			version: null,
			name: null,
		});
	});

	it('is null when the answer is not a JSON object', () => {
		expect(readConfig('<html></html>')).toBeNull();
		expect(readConfig('[]')).toBeNull();
		expect(readConfig('"text"')).toBeNull();
		expect(readConfig('null')).toBeNull();
	});
});
