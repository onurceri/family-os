import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPlatform, currentPlatform, type Platform, SHARED_WEB } from '../src/index.ts';

describe('the platform extension packages are built against', () => {
	it('matches platform.json, or SDK_VERSION was raised for the change', async () => {
		const committed = JSON.parse(
			readFileSync(join(import.meta.dirname, '..', 'platform.json'), 'utf8'),
		) as Platform;
		const check = checkPlatform(committed, await currentPlatform());
		// The message says what changed and what to do: raise SDK_VERSION, then run
		// `pnpm --filter @famos/pack platform:update`.
		if (!check.ok) expect.fail(check.message);
	});

	it('records the export names of every shared module of ours', async () => {
		const { exports } = await currentPlatform();
		expect(exports['@famos/sdk']).toContain('defineExtension');
		expect(exports['@famos/time']).toContain('todayIn');
		expect(exports['@famos/api-client']).toContain('createApiClient');
		expect(exports['@famos/ui/famos']).toContain('Page');
		expect(exports['@famos/ui/slot']).toEqual(['default']);
		expect(Object.keys(exports).some((name) => name.endsWith('.css'))).toBe(false);
	});
});

describe('checkPlatform', () => {
	const base: Platform = {
		sdk: '0.4.0',
		svelte: '5.57',
		zod: '4',
		kysely: '0.29',
		exports: { '@famos/sdk': ['a', 'b'], '@famos/ui/famos': ['Page'] },
	};

	it('passes when nothing changed', () => {
		expect(checkPlatform(base, structuredClone(base))).toEqual({ ok: true });
	});

	it('wants a minor for a removed name, a new Svelte minor or another zod major', () => {
		const removed = { ...base, exports: { ...base.exports, '@famos/sdk': ['a'] } };
		expect(checkPlatform(base, removed)).toMatchObject({
			ok: false,
			reason: 'bump',
			required: 'minor',
		});
		expect(checkPlatform(base, { ...base, svelte: '5.58' })).toMatchObject({ reason: 'bump' });
		expect(checkPlatform(base, { ...base, zod: '5' })).toMatchObject({ reason: 'bump' });
		expect(checkPlatform(base, { ...removed, sdk: '0.4.1' })).toMatchObject({ reason: 'bump' });
		expect(checkPlatform(base, { ...removed, sdk: '0.5.0' })).toMatchObject({ reason: 'update' });
	});

	it('wants at least a patch for names only added', () => {
		const added = { ...base, exports: { ...base.exports, '@famos/ui/new': ['x'] } };
		expect(checkPlatform(base, added)).toMatchObject({ reason: 'bump', required: 'patch' });
		expect(checkPlatform(base, { ...added, sdk: '0.4.1' })).toMatchObject({ reason: 'update' });
	});

	it('names the change and the file to edit', () => {
		const check = checkPlatform(base, { ...base, kysely: '0.30' });
		expect(check.ok).toBe(false);
		if (!check.ok) {
			expect(check.message).toContain('kysely 0.29 → 0.30');
			expect(check.message).toContain('packages/sdk/src/manifest.ts');
			expect(check.message).toContain('platform:update');
		}
	});

	it('asks only for the snapshot after a bump with nothing else changed', () => {
		expect(checkPlatform(base, { ...base, sdk: '0.5.0' })).toMatchObject({ reason: 'update' });
	});
});

describe('SHARED_WEB', () => {
	it('holds the browser side of Svelte and every script subpath of @famos/ui', () => {
		expect(SHARED_WEB).toEqual(
			expect.arrayContaining([
				'svelte',
				'svelte/internal/client',
				'svelte/internal/disclose-version',
				'svelte/internal/flags/legacy',
				'svelte/reactivity/window',
				'svelte/transition',
				'@famos/ui/famos',
				'@famos/ui/slot',
				'@famos/ui/app',
				'@famos/sdk',
				'zod',
				'@famos/time',
				'@famos/api-client',
			]),
		);
		for (const left of [
			'svelte/compiler',
			'svelte/server',
			'svelte/internal/server',
			'svelte/internal',
			'svelte/package.json',
			'svelte/action',
			'svelte/elements',
			'@famos/ui/theme.css',
			'@lucide/svelte',
		]) {
			expect(SHARED_WEB).not.toContain(left);
		}
	});
});
