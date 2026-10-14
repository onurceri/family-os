import { type Actor, systemActor } from '@famos/sdk';
import { createFakeChannel, createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import chores from '../src/server/index.ts';

export const TZ = 'Europe/Istanbul';
export const at = (date: string, time: string) => epochOf(date, time, TZ);
export const AI: Actor = { kind: 'ai', mode: 'share', source: 'inbox' };

/** Tuesday 2026-10-06, 10:00 in Istanbul. */
export async function createKernel() {
	const channel = createFakeChannel('web');
	const k = await createTestKernel({
		channels: [channel],
		translate: (locale, key, params) => `${locale}|${key}|${JSON.stringify(params ?? {})}`,
		extensions: [chores],
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

/** Whether an actor may call a route: the HTTP layer checks `requires`; direct calls do not. */
export function mayCall(k: TestKernel, actor: Actor, operationId: string): boolean {
	const found = k.registry.routes.find((r) => r.route.operationId === operationId);
	if (!found) throw new Error(`No route ${operationId}`);
	return k.access.can(actor, found.route.requires);
}
