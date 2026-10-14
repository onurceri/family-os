import lists from '@famos/ext-lists/server';
import { type Actor, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import kitchen from '../src/server/index.ts';

export const TZ = 'Europe/Istanbul';
export const at = (date: string, time: string) => epochOf(date, time, TZ);
export const AI: Actor = { kind: 'ai', mode: 'share', source: 'inbox' };

export async function createKernel(extra: Parameters<typeof createTestKernel>[0] = {}) {
	const k = await createTestKernel({
		...extra,
		extensions: [lists, kitchen, ...(extra.extensions ?? [])],
	});
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(at('2026-10-06', '10:00'));
	return k;
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
	if (r.status !== 'applied') throw new Error(`expected ${actionId} to be applied`);
	return r.output;
}
