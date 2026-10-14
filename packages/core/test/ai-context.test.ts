import { defineAction, defineCapability, systemActor } from '@famos/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildRegistry } from '../src/registry.ts';
import { createTestKernel, defineTestExtension } from './harness.ts';

const edit = defineCapability({ id: 'garage.edit', label: 'garage:cap_edit', level: 'edit' });
const context = (readOnly = true) =>
	defineAction({
		id: 'garage.aiContext',
		title: 'Garage context',
		input: z.object({}),
		output: z.object({}),
		readOnly,
		...(readOnly ? {} : { requires: edit.id }),
		run: async () => ({}),
	});

describe('AI record context (extension.ai.context)', () => {
	it('must name a read-only action of the same extension', () => {
		expect(() =>
			buildRegistry([defineTestExtension({ id: 'garage', ai: { context: 'garage.aiContext' } })]),
		).toThrow(/which it lacks/);
		expect(() =>
			buildRegistry([
				defineTestExtension({
					id: 'garage',
					actions: [context(false)],
					capabilities: [edit],
					ai: { context: 'garage.aiContext' },
				}),
			]),
		).toThrow(/read-only/);
		expect(() =>
			defineTestExtension({
				id: 'garage',
				actions: [context()],
				ai: { context: 'other.aiContext' },
			}),
		).toThrow(/namespaced/);
		expect(() =>
			buildRegistry([
				defineTestExtension({
					id: 'garage',
					actions: [context()],
					ai: { context: 'garage.aiContext' },
				}),
			]),
		).not.toThrow();
	});

	it('is listed for extensions that are on, and not for those turned off', async () => {
		const k = await createTestKernel({
			extensions: [
				defineTestExtension({
					id: 'garage',
					actions: [context()],
					ai: { context: 'garage.aiContext' },
				}),
			],
		});
		try {
			expect([...k.ctx.actions.aiContextActions()]).toEqual([['garage', ['garage.aiContext']]]);
			await k.runner.invoke(
				'core.setFeatureEnabled',
				{ extensionId: 'garage', enabled: false },
				systemActor('test'),
			);
			expect(k.ctx.actions.aiContextActions().size).toBe(0);
		} finally {
			await k.close();
		}
	});
});
