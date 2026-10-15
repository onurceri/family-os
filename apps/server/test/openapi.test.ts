import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ownerOfPath, splitOpenApi } from '../src/openapi.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

const doc = {
	openapi: '3.1.0',
	info: { title: 'FamilyOS API', version: 'v1' },
	components: { securitySchemes: { session: { type: 'apiKey' } } },
	paths: {
		'/api/v1/core/members': { get: {} },
		'/api/v1/actions/core.addMember': { post: {} },
		'/api/v1/backups': { get: {} },
		'/api/v1/calendar/occurrences': { get: {} },
		'/api/v1/actions/calendar.addEvent': { post: {} },
		'/api/v1/calendarish/x': { get: {} },
	},
};

describe('splitting the OpenAPI document', () => {
	it('names the owner of a route and of an action', () => {
		expect(ownerOfPath('/api/v1/calendar/occurrences')).toBe('calendar');
		expect(ownerOfPath('/api/v1/actions/calendar.addEvent')).toBe('calendar');
		expect(ownerOfPath('/api/v1/backups')).toBe('backups');
		expect(ownerOfPath('/api/openapi.json')).toBeNull();
	});

	it('gives each extension its routes and actions and leaves the rest to the host', () => {
		const { host, extensions: parts } = splitOpenApi(doc, ['calendar', 'lists']);
		expect(Object.keys(host.paths)).toEqual([
			'/api/v1/core/members',
			'/api/v1/actions/core.addMember',
			'/api/v1/backups',
			'/api/v1/calendarish/x',
		]);
		const calendar = parts.get('calendar');
		expect(Object.keys(calendar?.paths ?? {})).toEqual([
			'/api/v1/calendar/occurrences',
			'/api/v1/actions/calendar.addEvent',
		]);
		expect(calendar?.info.title).toBe('FamilyOS API: calendar');
		expect(calendar?.components).toEqual(doc.components);
		// An extension without routes still gets a document, so its types always exist.
		expect(parts.get('lists')?.paths).toEqual({});
	});
});

describe('the committed documents', () => {
	const root = join(import.meta.dirname, '../../..');
	const read = (file: string) =>
		JSON.parse(readFileSync(join(root, file), 'utf8')) as { paths: Record<string, unknown> };

	it("hold no extension's routes in the host's document", () => {
		const ids = new Set(extensions.map((e) => e.id));
		const owners = Object.keys(read('apps/server/openapi.json').paths).map(ownerOfPath);
		expect(owners.filter((owner) => owner && ids.has(owner))).toEqual([]);
	});

	it('give every extension a document of only its own paths', () => {
		for (const { id } of extensions) {
			const owners = new Set(
				Object.keys(read(`extensions/${id}/openapi.json`).paths).map(ownerOfPath),
			);
			expect(
				[...owners].filter((owner) => owner !== id),
				id,
			).toEqual([]);
		}
	});
});
