import { type Actor, systemActor } from '@famos/sdk';
import { createFakeChannel, createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import board from '../src/server/index.ts';

export const TZ = 'Europe/Istanbul';
export const at = (date: string, time: string) => epochOf(date, time, TZ);
export const AI: Actor = { kind: 'ai', mode: 'share', source: 'inbox' };

/** Tuesday 2026-10-06, 10:00 in Istanbul. */
export async function createKernel() {
	const channel = createFakeChannel('web');
	const k = await createTestKernel({
		channels: [channel],
		translate: (locale, key, params) => `${locale}|${key}|${JSON.stringify(params ?? {})}`,
		extensions: [board],
	});
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(at('2026-10-06', '10:00'));
	return { k, channel };
}

export type Person = { id: string; actor: Actor };

export async function person(k: TestKernel, roleId: string, name = roleId): Promise<Person> {
	const { actor, member } = await k.member(roleId, name);
	return { id: member.id, actor };
}

export async function applied<T>(
	k: TestKernel,
	actionId: string,
	input: unknown,
	actor: Actor,
): Promise<T> {
	const r = await k.runner.invoke<T>(actionId, input, actor);
	if (r.status !== 'applied')
		throw new Error(`expected ${actionId} to be applied, was ${r.status}`);
	return r.output;
}

/** The error code of a call that is refused. */
export const refused = (p: Promise<unknown>) =>
	p.then(
		() => null,
		(e: { code?: string }) => e.code ?? 'error',
	);
