import { describe, expect, it } from 'vitest';
import { unflatten } from '../src/catalog.ts';
import { validatePack } from '../src/index.ts';

const prototypeUntouched = () => {
	const probe = {} as Record<string, unknown>;
	expect(probe.polluted).toBeUndefined();
	expect(probe.greeting).toBeUndefined();
	expect(Object.getPrototypeOf(probe)).toBe(Object.prototype);
};

describe('a catalog cannot reach an object prototype', () => {
	it('leaves out `__proto__` paths and keeps every other key', () => {
		const catalog = unflatten(
			new Map([
				['__proto__.polluted', 'yes'],
				['app.__proto__.polluted', 'yes'],
				['app.constructor.name', 'kept'],
				['app.greeting', 'Hello'],
			]),
		);
		prototypeUntouched();
		expect(catalog).toEqual({ app: { constructor: { name: 'kept' }, greeting: 'Hello' } });
		expect(Object.getPrototypeOf(catalog.app)).toBe(Object.prototype);
	});

	it('a pack with `__proto__` keys changes nothing outside the pack', () => {
		const english = { app: { greeting: 'Hello' } };
		const catalogs = JSON.parse(
			'{"app":{"__proto__":{"polluted":"yes","greeting":"x"},"greeting":"Merhaba"}}',
		);
		const result = validatePack(
			{
				manifest: {
					code: 'tr',
					name: 'Turkish',
					nativeName: 'Türkçe',
					version: '1.0.0',
					famos: '>=0.1.0',
				},
				catalogs,
			},
			english,
		);
		prototypeUntouched();
		if (!result.ok) throw new Error(result.error);
		expect(result.pack.catalogs).toEqual({ app: { greeting: 'Merhaba' } });
	});
});
