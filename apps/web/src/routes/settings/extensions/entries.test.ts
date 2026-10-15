import { describe, expect, it } from 'vitest';
import {
	descriptionOf,
	type Entry,
	fileProblem,
	nameOf,
	neededBy,
	problemOf,
	reachOf,
	restartNeeded,
	type Staged,
	sections,
	stagedEntry,
	staysInside,
	updateOf,
} from './entries.js';

function entry(id: string, more: Partial<Entry> = {}): Entry {
	return {
		id,
		version: '0.1.0',
		status: 'loaded',
		reason: null,
		always: false,
		enabled: true,
		dependsOn: [],
		optional: [],
		reaches: { hosts: [], userUrls: false, local: false, calls: [], capabilities: [] },
		labels: { en: { name: id.toUpperCase(), description: `About ${id}` } },
		nextVersion: null,
		reasonCode: null,
		reasonParams: {},
		...more,
	};
}

describe('names', () => {
	const pets = entry('pets', {
		labels: {
			en: { name: 'Pets', description: 'Vaccinations and vet visits' },
			tr: { name: 'Evcil hayvanlar', description: 'Asilar ve veteriner' },
		},
	});

	it('prefers the running extension’s own catalog, then the package in the page’s language', () => {
		expect(nameOf(pets, { language: 'tr', loaded: { name: 'Hayvanlar' } })).toBe('Hayvanlar');
		expect(nameOf(pets, { language: 'tr' })).toBe('Evcil hayvanlar');
		expect(descriptionOf(pets, { language: 'tr' })).toBe('Asilar ve veteriner');
	});

	it('falls back to English, then to the id', () => {
		expect(nameOf(pets, { language: 'de' })).toBe('Pets');
		expect(nameOf(entry('x', { labels: {} }), { language: 'en' })).toBe('x');
		expect(descriptionOf(entry('x', { labels: {} }), { language: 'en' })).toBe('');
	});
});

describe('sections', () => {
	it('puts everything the family chose under Installed and the rest under Available, by name', () => {
		const list = [
			entry('vehicles', { status: 'available' }),
			entry('pets', { status: 'pending_install' }),
			entry('calendar', { always: true }),
			entry('ambient', { status: 'failed', reason: 'boom' }),
			entry('home', { status: 'available' }),
			entry('kitchen', { status: 'pending_uninstall' }),
		];
		const { installed, available } = sections(list, (e) => e.id);
		expect(installed.map((e) => e.id)).toEqual(['ambient', 'calendar', 'kitchen', 'pets']);
		expect(available.map((e) => e.id)).toEqual(['home', 'vehicles']);
	});
});

describe('what an extension reaches', () => {
	it('names its hosts, typed addresses, the home network and the permissions it adds', () => {
		const calendar = entry('calendar', {
			reaches: {
				hosts: [],
				userUrls: true,
				local: true,
				calls: [],
				capabilities: ['calendar.view', 'calendar.edit'],
			},
		});
		const reach = reachOf(calendar, [calendar]);
		expect(reach).toMatchObject({ hosts: [], userUrls: true, local: true, capabilities: 2 });
		expect(staysInside(reach)).toBe(false);
		expect(staysInside(reachOf(entry('board'), []))).toBe(true);
	});

	it('says what installs alongside: what it needs that is not installed yet, the whole chain', () => {
		const records = entry('records', { status: 'available' });
		const papers = entry('papers', { status: 'available', dependsOn: ['records'] });
		const pets = entry('pets', { status: 'available', dependsOn: ['papers', 'records'] });
		const reach = reachOf(pets, [records, papers, pets]);
		expect(reach.needs).toEqual(['papers', 'records']);
		expect(reach.alongside).toEqual(['papers', 'records']);
		// Something installed already does not come along again.
		expect(reachOf(pets, [{ ...records, status: 'loaded' }, papers, pets]).alongside).toEqual([
			'papers',
		]);
	});

	it('works with the extensions it may use without needing them, never core or itself', () => {
		const kitchen = entry('kitchen', {
			status: 'available',
			dependsOn: ['records'],
			optional: ['lists'],
			reaches: {
				hosts: [],
				userUrls: false,
				local: false,
				calls: ['lists.addShoppingItems', 'calendar.listEvents', 'core.recallMemories'],
				capabilities: [],
			},
		});
		expect(reachOf(kitchen, [kitchen]).worksWith).toEqual(['lists', 'calendar']);
		const own = entry('pets', {
			dependsOn: ['records'],
			reaches: {
				hosts: [],
				userUrls: false,
				local: false,
				calls: ['records.addObligation', 'pets.other'],
				capabilities: [],
			},
		});
		expect(reachOf(own, [own]).worksWith).toEqual([]);
	});
});

