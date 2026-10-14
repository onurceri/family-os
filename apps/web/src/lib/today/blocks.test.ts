import type { TodayBlockContribution } from '@famos/ui/slots';
import { describe, expect, it } from 'vitest';
import {
	BUILT_IN_BLOCKS,
	blockOfCard,
	everythingHidden,
	shows,
	todayBlocks,
	withBlock,
} from './blocks.js';

const cards = [
	{ id: 'inbox.waiting', band: 'needs' as const },
	{ id: 'lists.overdue', band: 'needs' as const },
	{ id: 'chores.today', band: 'notes' as const, block: 'chores' },
	{ id: 'lists.tasks', band: 'notes' as const, labelKey: 'lists:today_block_tasks' },
	{ id: 'board.today', band: 'notes' as const },
	{ id: 'records.comingUp', band: 'ahead' as const, labelKey: 'records:today_block' },
];
const added: TodayBlockContribution[] = [
	{ id: 'kitchen', labelKey: 'kitchen:today_block', order: 100, items: 'meal' },
	{ id: 'chores', labelKey: 'chores:today_block', order: 80 },
];
const provided = { weather: true, photo: true };
const extensionLabel = (id: string) => `${id}:label`;

describe('which block decides whether a card shows', () => {
	it('puts the needs band under Needs you and a card under the block it names', () => {
		expect(blockOfCard(cards[0] as (typeof cards)[number])).toBe('needs');
		expect(blockOfCard({ id: 'chores.today', block: 'chores' })).toBe('chores');
		expect(blockOfCard({ id: 'pets.today', band: 'notes' })).toBe('pets.today');
	});
});

describe('the blocks a viewer chooses from', () => {
	it("places the extensions' blocks among the app's own, then each card that is a block of its own, once", () => {
		const ids = todayBlocks([...cards, cards[3] as (typeof cards)[number]], {
			added,
			provided,
			extensionLabel,
		}).map((b) => b.id);
		expect(ids).toEqual([
			'clock',
			'greeting',
			'weather',
			'photo',
			'next',
			'day',
			'family',
			'chores',
			'needs',
			'kitchen',
			'nextDays',
			'done',
			'lists.tasks',
			'board.today',
			'records.comingUp',
		]);
	});

	it('keeps the blocks of the app when no extension adds any', () => {
		const ids = todayBlocks([], { provided }).map((b) => b.id);
		expect(ids).toEqual([...BUILT_IN_BLOCKS]);
	});

	it("names a card by its own label, else by its extension's name", () => {
		const blocks = todayBlocks(cards, { added, extensionLabel });
		expect(blocks.find((b) => b.id === 'lists.tasks')?.labelKey).toBe('lists:today_block_tasks');
		expect(blocks.find((b) => b.id === 'board.today')?.labelKey).toBe('board:label');
		expect(blocks.find((b) => b.id === 'chores')?.labelKey).toBe('chores:today_block');
	});

	it("leaves out a display's person-only blocks and the weather and photo nothing provides", () => {
		const ids = todayBlocks([], { familyMode: true, provided: { weather: true } }).map((b) => b.id);
		expect(ids).not.toContain('greeting');
		expect(ids).not.toContain('needs');
		expect(ids).not.toContain('photo');
		expect(ids).toContain('weather');
		expect(ids).toContain('clock');
	});
});

describe('hiding and showing', () => {
	it('shows unknown and new blocks by default', () => {
		expect(shows([], 'garden.today')).toBe(true);
		expect(shows(new Set(['weather']), 'weather')).toBe(false);
		expect(shows(['weather'], 'clock')).toBe(true);
	});

	it('keeps ids it does not know when one block changes', () => {
		expect(withBlock(['garden.today'], 'weather', false)).toEqual(['garden.today', 'weather']);
		expect(withBlock(['garden.today', 'weather'], 'weather', true)).toEqual(['garden.today']);
		expect(withBlock(['weather'], 'weather', false)).toEqual(['weather']);
	});

	it('knows when everything is hidden', () => {
		const blocks = todayBlocks(cards, { added, provided, extensionLabel });
		const all = blocks.map((b) => b.id);
		expect(everythingHidden(blocks, all)).toBe(true);
		expect(everythingHidden(blocks, all.slice(1))).toBe(false);
		expect(everythingHidden([], [])).toBe(false);
	});
});
