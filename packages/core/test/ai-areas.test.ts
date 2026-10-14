import { type Actor, defineAction, defineCapability } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

/** One sensitive area  and one ordinary area, each with a view capability and an AI action. */
const ledgerView = defineCapability({ id: 'ledger.view', label: 'ledger:cap_view', level: 'view' });
const ledgerEdit = defineCapability({ id: 'ledger.edit', label: 'ledger:cap_edit', level: 'edit' });
const diaryView = defineCapability({ id: 'diary.view', label: 'diary:cap_view', level: 'view' });
const proposal = (id: string, unless: string) =>
	defineAction({
		id,
		title: id,
		input: z.object({}),
		output: z.object({}),
		approval: { unless },
		ai: { description: id },
		async run() {
			return {};
		},
	});
const reader = (id: string, requires: string, secret: string) =>
	defineAction({
		id,
		title: id,
		input: z.object({}),
		output: z.object({ text: z.string() }),
		readOnly: true,
		requires,
		async run() {
			return { text: secret };
		},
	});
const ledger = defineTestExtension({
	id: 'ledger',
	sensitive: true,
	capabilities: [ledgerView, ledgerEdit],
	actions: [
		proposal('ledger.addEntry', ledgerEdit.id),
		reader('ledger.readEntries', ledgerView.id, 'rent 950'),
		// A careless read with no `requires`: the area lock must still hold.
		defineAction({
			id: 'ledger.peek',
			title: 'peek',
			input: z.object({}),
			output: z.object({ text: z.string() }),
			readOnly: true,
			async run() {
				return { text: 'salary 4200' };
			},
		}),
	],
});
const diary = defineTestExtension({
	id: 'diary',
	capabilities: [diaryView],
	actions: [proposal('diary.addPage', diaryView.id), reader('diary.readPages', diaryView.id, 'x')],
});

const AI: Actor = { kind: 'ai', mode: 'share', source: 'inbox' };
let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [ledger, diary] });
});
afterEach(() => k.close());

const set = (
	actor: Actor,
	input: { extensionId: string; access: 'off' | 'local' | 'any'; confirmSensitive?: boolean },
) => k.runner.invoke('core.setAiAreaAccess', input, actor);
const catalog = (options?: { local?: boolean }) =>
	k.ctx.actions
		.aiCatalog(options)
		.map((a) => a.id)
		.sort();

