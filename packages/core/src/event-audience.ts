import type { Actor, AudienceTarget, EventDefinition } from '@famos/sdk';
import type { Access } from './access.ts';

/**
 * Who an event may be told to, as targets. Without an audience it is the `view` capability of the
 * extension that owns the event (the part of its name before the first dot), so a new event is
 * closed by default: a family member who cannot see the area, and a display that was not granted
 * it, hear nothing about it. A payload function that throws means nobody.
 */
export function audienceOf(
	definition: Pick<EventDefinition, 'audience'> | undefined,
	name: string,
	payload: unknown,
): readonly AudienceTarget[] {
	const rule = definition?.audience;
	if (rule === undefined) return [`${name.split('.')[0]}.view`];
	try {
		const targets = typeof rule === 'function' ? rule(payload) : rule;
		return Array.isArray(targets) ? targets : [targets as AudienceTarget];
	} catch {
		return [];
	}
}

/** Whether one connected actor is in the audience. An unknown capability is nobody. */
export function inAudience(
	access: Pick<Access, 'can' | 'capability'>,
	actor: Actor,
	targets: readonly AudienceTarget[],
): boolean {
	if (actor.kind !== 'member' && actor.kind !== 'display') return false;
	return targets.some((target) => {
		if (typeof target === 'string') {
			if (!access.capability(target)) return false;
			return access.can(actor, target);
		}
		if ('everyone' in target) return true;
		if ('anyMember' in target) return actor.kind === 'member';
		if ('device' in target) return actor.kind === 'display' && actor.deviceId === target.device;
		return actor.kind === 'member' && actor.memberId === target.member;
	});
}

/** Whether a connected actor may receive an event: the check the realtime hub makes per socket. */
export function mayReceive(
	access: Pick<Access, 'can' | 'capability'>,
	definitions: ReadonlyMap<string, Pick<EventDefinition, 'audience'>>,
	actor: Actor,
	name: string,
	payload: unknown,
): boolean {
	return inAudience(access, actor, audienceOf(definitions.get(name), name, payload));
}
