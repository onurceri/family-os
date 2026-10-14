import { defineAction, defineCapability, systemActor } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jobLog, noteAdded, notesExtension } from './fixtures.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

/** Listens to notes events, and offers an AI action, to see both stop with their extension. */
const heard: string[] = [];
const watcherUse = defineCapability({ id: 'watcher.use', label: 'watcher:cap_use', level: 'use' });
const watcher = defineTestExtension({
	id: 'watcher',
	capabilities: [watcherUse],
	actions: [
		defineAction({
			id: 'watcher.ping',
			title: 'Ping',
			input: z.object({}),
			output: z.object({}),
			approval: { unless: watcherUse.id },
			ai: { description: 'Pings.' },
			async run() {
				return {};
			},
		}),
	],
	register(ctx) {
		ctx.events.on(noteAdded, ({ id }) => void heard.push(id));
	},
});

let k: TestKernel;
beforeEach(async () => {
	heard.length = 0;
	jobLog.length = 0;
	k = await createTestKernel({ extensions: [notesExtension, watcher] });
});
afterEach(() => k.close());

const setFeature = (extensionId: string, enabled: boolean, actor = systemActor('test')) =>
	k.runner.invoke('core.setFeatureEnabled', { extensionId, enabled }, actor);

describe('feature switches', () => {
	it('stops a turned-off extension without touching its data, and restores it', async () => {
		const { actor, member } = await k.member('admin');
		await k.runner.invoke('notes.addNote', { body: 'kept', withJob: true }, actor);
		expect(heard).toHaveLength(1);
		await setFeature('notes', false);

		// Actions answer "turned off"; capabilities are inactive; its jobs wait.
		await expect(k.runner.invoke('notes.countNotes', {}, actor)).rejects.toMatchObject({
			code: 'feature_off',
		});
		expect(k.access.can(actor, 'notes.edit')).toBe(false);
		const me = await k.route('core.getMe').call({ actor });
		expect(me.capabilities).not.toContain('notes.edit');
		expect(me.disabledExtensions).toEqual(['notes']);
		expect(member.id).toBe(me.id);
		expect(await k.worker.drain()).toBe(0);
		expect(jobLog).toEqual([]);

		await setFeature('notes', true);
		expect(await k.worker.drain()).toBe(1);
		expect(k.access.can(actor, 'notes.edit')).toBe(true);
		const count = await k.runner.invoke<{ count: number }>('notes.countNotes', {}, actor);
		expect(count.status === 'applied' && count.output.count).toBe(1);
	});

	it("drops a turned-off extension's actions from the AI catalog and its event handlers", async () => {
		const { actor } = await k.member('admin');
		expect(k.ctx.actions.aiCatalog().map((a) => a.id)).toContain('watcher.ping');
		await setFeature('watcher', false);
		expect(k.ctx.actions.aiCatalog().map((a) => a.id)).not.toContain('watcher.ping');
		await k.runner.invoke('notes.addNote', { body: 'x' }, actor);
		expect(heard).toHaveLength(0);
		await setFeature('watcher', true);
		await k.runner.invoke('notes.addNote', { body: 'y' }, actor);
		expect(heard).toHaveLength(1);
	});

	it('lists extensions; core cannot be turned off; only admins switch', async () => {
		const { actor: member } = await k.member('member');
		expect(await k.route('core.listFeatures').call()).toEqual([
			{ id: 'core', enabled: true, canDisable: false },
			{ id: 'notes', enabled: true, canDisable: true },
			{ id: 'watcher', enabled: true, canDisable: true },
		]);
		await expect(setFeature('core', false)).rejects.toMatchObject({ code: 'bad_request' });
		await expect(setFeature('nope', false)).rejects.toMatchObject({ code: 'bad_request' });
		await expect(setFeature('notes', false, member)).rejects.toMatchObject({ code: 'forbidden' });
	});
});
