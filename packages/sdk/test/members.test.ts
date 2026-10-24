import { describe, expect, it } from 'vitest';
import { assertActiveMembers, type MemberId } from '../src/index.ts';

const leo = 'member_leo' as MemberId;

describe('assertActiveMembers', () => {
	const uow = { family: { members: async () => [{ id: leo }] } } as unknown as Parameters<
		typeof assertActiveMembers
	>[0];

	it('passes active members and skips empty entries', async () => {
		await expect(
			assertActiveMembers(uow, [leo, null, undefined], 'memberIds'),
		).resolves.toBeUndefined();
		await expect(assertActiveMembers(uow, [], 'memberIds')).resolves.toBeUndefined();
	});

	it('refuses an unknown member and names the field', async () => {
		await expect(
			assertActiveMembers(uow, [leo, 'member_gone'], 'assigneeIds'),
		).rejects.toMatchObject({
			code: 'bad_request',
			details: { fields: [{ path: 'assigneeIds' }] },
		});
	});
});
