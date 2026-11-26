import { describe, expect, it } from 'vitest';
import { groupKinds, kindAnchor, kindFromHash } from './groups.ts';

describe('groupKinds', () => {
	it('keeps the fixed order of the parts and the order of kinds within each', () => {
		const kinds = [
			{ id: 'x.backup', group: 'system' as const },
			{ id: 'x.due', group: 'everyday' as const },
			{ id: 'x.waiting', group: 'approvals' as const },
			{ id: 'x.later', group: 'everyday' as const },
		];
		expect(groupKinds(kinds)).toEqual([
			{ group: 'everyday', kinds: [kinds[1], kinds[3]] },
			{ group: 'approvals', kinds: [kinds[2]] },
			{ group: 'system', kinds: [kinds[0]] },
		]);
	});

	it('leaves out a part with no kind', () => {
		expect(groupKinds([{ id: 'x.due', group: 'everyday' as const }]).map((p) => p.group)).toEqual([
			'everyday',
		]);
		expect(groupKinds([])).toEqual([]);
	});
});

describe('kind anchors', () => {
	it('reads the kind back from the address it links to', () => {
		expect(kindFromHash(`#${kindAnchor('x.evening')}`)).toBe('x.evening');
		expect(kindFromHash('#kind-x.evening')).toBe('x.evening');
		expect(kindFromHash('#kind-x%2Eevening')).toBe('x.evening');
		expect(kindFromHash('#kind-')).toBeNull();
		expect(kindFromHash('#other')).toBeNull();
		expect(kindFromHash('')).toBeNull();
		expect(kindFromHash('#kind-%E0')).toBeNull();
	});
});
