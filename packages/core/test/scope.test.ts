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
		},
		parseManifest({ id: 'x', version: '0.0.0', sdk: '^0.3.0', ...(network && { network }) }),
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
});
