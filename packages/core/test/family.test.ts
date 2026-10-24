import { defineAction } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { anyLanguage, type LanguagePort } from '../src/languages.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

// An action that reads family settings inside its transaction (must not deadlock).
const readZone = defineAction({
	id: 'probe.readZone',
	title: 'Read the family time zone',
	input: z.object({}),
	output: z.object({ timeZone: z.string() }),
	readOnly: true,
	async run(uow) {
		return { timeZone: (await uow.family.settings()).timeZone };
	},
});
const probe = defineTestExtension({ id: 'probe', actions: [readZone] });

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [probe] });
});
afterEach(() => k.close());

describe('family language', () => {
	it('accepts any well-formed code when no registry is wired, and refuses nonsense', async () => {
		const { actor: admin } = await k.member('admin');
		const set = (locale: string) => k.runner.invoke('core.updateFamilySettings', { locale }, admin);
		expect(await set('pt-br')).toMatchObject({ status: 'applied', output: { locale: 'pt-BR' } });
		await expect(set('not a locale')).rejects.toMatchObject({ code: 'bad_request' });
		await expect(set('')).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('lets the language registry decide which languages exist', async () => {
		const only: LanguagePort = {
			...anyLanguage,
			has: (code) => code === 'en' || code === 'de',
		};
		const k2 = await createTestKernel({ languages: only });
		try {
			const { actor: admin, member } = await k2.member('admin');
			await expect(
				k2.runner.invoke('core.updateFamilySettings', { locale: 'fr' }, admin),
			).rejects.toMatchObject({ code: 'bad_request' });
			await expect(
				k2.runner.invoke('core.updateMember', { memberId: member.id, locale: 'fr' }, admin),
			).rejects.toMatchObject({ code: 'bad_request' });
			await expect(
				k2.runner.invoke('core.setMyLanguage', { locale: 'fr' }, admin),
			).rejects.toMatchObject({ code: 'bad_request' });
			expect(await k2.runner.invoke('core.setMyLanguage', { locale: 'de' }, admin)).toMatchObject({
				output: { locale: 'de' },
			});
			expect(await k2.runner.invoke('core.setMyLanguage', { locale: null }, admin)).toMatchObject({
				output: { locale: null },
			});
			await expect(
				k2.route('core.completeSetup').call({
					body: {
						displayName: 'P',
						email: 'p@example.com',
						password: 'correct horse battery',
						locale: 'fr',
					},
				}),
			).rejects.toMatchObject({ code: 'bad_request' });
		} finally {
			await k2.close();
		}
	});

	it('tells open screens when family settings change', async () => {
		const { actor: admin } = await k.member('admin');
		const heard: string[] = [];
		k.bus.onAny((name) => void heard.push(name));
		await k.runner.invoke('core.updateFamilySettings', { timeZone: 'Europe/Berlin' }, admin);
		expect(heard).toContain('core.family.changed');
	});
});

describe('family settings', () => {
	it('defaults to UTC/en and stores the time zone chosen at setup', async () => {
		expect(await k.ctx.family.settings()).toEqual({
			timeZone: 'UTC',
			locale: 'en',
			formatLocale: 'en-US',
			weekStart: 1,
			hourCycle: 'h12',
			temperatureUnit: 'celsius',
			reminderTime: '09:00',
		});
		await k.route('core.completeSetup').call({
			body: {
				displayName: 'P',
				email: 'p@example.com',
				password: 'correct horse battery',
				locale: 'tr',
				timeZone: 'Europe/Istanbul',
			},
		});
		expect(await k.ctx.family.settings()).toEqual({
			timeZone: 'Europe/Istanbul',
			locale: 'tr',
			formatLocale: 'tr-TR',
			weekStart: 1,
			hourCycle: 'h23',
			temperatureUnit: 'celsius',
			reminderTime: '09:00',
		});
	});

	it('is readable inside a unit of work and changeable by admins only', async () => {
		const { actor: admin } = await k.member('admin');
		const { actor: child } = await k.member('member');
		await expect(
			k.runner.invoke('core.updateFamilySettings', { timeZone: 'Europe/Berlin' }, child),
		).rejects.toMatchObject({
			code: 'forbidden',
		});
		await k.runner.invoke('core.updateFamilySettings', { timeZone: 'Europe/Berlin' }, admin);
		const result = await k.runner.invoke<{ timeZone: string }>('probe.readZone', {}, admin);
		expect(result).toEqual({ status: 'applied', output: { timeZone: 'Europe/Berlin' } });
	});

	it('keeps the reminder time, 09:00 until the family changes it, and refuses a bad time', async () => {
		const { actor: admin } = await k.member('admin');
		expect((await k.ctx.family.settings()).reminderTime).toBe('09:00');
		expect(
			await k.runner.invoke('core.updateFamilySettings', { reminderTime: '07:30' }, admin),
		).toMatchObject({ status: 'applied', output: { reminderTime: '07:30' } });
		expect((await k.ctx.family.settings()).reminderTime).toBe('07:30');
		for (const bad of ['7:30', '24:00', '09:60', 'morning', '']) {
			await expect(
				k.runner.invoke('core.updateFamilySettings', { reminderTime: bad }, admin),
			).rejects.toMatchObject({ code: 'bad_request' });
		}
		expect((await k.ctx.family.settings()).reminderTime).toBe('07:30');
	});

	it('rejects unknown time zones', async () => {
		const { actor: admin } = await k.member('admin');
		await expect(
			k.runner.invoke('core.updateFamilySettings', { timeZone: 'Mars/Olympus' }, admin),
		).rejects.toMatchObject({
			code: 'bad_request',
		});
	});

	describe('region formats', () => {
		const setup = (extra: Record<string, unknown>) =>
			k.route('core.completeSetup').call({
				body: {
					displayName: 'P',
					email: 'p@example.com',
					password: 'correct horse battery',
					locale: 'en',
					...extra,
				},
			});

		it('takes the formats from the browser region at setup, derived with Intl', async () => {
			await setup({ formatLocale: 'en-US' });
			expect(await k.ctx.family.settings()).toMatchObject({
				formatLocale: 'en-US',
				weekStart: 7,
				hourCycle: 'h12',
				temperatureUnit: 'fahrenheit',
			});
		});

		it('derives a Monday-first 24-hour Celsius region from en-GB and de-DE', async () => {
			await setup({ formatLocale: 'de-de' });
			expect(await k.ctx.family.settings()).toMatchObject({
				formatLocale: 'de-DE',
				weekStart: 1,
				hourCycle: 'h23',
				temperatureUnit: 'celsius',
			});
		});

		it('lets the setup override single choices', async () => {
			await setup({
				formatLocale: 'en-GB',
				weekStart: 7,
				hourCycle: 'h12',
				temperatureUnit: 'fahrenheit',
			});
			expect(await k.ctx.family.settings()).toMatchObject({
				formatLocale: 'en-GB',
				weekStart: 7,
				hourCycle: 'h12',
				temperatureUnit: 'fahrenheit',
			});
		});

		it('changes with core.settings.manage only and validates every choice', async () => {
			const { actor: admin } = await k.member('admin');
			const { actor: child } = await k.member('member');
			await expect(
				k.runner.invoke('core.updateFamilySettings', { weekStart: 7 }, child),
			).rejects.toMatchObject({ code: 'forbidden' });
			await k.runner.invoke(
				'core.updateFamilySettings',
				{ formatLocale: 'fr-FR', weekStart: 1, hourCycle: 'h23' },
				admin,
			);
			expect(await k.ctx.family.settings()).toMatchObject({
				formatLocale: 'fr-FR',
				weekStart: 1,
				hourCycle: 'h23',
			});
			for (const bad of [
				{ formatLocale: 'not a locale' },
				{ formatLocale: 'en_US' },
				{ weekStart: 0 },
				{ weekStart: 8 },
				{ hourCycle: 'h24' },
				{ temperatureUnit: 'kelvin' },
			]) {
				await expect(
					k.runner.invoke('core.updateFamilySettings', bad, admin),
					JSON.stringify(bad),
				).rejects.toMatchObject({ code: 'bad_request' });
			}
		});
	});
});

describe('family name', () => {
	it('is optional, trimmed, and cleared by an empty name', async () => {
		const { actor: admin } = await k.member('admin');
		expect((await k.ctx.family.settings()).name).toBeUndefined();
		const set = (name: string) => k.runner.invoke('core.setFamilyName', { name }, admin);
		expect(await set('  The Novaks ')).toMatchObject({
			status: 'applied',
			output: { name: 'The Novaks' },
		});
		expect((await k.ctx.family.settings()).name).toBe('The Novaks');
		// The other settings are kept when the name changes, and the name when they change.
		await k.runner.invoke('core.updateFamilySettings', { timeZone: 'Europe/Berlin' }, admin);
		expect(await k.ctx.family.settings()).toMatchObject({
			name: 'The Novaks',
			timeZone: 'Europe/Berlin',
		});
		expect(await set('')).toMatchObject({ output: { name: null } });
		expect((await k.ctx.family.settings()).name).toBeUndefined();
		await expect(set('x'.repeat(61))).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('is changed only by someone who manages settings', async () => {
		const { actor: member } = await k.member('member');
		await expect(
			k.runner.invoke('core.setFamilyName', { name: 'Ours' }, member),
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});