describe('AI areas', () => {
	it('start Off for sensitive extensions and Any provider for the rest', async () => {
		const { actor } = await k.member('admin');
		const areas = await k.route('core.listAiAreas').call({ actor });
		expect(areas).toEqual([
			{
				id: 'diary',
				sensitive: false,
				usesAi: true,
				access: 'any',
				default: 'any',
			},
			{
				id: 'ledger',
				sensitive: true,
				usesAi: true,
				access: 'off',
				default: 'off',
			},
		]);
		expect(k.aiAreas.access('ledger')).toBe('off');
		expect(k.aiAreas.access('diary')).toBe('any');
		// Core is not an area and is never closed.
		expect(k.aiAreas.access('core')).toBe('any');
	});

	it('closes an area to AI actors in access control, not to people', async () => {
		const { actor: admin } = await k.member('admin');
		const { actor: member } = await k.member('member');
		expect(k.access.can(AI, 'ledger.view')).toBe(false);
		expect(k.access.can(AI, 'diary.view')).toBe(true);
		// AI still only reads.
		expect(k.access.can(AI, 'ledger.edit')).toBe(false);
		expect(k.access.can(admin, 'ledger.view')).toBe(true);
		expect(k.access.can(member, 'ledger.view')).toBe(true);

		await set(admin, { extensionId: 'diary', access: 'off' });
		expect(k.access.can(AI, 'diary.view')).toBe(false);
		expect(k.access.can(member, 'diary.view')).toBe(true);
		// Core's own capabilities stay available to the AI actor's level rule.
		expect(k.access.can(AI, 'core.members.view')).toBe(true);

		// `local` does not block here; the model adapter checks the provider.
		await set(admin, { extensionId: 'diary', access: 'local' });
		expect(k.access.can(AI, 'diary.view')).toBe(true);
	});

	it('checks AI actors like members when they read through actions', async () => {
		const { actor: admin } = await k.member('admin');
		const invoke = (id: string, actor: Actor) => k.runner.invoke(id, {}, actor);
		// A sensitive area starts off: the AI is refused, people are not.
		await expect(invoke('ledger.readEntries', AI)).rejects.toMatchObject({ code: 'forbidden' });
		await expect(invoke('ledger.readEntries', admin)).resolves.toMatchObject({
			output: { text: 'rent 950' },
		});
		// Ordinary areas start open.
		await expect(invoke('diary.readPages', AI)).resolves.toMatchObject({ status: 'applied' });

		await set(admin, { extensionId: 'ledger', access: 'any', confirmSensitive: true });
		await expect(invoke('ledger.readEntries', AI)).resolves.toMatchObject({
			output: { text: 'rent 950' },
		});
		await set(admin, { extensionId: 'diary', access: 'off' });
		await expect(invoke('diary.readPages', AI)).rejects.toMatchObject({ code: 'forbidden' });
		await expect(invoke('diary.readPages', admin)).resolves.toMatchObject({ status: 'applied' });
	});

	it('still turns AI proposals of data-changing actions into drafts', async () => {
		const { actor: admin } = await k.member('admin');
		await set(admin, { extensionId: 'ledger', access: 'any', confirmSensitive: true });
		await expect(k.runner.invoke('ledger.addEntry', {}, AI)).resolves.toMatchObject({
			status: 'drafted',
		});
	});

	it('filters the AI catalog by area', async () => {
		const { actor: admin } = await k.member('admin');
		expect(catalog()).toEqual(['diary.addPage']);
		expect(catalog({ local: true })).toEqual(['diary.addPage']);

		await set(admin, { extensionId: 'ledger', access: 'local' });
		expect(catalog()).toEqual(['diary.addPage']);
		expect(catalog({ local: false })).toEqual(['diary.addPage']);
		expect(catalog({ local: true })).toEqual(['diary.addPage', 'ledger.addEntry']);

		await set(admin, { extensionId: 'ledger', access: 'any', confirmSensitive: true });
		expect(catalog()).toEqual(['diary.addPage', 'ledger.addEntry']);

		await set(admin, { extensionId: 'diary', access: 'off' });
		expect(catalog({ local: true })).toEqual(['ledger.addEntry']);
	});

	it('validates the change and asks for confirmation to open a sensitive area', async () => {
		const { actor: admin } = await k.member('admin');
		const { actor: member } = await k.member('member');
		await expect(set(admin, { extensionId: 'nope', access: 'off' })).rejects.toMatchObject({
			code: 'bad_request',
		});
		await expect(set(admin, { extensionId: 'core', access: 'off' })).rejects.toMatchObject({
			code: 'bad_request',
		});
		await expect(set(admin, { extensionId: 'ledger', access: 'any' })).rejects.toMatchObject({
			code: 'bad_request',
			message: expect.stringContaining('confirmSensitive'),
		});
		expect(k.aiAreas.access('ledger')).toBe('off');
		// Local only needs no confirmation: the data stays in the house.
		await set(admin, { extensionId: 'ledger', access: 'local' });
		expect(k.aiAreas.access('ledger')).toBe('local');
		// Ordinary areas need none either.
		await set(admin, { extensionId: 'diary', access: 'any' });
		await set(admin, { extensionId: 'ledger', access: 'any', confirmSensitive: true });
		expect(k.aiAreas.access('ledger')).toBe('any');

		// Only people who manage AI (the route's `requires` is enforced by the server).
		await expect(set(member, { extensionId: 'diary', access: 'off' })).rejects.toMatchObject({
			code: 'forbidden',
		});
	});

	it('refreshes the cache after a change and survives a restart', async () => {
		const { actor: admin } = await k.member('admin');
		await set(admin, { extensionId: 'diary', access: 'off' });
		expect(k.aiAreas.access('diary')).toBe('off');
		const listed = await k.route('core.listAiAreas').call({ actor: admin });
		expect(listed.find((a: { id: string }) => a.id === 'diary')).toMatchObject({
			access: 'off',
			default: 'any',
		});
		// A fresh cache reads the stored choice.
		await k.aiAreas.refresh(k.ctx.db);
		expect(k.aiAreas.access('diary')).toBe('off');
	});
});

describe('locked areas are closed to the AI whatever their actions declare', () => {
	it('refuses reads without `requires` and drafts in an area that is off, and allows them when open', async () => {
		await expect(k.runner.invoke('ledger.peek', {}, AI)).rejects.toMatchObject({
			code: 'forbidden',
		});
		await expect(k.runner.invoke('ledger.addEntry', {}, AI)).rejects.toMatchObject({
			code: 'forbidden',
		});
		const { actor: admin } = await k.member('admin');
		await set(admin, { extensionId: 'ledger', access: 'any', confirmSensitive: true });
		await expect(k.runner.invoke('ledger.peek', {}, AI)).resolves.toMatchObject({
			status: 'applied',
		});
		await expect(k.runner.invoke('ledger.addEntry', {}, AI)).resolves.toMatchObject({
			status: 'drafted',
		});
	});
});
