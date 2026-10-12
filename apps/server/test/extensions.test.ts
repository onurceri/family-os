import { readFileSync } from 'node:fs';
import { createTestKernel } from '@famos/testing';
import { describe, expect, it } from 'vitest';
import { extensions } from '../src/extensions.ts';

const repo = new URL('../../../', import.meta.url);
const catalog = (namespace: string): Record<string, string> =>
	JSON.parse(
		readFileSync(
			new URL(
				namespace === 'app'
					? 'apps/web/src/messages/en.json'
					: `extensions/${namespace}/src/messages/en.json`,
				repo,
			),
			'utf8',
		),
	);

describe('bundled extensions', () => {
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
