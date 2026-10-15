import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestKernel } from '@famos/testing';
import { describe, expect, it } from 'vitest';
import { catalogsOf } from '../src/i18n.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

const { english } = catalogsOf(extensions);
const catalog = (namespace: string): Record<string, unknown> => english[namespace] ?? {};

describe('the extensions', () => {
	it('each bring their English texts under their own id', () => {
		for (const ext of extensions) expect(ext.messages?.en, ext.id).toBeTruthy();
		expect(Object.keys(english).sort()).toEqual(['app', ...extensions.map((e) => e.id)].sort());
	});

	// The server loads extensions from packages it finds at start; it names none of them, so an
	// extension that is not installed is simply not there.
	it('are named nowhere in the server', () => {
		const src = join(import.meta.dirname, '../src');
		const naming = readdirSync(src, { recursive: true, encoding: 'utf8' })
			.filter((file) => /\.ts$/.test(file))
			.filter((file) => readFileSync(join(src, file), 'utf8').includes('@famos/ext-'));
		expect(naming).toEqual([]);
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
