import type { TodayFacet, WebExtension } from '@famos/ui/slots';
import { describe, expect, it } from 'vitest';
import {
	addPlacesFor,
	collect,
	enabledOnly,
	facetsOf,
	hasDay,
	matchPage,
	shareFor,
} from './contributions.js';

const component = () => Promise.resolve({ default: (() => {}) as never });
const none = async () => [];

const counts = (id: string, requires: string): TodayFacet => ({
	kind: 'perMember',
	id,
	requires,
	block: id.split('.')[0] as string,
	titleKey: 'x:title',
	labelKey: 'x:label',
	ringKey: 'x:ring',
	leftKey: 'x:left',
	load: none,
});

const garden: WebExtension = {
	id: 'garden',
	nav: [
		{ id: 'garden.nav', path: '/garden', labelKey: 'garden:nav', placement: 'more', order: 20 },
	],
	pages: [
		{ id: 'garden.page', path: '/garden', component },
		{ id: 'garden.bed', path: '/garden/:id', component },
	],
	timeline: [{ id: 'garden.today', requires: 'garden.view', load: none }],
	today: [
		counts('garden.watering', 'garden.view'),
		{ kind: 'photo', id: 'garden.photo', requires: 'garden.photos', load: async () => null },
	],
	blocks: [{ id: 'garden', labelKey: 'garden:block', order: 80 }],
};
const post: WebExtension = {
	id: 'post',
	nav: [
		{
			id: 'post.nav',
			path: '/post',
			labelKey: 'post:nav',
			placement: 'primary',
			order: 10,
			requires: 'post.share',
			share: true,
		},
	],
	timeline: [{ id: 'post.today', requires: 'post.view', load: none }],
	today: [counts('post.parcels', 'post.view')],
};

const viewer = (held: string[], off: string[] = []) => ({
	can: (capability: string) => held.includes(capability),
	disabledExtensions: off,
});

describe('collecting what extensions contribute', () => {
	it("gathers every kind of contribution, the app's own last, navigation in order", () => {
		const all = collect([garden, post], {
			slots: [{ slot: 'today.head', id: 'app.bell', component }],
		});
		expect(all.nav.map((n) => n.id)).toEqual(['post.nav', 'garden.nav']);
		expect([...all.pages.keys()]).toEqual(['/garden', '/garden/:id']);
		expect(all.timelines.map((t) => t.id)).toEqual(['garden.today', 'post.today']);
		expect(all.facets.map((f) => f.id)).toEqual([
			'garden.watering',
			'garden.photo',
			'post.parcels',
		]);
		expect(all.blocks.map((b) => b.id)).toEqual(['garden']);
		expect(all.slots.map((s) => s.id)).toEqual(['app.bell']);
		expect(all.share?.id).toBe('post.nav');
	});

	it('lists the offline reads of each extension under its own API', () => {
		const all = collect([{ ...garden, offlineReads: ['/beds', '/beds/:id/water'] }]);
		expect(all.offlineReads).toEqual(['/api/v1/garden/beds', '/api/v1/garden/beds/:id/water']);
		expect(collect([garden]).offlineReads).toEqual([]);
	});

	it('refuses two extensions with one id, two places to share and two pages on one path', () => {
		expect(() => collect([garden, garden])).toThrow(/garden/);
		const second = { ...post, id: 'mail', nav: post.nav?.map((n) => ({ ...n, id: 'mail.nav' })) };
		expect(() => collect([post, second])).toThrow(/share/);
		const twin = { id: 'twin', pages: [{ id: 'twin.page', path: '/garden', component }] };
		expect(() => collect([garden, twin])).toThrow(/\/garden/);
	});

	it("refuses two presenters of one action, the app's included", () => {
		const presenter = {
			actionId: 'core.addMemory',
			kind: () => '',
			title: () => '',
			fields: () => [],
		};
		const ext = { id: 'core-like', drafts: [presenter] };
		expect(() => collect([ext], { presenters: [presenter] })).toThrow(/core\.addMemory/);
	});
});

