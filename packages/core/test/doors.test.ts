import { type Actor, defineAction, defineCapability, type MemberId, systemActor } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { admission, type DecideEnv, decide } from '../src/decide.ts';
import type { CoreTables } from '../src/index.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

const gateUse = defineCapability({ id: 'gate.use', label: 'gate:cap_use', level: 'use' });
const gateView = defineCapability({ id: 'gate.view', label: 'gate:cap_view', level: 'view' });
const Empty = z.object({});
const Done = z.object({ ok: z.boolean() });

const calls: string[] = [];

// Plumbing for jobs: a person never runs it.
const sweep = defineAction({
	id: 'gate.sweep',
	title: 'Sweep',
	input: Empty,
	output: Done,
	expose: 'internal',
	requires: gateUse.id,
	approval: 'never',
	async run() {
		calls.push('sweep');
		return { ok: true };
	},
});
// A read for the AI that no person calls over HTTP.
const survey = defineAction({
	id: 'gate.survey',
	title: 'Survey',
	input: Empty,
	output: Done,
	expose: 'internal',
	readOnly: true,
	ai: { description: 'Survey' },
	async run() {
		calls.push('survey');
		return { ok: true };
	},
});
// An internal change the AI claims to propose: it could never be approved, so it is refused.
const sweepForAi = defineAction({
	id: 'gate.sweepForAi',
	title: 'Sweep for the AI',
	draftTitle: 'gate:draft_sweep',
	input: Empty,
	output: Done,
	expose: 'internal',
	requires: gateUse.id,
	ai: { description: 'Sweep' },
	async run() {
		calls.push('sweepForAi');
		return { ok: true };
	},
});
const note = defineAction({
	id: 'gate.note',
	title: 'Note',
	draftTitle: 'gate:draft_note',
	input: Empty,
	output: Done,
	requires: gateUse.id,
	ai: { description: 'Note' },
	async run() {
		calls.push('note');
		return { ok: true };
	},
});
const look = defineAction({
	id: 'gate.look',
	title: 'Look',
	input: Empty,
	output: Done,
	readOnly: true,
	requires: gateView.id,
	ai: { description: 'Look' },
	async run() {
		calls.push('look');
		return { ok: true };
	},
});
const confide = defineAction({
	id: 'gate.confide',
	title: 'Confide',
	draftTitle: 'gate:draft_confide',
	input: Empty,
	output: Done,
	requires: gateUse.id,
	ai: { description: 'Confide', conversationOnly: true },
	async run() {
		calls.push('confide');
		return { ok: true };
	},
});
const whisper = defineAction({
	id: 'gate.whisper',
	title: 'Whisper',
	input: Empty,
	output: Done,
	readOnly: true,
	requires: gateView.id,
	ai: { description: 'Whisper', conversationOnly: true },
	async run() {
		calls.push('whisper');
		return { ok: true };
	},
});

const gate = defineTestExtension({
	id: 'gate',
	capabilities: [gateUse, gateView],
	actions: [sweep, survey, sweepForAi, note, look, confide, whisper],
});

const env = (k: TestKernel): DecideEnv => ({
	access: k.access,
	critical: new Set(k.registry.capabilities.filter((c) => c.critical).map((c) => c.id)),
});

let k: TestKernel;
let admin: MemberId;
beforeEach(async () => {
	calls.length = 0;
	k = await createTestKernel({ extensions: [gate] });
	admin = (await k.member('admin')).actor.memberId;
});
afterEach(() => k.close());

const ai = (extra: Partial<Extract<Actor, { kind: 'ai' }>> = {}): Actor => ({
	kind: 'ai',
	mode: 'agent',
	source: 'test',
	onBehalfOf: admin,
	roleId: 'admin',
	...extra,
});

describe('an internal action', () => {
	it('is registered as internal, and ordinary ones as app', () => {
		expect(k.registry.actions.get('gate.sweep')?.expose).toBe('internal');
		expect(k.registry.actions.get('gate.note')?.expose).toBe('app');
	});

	it('is refused for a member, even one that holds its capability, and for a display', async () => {
		const { actor } = await k.member('admin');
		for (const id of ['gate.sweep', 'gate.survey']) {
			await expect(k.runner.invoke(id, {}, actor)).rejects.toMatchObject({ code: 'forbidden' });
		}
		const display: Actor = {
			kind: 'display',
			deviceId: 'dev',
			capabilities: [gateUse.id],
			showNames: false,
		};
		await expect(k.runner.invoke('gate.survey', {}, display)).rejects.toMatchObject({
			code: 'forbidden',
		});
		expect(calls).toEqual([]);
	});

	it('is run by the system', async () => {
		const result = await k.runner.invoke('gate.sweep', {}, systemActor('job'));
		expect(result.status).toBe('applied');
		expect(calls).toEqual(['sweep']);
	});

	it('may be read by the AI, but never changed by it', async () => {
		expect((await k.runner.invoke('gate.survey', {}, ai())).status).toBe('applied');
		await expect(k.runner.invoke('gate.sweepForAi', {}, ai())).rejects.toMatchObject({
			code: 'forbidden',
			details: { reason: 'ai' },
		});
		expect(calls).toEqual(['survey']);
	});

	it('is refused for a member inside another action as well', () => {
		const member: Actor = { kind: 'member', memberId: admin, roleId: 'admin' };
		expect(admission(sweep, member, env(k))).toEqual({ reason: 'capability' });
	});
});

describe('a token that can only read', () => {
	it('may run reads and is refused every change, applied or proposed', async () => {
		const readOnly = ai({ scope: 'read' });
		expect((await k.runner.invoke('gate.look', {}, readOnly)).status).toBe('applied');
		await expect(k.runner.invoke('gate.note', {}, readOnly)).rejects.toMatchObject({
			code: 'forbidden',
			details: { reason: 'ai' },
		});
		expect(decide(note, readOnly, env(k))).toMatchObject({ outcome: 'refuse', reason: 'ai' });
		const drafts = await k.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_drafts')
			.selectAll()
			.execute();
		expect(drafts).toHaveLength(0);
		expect(calls).toEqual(['look']);
	});

	it('is the only thing that closes it: a read_write token or no scope proposes a draft', async () => {
		for (const scope of ['read_write', undefined] as const) {
			const result = await k.runner.invoke('gate.note', {}, ai(scope ? { scope } : {}));
			expect(result.status).toBe('drafted');
		}
		expect(calls).toEqual([]);
	});
});

describe('a conversation-only action', () => {
	it('is refused for an AI that is not answering a member in the app conversation', async () => {
		for (const actor of [
			ai({ mode: 'share' }),
			ai({ mode: 'agent' }),
			ai({ mode: 'conversation', onBehalfOf: undefined as never }),
		]) {
			await expect(k.runner.invoke('gate.whisper', {}, actor)).rejects.toMatchObject({
				code: 'forbidden',
				details: { reason: 'ai' },
			});
			await expect(k.runner.invoke('gate.confide', {}, actor)).rejects.toMatchObject({
				code: 'forbidden',
			});
		}
		expect(calls).toEqual([]);
	});

	it('is allowed for the AI in conversation mode working for a member', async () => {
		const actor = ai({ mode: 'conversation' });
		expect((await k.runner.invoke('gate.whisper', {}, actor)).status).toBe('applied');
		expect((await k.runner.invoke('gate.confide', {}, actor)).status).toBe('drafted');
	});

	it('still holds a read-only scope in conversation mode', async () => {
		await expect(
			k.runner.invoke('gate.confide', {}, ai({ mode: 'conversation', scope: 'read' })),
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});