describe('uninstalling and restarting', () => {
	it('finds the installed extensions that need one', () => {
		const records = entry('records');
		const list = [
			records,
			entry('pets', { dependsOn: ['records'] }),
			entry('home', { status: 'available', dependsOn: ['records'] }),
			entry('vehicles', { status: 'pending_uninstall', dependsOn: ['records'] }),
		];
		expect(neededBy(records, list).map((e) => e.id)).toEqual(['pets']);
	});

	it('needs a restart while something waits to be installed or uninstalled', () => {
		expect(restartNeeded([entry('a'), entry('b', { status: 'failed' })])).toBe(false);
		expect(restartNeeded([entry('a', { status: 'pending_install' })])).toBe(true);
		expect(restartNeeded([entry('a', { status: 'pending_uninstall' })])).toBe(true);
		// A newer version installed from a file loads at the next start too.
		expect(restartNeeded([entry('a', { nextVersion: '0.2.0' })])).toBe(true);
	});
});

describe('a package from a file', () => {
	const staged: Staged = {
		digest: 'a'.repeat(32),
		id: 'garden',
		version: '1.2.0',
		current: null,
		labels: { en: { name: 'Garden', description: 'Watering and seeds' } },
		dependsOn: ['records'],
		optional: ['calendar'],
		reaches: {
			hosts: ['seeds.example.org'],
			userUrls: false,
			local: false,
			calls: [],
			capabilities: ['garden.view'],
		},
		signer: { keyId: '0123456789abcdef', kind: 'official' },
	};

	it('shows like an extension that can be installed, with what installs alongside', () => {
		const shown = stagedEntry(staged);
		expect(shown).toMatchObject({ id: 'garden', version: '1.2.0', status: 'available' });
		expect(nameOf(shown, { language: 'tr' })).toBe('Garden');
		const list = [entry('records', { status: 'available' }), entry('calendar')];
		expect(reachOf(shown, list)).toMatchObject({
			hosts: ['seeds.example.org'],
			capabilities: 1,
			alongside: ['records'],
			worksWith: ['calendar'],
		});
	});

	it('says whether it updates one the server has', () => {
		expect(updateOf(staged)).toBeNull();
		expect(updateOf({ ...staged, current: '1.0.0' })).toEqual({ from: '1.0.0', to: '1.2.0' });
		expect(updateOf({ ...staged, current: '1.2.0' })).toBeNull();
	});

	it('explains each refusal from its codes, never the server’s words', () => {
		const bad = (details: Record<string, string>) => ({ status: 400, details });
		expect(fileProblem({ status: 413 })).toEqual({
			headline: { key: 'extensions_file_too_large' },
		});
		expect(fileProblem(bad({ reason: 'unsigned', code: 'untrusted_key', keyId: 'ab12' }))).toEqual({
			headline: { key: 'extensions_file_unsigned' },
			detail: { key: 'extensions_file_untrusted_key', values: { keyId: 'ab12' } },
		});
		expect(
			fileProblem(bad({ reason: 'too_large', code: 'too_large', limitMb: '20' })).detail,
		).toEqual({ key: 'extensions_file_limit', values: { limitMb: '20' } });
		expect(
			fileProblem(bad({ reason: 'incompatible', code: 'sdk', needs: '^0.9.0', has: '0.4.0' })),
		).toEqual({
			headline: { key: 'extensions_file_incompatible' },
			detail: { key: 'extensions_file_sdk', values: { needs: '^0.9.0', has: '0.4.0' } },
		});
		expect(
			fileProblem(bad({ reason: 'invalid', code: 'file_mismatch', path: 'server/index.mjs' }))
				.detail,
		).toEqual({ key: 'extensions_file_changed', values: { path: 'server/index.mjs' } });
		// A code without a sentence of its own: the headline alone.
		expect(fileProblem(bad({ reason: 'invalid', code: 'not_gzip' }))).toEqual({
			headline: { key: 'extensions_file_invalid' },
		});
		expect(fileProblem({ status: 400 })).toEqual({ headline: { key: 'extensions_file_invalid' } });
		expect(fileProblem({ status: 409, details: { reason: 'older', version: '2.0.0' } })).toEqual({
			headline: { key: 'extensions_file_older', values: { version: '2.0.0' } },
		});
		expect(fileProblem({ status: 500 })).toEqual({ headline: { key: 'error_generic' } });
	});
});

describe('why an installed extension is left out', () => {
	const nameOfId = (id: string) => id.toUpperCase();

	it('says it by the reason’s code, naming another extension by its name', () => {
		expect(
			problemOf(
				entry('pets', {
					status: 'refused',
					reason: 'It needs "records", which was refused',
					reasonCode: 'dependency_refused',
					reasonParams: { extensionId: 'records' },
				}),
				nameOfId,
			),
		).toEqual({
			key: 'extensions_problem_dependency_refused',
			values: { extensionId: 'records', name: 'RECORDS' },
		});
		expect(
			problemOf(
				entry('pets', {
					status: 'failed',
					reasonCode: 'sdk',
					reasonParams: { needs: '^0.9.0', has: '0.4.0' },
				}),
				nameOfId,
			),
		).toEqual({ key: 'extensions_problem_sdk', values: { needs: '^0.9.0', has: '0.4.0' } });
	});

	it('says it generally without a code, and nothing for one that runs', () => {
		expect(
			problemOf(entry('pets', { status: 'failed', reason: 'disk says no' }), nameOfId),
		).toEqual({ key: 'extensions_problem_unknown' });
		expect(problemOf(entry('pets'), nameOfId)).toBeNull();
	});
});
