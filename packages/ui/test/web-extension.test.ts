import { describe, expect, it } from 'vitest';
import { defineWebExtension, type WebExtension } from '../src/slots.js';

const component = () => Promise.resolve({ default: (() => {}) as never });
const load = async () => [];

const define = (ext: Partial<WebExtension>) => () => defineWebExtension({ id: 'garden', ...ext });

describe('defineWebExtension', () => {
	it('takes an extension whose contributions are its own', () => {
		expect(
			define({
				blocks: [
					{ id: 'garden', labelKey: 'garden:block', order: 80 },
					{ id: 'garden.beds', labelKey: 'garden:beds', order: 85 },
				],
				slots: [
					{
						slot: 'dashboard.card',
						id: 'garden.today',
						glance: true,
						requires: 'garden.view',
						block: 'garden',
						component,
					},
				],
				today: [
					{ kind: 'photo', id: 'garden.photo', requires: 'garden.view', load: async () => null },
				],
				timeline: [{ id: 'garden.today', requires: 'garden.view', load }],
			}),
		).not.toThrow();
	});

	it("refuses presenters of other extensions' actions, core's included", () => {
		const presenter = { kind: () => '', title: () => '', fields: () => [] };
		expect(define({ drafts: [{ ...presenter, actionId: 'core.addMemory' }] })).toThrow(
			/core\.addMemory/,
		);
		expect(define({ drafts: [{ ...presenter, actionId: 'lists.addTask' }] })).toThrow(
			/lists\.addTask/,
		);
	});

	it('refuses facets, blocks and slots named for another extension', () => {
		expect(
			define({
				today: [{ kind: 'photo', id: 'ambient.photo', requires: 'x', load: async () => null }],
			}),
		).toThrow(/ambient\.photo/);
		expect(define({ blocks: [{ id: 'chores', labelKey: 'x', order: 1 }] })).toThrow(/chores/);
	});

	it('refuses a card or a facet that names a block the extension does not add', () => {
		expect(
			define({
				slots: [{ slot: 'dashboard.card', id: 'garden.today', block: 'weather', component }],
			}),
		).toThrow(/weather/);
		expect(
			define({
				today: [
					{
						kind: 'perMember',
						id: 'garden.watering',
						requires: 'garden.view',
						block: 'garden',
						titleKey: 'x',
						labelKey: 'x',
						ringKey: 'x',
						leftKey: 'x',
						load,
					},
				],
			}),
		).toThrow(/garden/);
	});
});
