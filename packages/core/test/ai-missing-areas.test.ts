import { type AiAreaAccess, parseManifest } from '@famos/sdk';
import { describe, expect, it } from 'vitest';
import { aiMissingAreas } from '../src/ai-missing-areas.ts';
import type { ExtensionPackage } from '../src/extension-state.ts';

const pkg = (id: string, name: string, description: string): ExtensionPackage => ({
	id,
	version: '0.1.0',
	always: false,
	manifest: parseManifest({ id, version: '0.1.0', sdk: '^0.6.0' }),
	labels: { en: { name, description }, tr: { name: `${name} (tr)`, description: '' } },
});

const catalogs: Record<string, string> = {
	'pets:feature_name': 'Pets',
	'pets:feature_description': 'Your pets, their vets and treatments.',
};

function missing(options: {
	loaded: string[];
	off?: string[];
	access?: Record<string, AiAreaAccess>;
	local?: boolean;
}) {
	return aiMissingAreas(
		{
			loaded: ['core', ...options.loaded],
			packages: [
				pkg('home', 'Home', 'The homes of the household and their papers.'),
				pkg('pets', 'Pets', 'From the package.'),
				pkg('vehicles', 'Vehicles', 'Cars and their inspections.'),
			],
			isOn: (id) => !options.off?.includes(id),
			access: (id) => options.access?.[id] ?? 'any',
			translate: (_locale, key) => catalogs[key] ?? key,
		},
		options.local === true,
	);
}

describe('the areas the AI cannot look into', () => {
	it('names what can be installed but is not, from its package', () => {
		// Mara uninstalled Home and asked for the flat papers: the assistant must know Home exists.
		expect(missing({ loaded: ['pets', 'vehicles'] })).toEqual([
			{
				id: 'home',
				name: 'Home',
				description: 'The homes of the household and their papers.',
				why: 'not_installed',
			},
		]);
	});

	it('names what is turned off or closed to the AI, from its own catalog', () => {
		expect(
			missing({
				loaded: ['home', 'pets', 'vehicles', 'calendar'],
				off: ['pets'],
				access: { vehicles: 'local', calendar: 'off' },
			}),
		).toEqual([
			{ id: 'calendar', name: 'calendar', description: '', why: 'closed_to_ai' },
			{
				id: 'pets',
				name: 'Pets',
				description: 'Your pets, their vets and treatments.',
				why: 'turned_off',
			},
			{
				id: 'vehicles',
				name: 'Vehicles',
				description: 'Cars and their inspections.',
				why: 'closed_to_ai',
			},
		]);
	});

	it('opens local-only areas to a model on the family network', () => {
		expect(
			missing({ loaded: ['home', 'pets', 'vehicles'], access: { vehicles: 'local' }, local: true }),
		).toEqual([]);
	});
});
