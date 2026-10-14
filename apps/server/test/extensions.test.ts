import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestKernel } from '@famos/testing';
import { describe, expect, it } from 'vitest';
import { extensions } from '../src/extensions.ts';
import { catalogsOf } from '../src/i18n.ts';

const { english } = catalogsOf(extensions);
const catalog = (namespace: string): Record<string, unknown> => english[namespace] ?? {};

describe('bundled extensions', () => {
	it('each bring their English texts under their own id', () => {
		for (const ext of extensions) expect(ext.messages?.en, ext.id).toBeTruthy();
		expect(Object.keys(english).sort()).toEqual(['app', ...extensions.map((e) => e.id)].sort());
	});

	// The server reaches what extensions bring (catalogs included) through the list it loads, so
	// leaving one out of that list leaves it out entirely.
	it('are named only by the list the server loads', () => {
		const src = join(import.meta.dirname, '../src');
		const naming = readdirSync(src, { recursive: true, encoding: 'utf8' })
			.filter((file) => /\.ts$/.test(file))
			.filter((file) => readFileSync(join(src, file), 'utf8').includes('@famos/ext-'));
		expect(naming).toEqual(['extensions.ts']);
	});

	// AGENTS.md rule 8: what the AI may propose can be taken back after it was approved.
	it('declare undo for every data-changing action the AI may propose', () => {
		const missing = extensions.flatMap((ext) =>
			ext.actions.filter((a) => a.ai && !a.readOnly && !a.external && !a.undo).map((a) => a.id),
		);
		expect(missing).toEqual([]);
	});

	// A draft is titled by its presenter or its summary; this is what names it otherwise (a
	// remove or archive nobody wrote a presenter for) and what the "waiting" notice says.
	it('name every action that can become a draft with a translated title', async () => {
		const k = await createTestKernel({ extensions: [...extensions] });
		try {
			const proposable = [...k.registry.actions.values()].filter(
				(a) =>
					!a.readOnly &&
					!a.external &&
					(a.ai || (typeof a.approval !== 'string' ? true : a.approval === 'always')),
			);
			expect(proposable.length).toBeGreaterThan(50);
			const problems = proposable.flatMap((a) => {
				if (!a.draftTitle) return [`${a.id} has no draftTitle`];
				const [namespace = '', key = ''] = a.draftTitle.split(':');
				return catalog(namespace)[key] ? [] : [`${a.id}: ${a.draftTitle} is not in en.json`];
			});
			expect(problems).toEqual([]);
		} finally {
			await k.close();
		}
	});
});
