import { type ExternalHttpRequest, parseManifest } from '@famos/sdk';
import { describe, expect, it } from 'vitest';
import { scopedHttp } from '../src/scope.ts';

const forbidden = { code: 'forbidden' };

function http(network?: Record<string, unknown>) {
	const seen: ExternalHttpRequest[] = [];
	const guarded = scopedHttp(
		{
			async get(request) {
				seen.push(request);
				return { status: 304, etag: null, lastModified: null };
			},
			async post(request) {
				seen.push(request);
				return { status: 200, text: '' };
			},
		},
		parseManifest({ id: 'x', version: '0.0.0', sdk: '^0.5.0', ...(network && { network }) }),
	);
	return { guarded, seen };
}

describe('outbound HTTP follows the manifest', () => {
	it('reaches nothing when the manifest declares no network', async () => {
		const { guarded, seen } = http();
		await expect(guarded.get({ url: 'https://example.org/' })).rejects.toMatchObject(forbidden);
		expect(seen).toEqual([]);
	});

	it('reaches the declared hosts only', async () => {
		const { guarded, seen } = http({ hosts: ['api.example.org'] });
		await guarded.get({ url: 'https://API.example.org/v1?q=1' });
		await expect(guarded.get({ url: 'https://example.org/' })).rejects.toMatchObject(forbidden);
		await expect(guarded.get({ url: 'https://api.example.org.evil.test/' })).rejects.toMatchObject(
			forbidden,
		);
		expect(seen.map((r) => r.url)).toEqual(['https://API.example.org/v1?q=1']);
	});

	it('fetches any address a person typed with userUrls, and the home network only with local', async () => {
		const typed = http({ userUrls: true });
		await typed.guarded.get({ url: 'webcal://calendar.example.net/a.ics' });
		await expect(
			typed.guarded.get({ url: 'http://192.168.1.2/a.ics', allowLocal: true }),
		).rejects.toMatchObject(forbidden);
		const local = http({ userUrls: true, local: true });
		await local.guarded.get({ url: 'http://192.168.1.2/a.ics', allowLocal: true });
		expect(local.seen).toHaveLength(1);
	});

	it('holds a POST to the same rule as a GET', async () => {
		const none = http();
		await expect(
			none.guarded.post({ url: 'https://example.org/', json: {} }),
		).rejects.toMatchObject(forbidden);
		const declared = http({ hosts: ['api.example.org'] });
		await declared.guarded.post({ url: 'https://api.example.org/hook', json: { a: 1 } });
		await expect(
			declared.guarded.post({ url: 'https://other.example.org/hook', json: {} }),
		).rejects.toMatchObject(forbidden);
		const typed = http({ userUrls: true });
		await expect(
			typed.guarded.post({ url: 'http://192.168.1.2/api', json: {}, allowLocal: true }),
		).rejects.toMatchObject(forbidden);
		const local = http({ userUrls: true, local: true });
		await local.guarded.post({ url: 'http://192.168.1.2/api', json: {}, allowLocal: true });
		expect(declared.seen.map((r) => r.url)).toEqual(['https://api.example.org/hook']);
		expect(local.seen).toHaveLength(1);
		expect(none.seen).toEqual([]);
	});
});
