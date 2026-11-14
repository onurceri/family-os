import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { endpointId, isRegistered } from './push-endpoint.js';

describe('push endpoint identity', () => {
	it('matches the digest the server lists', async () => {
		const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
		expect(await endpointId(endpoint)).toBe(createHash('sha256').update(endpoint).digest('hex'));
	});

	it('is registered only when the member lists that browser', () => {
		expect(isRegistered([{ endpointId: 'a' }], 'a')).toBe(true);
		expect(isRegistered([{ endpointId: 'a' }], 'b')).toBe(false);
		expect(isRegistered([], 'a')).toBe(false);
	});
});
