import { describe, expect, it } from 'vitest';
import { coreChecks, hintChecks, type SetupFacts, splitChecks } from './setup-status.js';

const none: SetupFacts = {
	address: null,
	aiReading: false,
	backupTargets: 0,
	pinMembers: 0,
	familyDevices: 0,
	phoneReach: 0,
};
const doneOf = (facts: SetupFacts, secure: boolean) =>
	Object.fromEntries(coreChecks(facts, secure).map((c) => [c.id, c.done]));

describe('core checks', () => {
	it('start with the three that always apply, all missing, on a new family', () => {
		const checks = coreChecks(none, false);
		expect(checks.map((c) => [c.id, c.done])).toEqual([
			['address', false],
			['ai', false],
			['backup', false],
		]);
	});

	it('needs an https address and a secure page for the address', () => {
		const https = { ...none, address: 'https://famos.example' };
		expect(doneOf(https, true).address).toBe(true);
		// Opened by another address (a plain http one): the family address alone is not enough.
		expect(doneOf(https, false).address).toBe(false);
		expect(doneOf({ ...none, address: 'http://192.168.1.5:3000' }, true).address).toBe(false);
	});

	it('sends the address button to the published guide, and the others inside the app', () => {
		const [address, ai, backup] = coreChecks(none, false);
		expect(address).toMatchObject({
			external: true,
			href: expect.stringMatching(/guide\/https\.md$/),
		});
		expect([ai?.href, backup?.href]).toEqual(['/settings/ai', '/settings/backups']);
	});

	it('is met by a model for reading and by one enabled backup target', () => {
		expect(doneOf({ ...none, aiReading: true, backupTargets: 1 }, false)).toMatchObject({
			ai: true,
			backup: true,
		});
	});

	it('asks about PIN devices only when someone has a PIN', () => {
		expect(doneOf(none, false)).not.toHaveProperty('pin');
		expect(doneOf({ ...none, pinMembers: 1 }, false).pin).toBe(false);
		expect(doneOf({ ...none, pinMembers: 1, familyDevices: 1 }, false).pin).toBe(true);
	});

	it('asks whether notifications reach phones only with an https address', () => {
		expect(doneOf({ ...none, address: 'http://home.lan' }, true)).not.toHaveProperty('phones');
		const https = { ...none, address: 'https://famos.example' };
		expect(doneOf(https, true).phones).toBe(false);
		expect(doneOf({ ...https, phoneReach: 2 }, true).phones).toBe(true);
	});

	it('says what a missing check breaks, and asks for the page the button opens', () => {
		const all = coreChecks({ ...none, address: 'https://famos.example', pinMembers: 1 }, true);
		for (const check of all) expect(check.breaksKey).toBeTruthy();
		expect(all.find((c) => c.id === 'ai')?.requires).toBe('core.ai.manage');
	});
});

describe('extension steps', () => {
	const hint = {
		id: 'ambient.place',
		titleKey: 'ambient:setup_step',
		textKey: 'ambient:setup_step_text',
		actionKey: 'ambient:setup_step_action',
		href: '/settings/photos-weather',
		requires: 'ambient.manage',
	};

	it('become checks with their own keys once answered, and wait while they are not', () => {
		expect(hintChecks([hint], {})).toEqual([]);
		expect(hintChecks([hint], { 'ambient.place': false })).toEqual([
			{
				id: 'ambient.place',
				titleKey: 'ambient:setup_step',
				textKey: 'ambient:setup_step_text',
				actionKey: 'ambient:setup_step_action',
				done: false,
				href: '/settings/photos-weather',
				requires: 'ambient.manage',
			},
		]);
	});
});

describe('split', () => {
	it('puts what is missing first and keeps the order', () => {
		const { missing, done } = splitChecks(coreChecks({ ...none, aiReading: true }, false));
		expect(missing.map((c) => c.id)).toEqual(['address', 'backup']);
		expect(done.map((c) => c.id)).toEqual(['ai']);
	});
});
