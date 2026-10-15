import { describe, expect, it } from 'vitest';
import { approvalGates } from './approval-gates.js';

describe('approval gates', () => {
	const viewer = (held: string[]) => approvalGates((c) => held.includes(c));

	it('shows a change control to people who hold the capability, and saves directly', () => {
		const gates = viewer(['pets.edit', 'core.drafts.propose']);
		expect(gates.mayChange('pets.edit')).toBe(true);
		expect(gates.needsApproval('pets.edit')).toBe(false);
	});

	it('shows it to people who may only suggest, whose change then waits for approval', () => {
		const gates = viewer(['core.drafts.propose']);
		expect(gates.mayChange('pets.edit')).toBe(true);
		expect(gates.needsApproval('pets.edit')).toBe(true);
	});

	it('hides it from people who may do neither (a guest, a display)', () => {
		const gates = viewer(['pets.view']);
		expect(gates.mayChange('pets.edit')).toBe(false);
		expect(gates.needsApproval('pets.edit')).toBe(false);
	});
});