describe('what a viewer gets', () => {
	const all = collect([garden, post]);

	it('gives the first facet of a kind the viewer may see, from an extension that is on', () => {
		expect(facetsOf(all.facets, 'perMember', viewer(['garden.view', 'post.view']))[0]?.id).toBe(
			'garden.watering',
		);
		expect(facetsOf(all.facets, 'perMember', viewer(['post.view']))[0]?.id).toBe('post.parcels');
		expect(
			facetsOf(all.facets, 'perMember', viewer(['garden.view', 'post.view'], ['garden']))[0]?.id,
		).toBe('post.parcels');
		expect(facetsOf(all.facets, 'photo', viewer(['garden.view']))).toEqual([]);
	});

	it('gives every word-about-people facet the viewer may see, in extension order', () => {
		const note = (id: string, requires: string): TodayFacet => ({
			kind: 'memberStatus',
			id,
			requires,
			load: async () => [],
		});
		const facets = collect([
			{ id: 'home', today: [note('home.presence', 'home.presence')] },
			{ id: 'sport', today: [note('sport.practice', 'sport.view')] },
		]).facets;
		const ids = (held: string[], off: string[] = []) =>
			facetsOf(facets, 'memberStatus', viewer(held, off)).map((f) => f.id);
		expect(ids(['home.presence', 'sport.view'])).toEqual(['home.presence', 'sport.practice']);
		expect(ids(['sport.view'])).toEqual(['sport.practice']);
		expect(ids(['home.presence', 'sport.view'], ['home'])).toEqual(['sport.practice']);
		expect(facetsOf(all.facets, 'memberStatus', viewer(['garden.view', 'post.view']))).toEqual([]);
	});

	it('has a day when any timeline it may read is on', () => {
		expect(hasDay(all.timelines, viewer(['post.view']))).toBe(true);
		expect(hasDay(all.timelines, viewer(['garden.photos']))).toBe(false);
		expect(hasDay(all.timelines, viewer(['post.view'], ['post']))).toBe(false);
	});

	it('offers the place to share only when its extension is on and the viewer may share', () => {
		expect(shareFor(all.share, viewer(['post.share']))).toEqual({
			path: '/post',
			labelKey: 'post:nav',
		});
		expect(shareFor(all.share, viewer([]))).toBeUndefined();
		expect(shareFor(all.share, viewer(['post.share'], ['post']))).toBeUndefined();
	});

	it('offers the pages to add by hand whose action the viewer may run', () => {
		const nav = collect([
			{
				id: 'diary',
				nav: [
					{
						id: 'diary.nav',
						path: '/diary',
						labelKey: 'diary:nav',
						placement: 'primary',
						order: 10,
						adds: 'diary.addEntry',
						children: [
							{
								id: 'diary.notes',
								path: '/diary/notes',
								labelKey: 'diary:notes',
								adds: 'diary.addNote',
							},
							{ id: 'diary.old', path: '/diary/old', labelKey: 'diary:old' },
						],
					},
				],
			},
			{ id: 'garden', nav: garden.nav ?? [] },
		]).nav;
		const places = (refused: string[], off: string[] = []) =>
			addPlacesFor(nav, {
				...viewer([], off),
				access: (id) => (refused.includes(id) ? 'no' : 'apply'),
			}).map((p) => p.path);
		expect(places([])).toEqual(['/diary', '/diary/notes']);
		expect(places(['diary.addEntry'])).toEqual(['/diary/notes']);
		expect(places([], ['diary'])).toEqual([]);
	});

	it('keeps the contributions of extensions that are on', () => {
		expect(enabledOnly(all.blocks, ['garden'])).toEqual([]);
		expect(enabledOnly(all.timelines, ['garden']).map((t) => t.id)).toEqual(['post.today']);
	});

	it('matches a page by its path, a pattern giving its params', () => {
		expect(matchPage('/garden/', all.pages)?.page.id).toBe('garden.page');
		expect(matchPage('/garden/bed%201', all.pages)).toMatchObject({
			page: { id: 'garden.bed' },
			params: { id: 'bed 1' },
		});
		expect(matchPage('/elsewhere', all.pages)).toBeUndefined();
	});
});
