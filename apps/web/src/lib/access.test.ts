import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AccessDecision, accessOf, inputKey } from './access.js';
import { AccessBook, type AccessSource } from './access-book.js';

describe('what a decision means for a control', () => {
	it('maps the three outcomes', () => {
		expect(accessOf({ outcome: 'apply' })).toBe('apply');
		expect(accessOf({ outcome: 'draft' })).toBe('suggest');
		expect(accessOf({ outcome: 'refuse' })).toBe('no');
	});

	it('offers nothing for an action the server does not list', () => {
		expect(accessOf(undefined)).toBe('no');
	});

	it('says depends until an input has been given', () => {
		const owned: AccessDecision = { outcome: 'draft', depends: true };
		expect(accessOf(owned)).toBe('depends');
		expect(accessOf(owned, true)).toBe('suggest');
		expect(accessOf({ outcome: 'refuse', depends: true }, true)).toBe('no');
	});
});

describe('the key of an input', () => {
	it('is the same whatever order the fields were written in', () => {
		expect(inputKey('a', { x: 1, y: [1, { b: 2, a: 1 }] })).toBe(
			inputKey('a', { y: [1, { a: 1, b: 2 }], x: 1 }),
		);
	});

	it('tells actions and inputs apart', () => {
		expect(inputKey('a', { id: 1 })).not.toBe(inputKey('b', { id: 1 }));
		expect(inputKey('a', { id: 1 })).not.toBe(inputKey('a', { id: 2 }));
	});

	it('leaves undefined fields out', () => {
		expect(inputKey('a', { id: 1, note: undefined })).toBe(inputKey('a', { id: 1 }));
	});
});

describe('the access book', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const book = (
		all: Record<string, AccessDecision>,
		check: AccessSource['check'] = async () => ({ outcome: 'apply' }),
	) => {
		const source = { all: vi.fn(async () => all), check: vi.fn(check) };
		return { book: new AccessBook(source, undefined, () => Date.now(), 250), source };
	};

	it('answers no for everything before it has been read', () => {
		const { book: empty } = book({});
		expect(empty.access('lists.addTask')).toBe('no');
	});

	it('answers from the static decisions once read', async () => {
		const { book: b } = book({
			'pets.addPet': { outcome: 'apply' },
			'pets.updatePet': { outcome: 'draft' },
			'pets.archivePet': { outcome: 'refuse' },
		});
		await b.load();
		expect(b.access('pets.addPet')).toBe('apply');
		expect(b.access('pets.updatePet')).toBe('suggest');
		expect(b.access('pets.archivePet')).toBe('no');
		expect(b.access('pets.unknown')).toBe('no');
	});

	it('keeps what it knew when a read fails, and forgets on clear', async () => {
		const { book: b, source } = book({ 'a.b': { outcome: 'apply' } });
		await b.load();
		source.all.mockRejectedValueOnce(new Error('offline'));
		await b.load();
		expect(b.access('a.b')).toBe('apply');
		b.clear();
		expect(b.access('a.b')).toBe('no');
	});

	it('does not ask the server where the static answer already decides', async () => {
		const { book: b, source } = book({ 'a.b': { outcome: 'refuse' } });
		await b.load();
		expect(b.accessFor('a.b', { id: 1 })).toBe('no');
		await vi.advanceTimersByTimeAsync(1000);
		expect(source.check).not.toHaveBeenCalled();
	});

	it('asks for the exact answer when it depends, once the input has settled', async () => {
		const { book: b, source } = book(
			{ 'lists.deleteTask': { outcome: 'draft', depends: true } },
			async () => ({ outcome: 'apply', reason: 'owner' }) as AccessDecision,
		);
		await b.load();
		expect(b.accessFor('lists.deleteTask', { id: 't1' })).toBe('depends');
		expect(source.check).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(260);
		expect(source.check).toHaveBeenCalledTimes(1);
		expect(b.accessFor('lists.deleteTask', { id: 't1' })).toBe('apply');
		// Asked again with the same input: answered from what it knows.
		expect(source.check).toHaveBeenCalledTimes(1);
	});

	it('asks only for the last input while a form is still changing', async () => {
		const { book: b, source } = book({ 'a.b': { outcome: 'draft', depends: true } });
		await b.load();
		b.accessFor('a.b', { v: 'a' });
		await vi.advanceTimersByTimeAsync(100);
		b.accessFor('a.b', { v: 'ab' });
		await vi.advanceTimersByTimeAsync(100);
		b.accessFor('a.b', { v: 'abc' });
		await vi.advanceTimersByTimeAsync(300);
		expect(source.check).toHaveBeenCalledTimes(1);
		expect(source.check).toHaveBeenCalledWith('a.b', { v: 'abc' });
	});

	it('goes on with the general answer when the check fails, and asks again later', async () => {
		const { book: b, source } = book({ 'a.b': { outcome: 'draft', depends: true } }, async () => {
			throw new Error('boom');
		});
		await b.load();
		expect(b.accessFor('a.b', { id: 1 })).toBe('depends');
		await vi.advanceTimersByTimeAsync(300);
		expect(b.accessFor('a.b', { id: 1 })).toBe('depends');
		await vi.advanceTimersByTimeAsync(16_000);
		b.accessFor('a.b', { id: 1 });
		await vi.advanceTimersByTimeAsync(300);
		expect(source.check).toHaveBeenCalledTimes(2);
	});

	it('forgets exact answers when the static ones are read again', async () => {
		const { book: b, source } = book({ 'a.b': { outcome: 'draft', depends: true } });
		await b.load();
		b.accessFor('a.b', { id: 1 });
		await vi.advanceTimersByTimeAsync(300);
		expect(b.accessFor('a.b', { id: 1 })).toBe('apply');
		await b.load();
		expect(b.accessFor('a.b', { id: 1 })).toBe('depends');
		await vi.advanceTimersByTimeAsync(300);
		expect(source.check).toHaveBeenCalledTimes(2);
	});
});
