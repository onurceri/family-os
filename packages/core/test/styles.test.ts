import type { Actor } from '@famos/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreTables } from '../src/tables.ts';
import { DEFAULT_THEME, defaultThemes, type ThemePort, type ThemeSummary } from '../src/themes.ts';
import { createTestKernel, type TestKernel } from './harness.ts';

/** The default theme plus two packs: one that suggests Wall, one that suggests nothing. */
function themesWith(preferred: Record<string, ThemeSummary['style']>): ThemePort {
	const base = defaultThemes.list()[0] as ThemeSummary;
	const list: ThemeSummary[] = [
		base,
		...Object.entries(preferred).map(([id, style]) => ({ ...base, id, name: id, style })),
	];
	return { ...defaultThemes, list: () => list, has: (id) => list.some((t) => t.id === id) };
}

let k: TestKernel;
afterEach(() => k.close());

const display = (deviceId: string): Actor => ({
	kind: 'display',
	deviceId,
	capabilities: [],
	showNames: true,
});

async function addDisplay(id: string) {
	await k.ctx.db
		.withTables<CoreTables>()
		.insertInto('core_devices')
		.values({
			id,
			name: id,
			kind: 'kiosk',
			token_hash: `hash-${id}`,
			created_by: 'test',
			created_at: 1,
			last_seen_at: 1,
			revoked_at: null,
			display_capabilities: '[]',
			display_show_names: 1,
		})
		.execute();
}

const look = (actor?: Actor) => k.themes.effective(k.ctx.db, actor);

