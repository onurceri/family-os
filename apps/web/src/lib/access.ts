import type { ActionAccess } from '@famos/ui/app';

/** The server's decision for one action (`GET /core/access`, `POST /actions/{id}/check`). */
export interface AccessDecision {
	outcome: 'apply' | 'draft' | 'refuse';
	depends?: true;
}

/**
 * What a control does with a decision. Where the input could change the answer (`depends`) and
 * none has been asked for yet, the control is offered as it is for the common case: the caller
 * asks `accessFor` with the input to know. `exact` ignores `depends`: the input has been given.
 */
export function accessOf(decision: AccessDecision | undefined, exact = false): ActionAccess {
	if (!decision) return 'no';
	if (decision.depends && !exact) return 'depends';
	if (decision.outcome === 'apply') return 'apply';
	return decision.outcome === 'draft' ? 'suggest' : 'no';
}

/** The same key for the same input whatever the order its fields were written in. */
export function inputKey(actionId: string, input: unknown): string {
	return `${actionId}\n${stable(input)}`;
}

function stable(value: unknown): string {
	if (value === undefined) return 'null';
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
}