describe('styles', () => {
	it('falls back to Broadsheet when nobody chose and the theme suggests nothing', async () => {
		k = await createTestKernel();
		const { actor } = await k.member('member');
		expect(await look(actor)).toMatchObject({
			style: 'broadsheet',
			familyStyle: null,
			myStyle: null,
		});
		expect(await look()).toMatchObject({ style: 'broadsheet' });
		const route = await k.route('core.getAppearance').call({ actor });
		expect(route).toMatchObject({ theme: DEFAULT_THEME, style: 'broadsheet' });
	});

	it("lets the family choose, and a member's own choice win over the family's", async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		const { actor: kid } = await k.member('member');
		await k.runner.invoke('core.setFamilyStyle', { style: 'lanes' }, admin);
		expect(await look(kid)).toMatchObject({ style: 'lanes', familyStyle: 'lanes', myStyle: null });

		const mine = await k.runner.invoke('core.setMyStyle', { style: 'wall' }, kid);
		expect(mine).toMatchObject({ status: 'applied', output: { style: 'wall' } });
		expect(await look(kid)).toMatchObject({ style: 'wall', familyStyle: 'lanes', myStyle: 'wall' });
		// It changes nothing for anyone else.
		expect(await look(admin)).toMatchObject({ style: 'lanes', myStyle: null });

		// Back to following the family.
		await k.runner.invoke('core.setMyStyle', { style: null }, kid);
		expect(await look(kid)).toMatchObject({ style: 'lanes', myStyle: null });
	});

	it("gives a display its own style over the family's, and only for displays", async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		await addDisplay('dev_kitchen');
		await k.runner.invoke('core.setFamilyStyle', { style: 'lanes' }, admin);
		expect((await look(display('dev_kitchen'))).style).toBe('lanes');

		await k.runner.invoke(
			'core.setDisplayStyle',
			{ deviceId: 'dev_kitchen', style: 'wall' },
			admin,
		);
		expect((await look(display('dev_kitchen'))).style).toBe('wall');
		expect(await k.route('core.listDisplayStyles').call({ actor: admin })).toEqual({
			dev_kitchen: 'wall',
		});
		// Another display and the family are untouched.
		expect((await look(display('dev_other'))).style).toBe('lanes');
		expect((await look(admin)).style).toBe('lanes');

		await expect(
			k.runner.invoke('core.setDisplayStyle', { deviceId: 'dev_nope', style: 'wall' }, admin),
		).rejects.toMatchObject({ code: 'not_found' });
		await k.runner.invoke('core.setDisplayStyle', { deviceId: 'dev_kitchen', style: null }, admin);
		expect((await look(display('dev_kitchen'))).style).toBe('lanes');
	});

	it('gives a display its own text size, normal for everyone else', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		const { actor: kid } = await k.member('member');
		await addDisplay('dev_kitchen');
		await addDisplay('dev_other');
		expect((await look(display('dev_kitchen'))).textSize).toBe('normal');

		await k.runner.invoke(
			'core.setDisplayTextSize',
			{ deviceId: 'dev_kitchen', size: 'larger' },
			admin,
		);
		expect((await look(display('dev_kitchen'))).textSize).toBe('larger');
		expect(await k.route('core.listDisplayTextSizes').call({ actor: admin })).toEqual({
			dev_kitchen: 'larger',
		});
		// Another display and people are untouched: a person's size is kept on their own device.
		expect((await look(display('dev_other'))).textSize).toBe('normal');
		expect((await look(admin)).textSize).toBe('normal');

		// Normal is never stored.
		await k.runner.invoke(
			'core.setDisplayTextSize',
			{ deviceId: 'dev_kitchen', size: 'normal' },
			admin,
		);
		expect((await look(display('dev_kitchen'))).textSize).toBe('normal');
		expect(await k.route('core.listDisplayTextSizes').call({ actor: admin })).toEqual({});

		await expect(
			k.runner.invoke('core.setDisplayTextSize', { deviceId: 'dev_nope', size: 'large' }, admin),
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(
			k.runner.invoke('core.setDisplayTextSize', { deviceId: 'dev_kitchen', size: 'large' }, kid),
		).rejects.toMatchObject({ code: 'forbidden' });
	});

	it("uses the theme's preferred style only while the family has none", async () => {
		k = await createTestKernel({ themes: themesWith({ paper: 'wall', coast: null }) });
		const { actor: admin } = await k.member('admin');
		await k.runner.invoke('core.setFamilyTheme', { theme: 'paper' }, admin);
		expect(await look(admin)).toMatchObject({ theme: 'paper', style: 'wall', familyStyle: null });

		// A member on a theme without a preference gets the default, not the family theme's.
		const { actor: kid } = await k.member('member');
		await k.runner.invoke('core.setMyTheme', { theme: 'coast' }, kid);
		expect(await look(kid)).toMatchObject({ theme: 'coast', style: 'broadsheet' });

		// Once the family chooses, the pack's suggestion no longer counts.
		await k.runner.invoke('core.setFamilyStyle', { style: 'lanes' }, admin);
		expect(await look(admin)).toMatchObject({ theme: 'paper', style: 'lanes' });
	});

	it('skips a stored id that is not a style, and refuses one in an action', async () => {
		k = await createTestKernel();
		const { actor: admin } = await k.member('admin');
		await k.ctx.db
			.withTables<CoreTables>()
			.insertInto('core_settings')
			.values({
				key: 'styles.choices',
				value: JSON.stringify({
					family: 'mosaic',
					members: { [admin.kind === 'member' ? admin.memberId : '']: 'gone' },
					displays: {},
				}),
				updated_at: 1,
			})
			.execute();
		expect(await look(admin)).toMatchObject({
			style: 'broadsheet',
			familyStyle: null,
			myStyle: null,
		});
		await expect(
			k.runner.invoke('core.setFamilyStyle', { style: 'mosaic' }, admin),
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			k.runner.invoke('core.setMyStyle', { style: 'mosaic' }, admin),
		).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('lets everyone choose their own, but only admins the family and display styles', async () => {
		k = await createTestKernel();
		const { actor: kid } = await k.member('member');
		await addDisplay('dev_kitchen');
		await expect(
			k.runner.invoke('core.setFamilyStyle', { style: 'wall' }, kid),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			k.runner.invoke('core.setDisplayStyle', { deviceId: 'dev_kitchen', style: 'wall' }, kid),
		).rejects.toMatchObject({ code: 'forbidden' });
		expect(await k.runner.invoke('core.setMyStyle', { style: 'wall' }, kid)).toMatchObject({
			status: 'applied',
		});
	});
});
