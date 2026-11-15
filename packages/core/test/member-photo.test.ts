import type { Actor, MemberId, UploadedFile } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, type TestKernel } from './harness.ts';

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel();
});
afterEach(() => k.close());

const join = (...parts: (number[] | Uint8Array)[]) =>
	Uint8Array.from(parts.flatMap((part) => [...part]));

/** A small, structurally valid JPEG of the given size. */
function jpeg(width = 64, height = 64): Uint8Array {
	const segment = (marker: number, payload: number[]) =>
		join([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff], payload);
	return join(
		[0xff, 0xd8],
		segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]),
		segment(0xda, [1, 1, 0]),
		[1, 2, 3],
		[0xff, 0xd9],
	);
}

const file = (bytes: Uint8Array, size = bytes.length): UploadedFile => ({
	field: 'file',
	name: 'p.jpg',
	type: 'image/jpeg',
	size,
	stream: async function* () {
		yield bytes;
	},
	bytes: async () => bytes,
});

const code = async (promise: Promise<unknown>) => {
	try {
		await promise;
		return 'ok';
	} catch (error) {
		return (error as { code?: string }).code ?? 'error';
	}
};

const upload = (memberId: string, actor: Actor, f: UploadedFile = file(jpeg())) =>
	k.route('core.uploadMemberPhoto').call({ params: { memberId }, files: [f], actor });

const photoRow = async (memberId: string) =>
	(await k
		.contextFor('core')
		.db.withTables<CoreTables>()
		.selectFrom('core_members')
		.select(['photo', 'photo_type'])
		.where('id', '=', memberId)
		.executeTakeFirstOrThrow()) as { photo: string | null; photo_type: string | null };

const files = () => k.contextFor('core').files;

const bytesOf = async (res: { stream: AsyncIterable<Uint8Array> }) => {
	const chunks: Uint8Array[] = [];
	for await (const chunk of res.stream) chunks.push(chunk);
	return Buffer.concat(chunks);
};

describe('uploading a member photo', () => {
	it('lets a person set their own photo and shows its token with the member', async () => {
		const { actor, member } = await k.member('member');
		expect(member.photo).toBeNull();
		await expect(upload(member.id, actor)).resolves.toEqual({ ok: true });
		const row = await photoRow(member.id);
		expect(row.photo).toMatch(new RegExp(`^core/members/${member.id}/photo_`));
		expect(row.photo_type).toBe('image/jpeg');

		const listed = (await k
			.route('core.listMembers')
			.call({ actor: (await k.member('admin')).actor })) as { id: string; photo: string | null }[];
		const token = listed.find((m) => m.id === member.id)?.photo;
		expect(token).toBe(row.photo?.split('/').at(-1));
		// The token is not the file key.
		expect(token).not.toContain('/');
	});

	it('refuses a member for someone else, and lets a manager do it', async () => {
		const a = await k.member('member');
		const b = await k.member('member');
		const admin = await k.member('admin');
		expect(await code(upload(b.member.id, a.actor))).toBe('forbidden');
		expect((await photoRow(b.member.id)).photo).toBeNull();
		await expect(upload(b.member.id, admin.actor)).resolves.toEqual({ ok: true });
		expect((await photoRow(b.member.id)).photo).not.toBeNull();
	});

	it('refuses a manager whose PIN sign-in holds no manage right', async () => {
		const { member } = await k.member('member');
		const admin = await k.member('admin');
		expect(await code(upload(member.id, { ...admin.actor, pin: true }))).toBe('forbidden');
	});

	it('refuses a display, an app and the AI, even for their own member', async () => {
		const { actor, member } = await k.member('admin');
		const actors: Actor[] = [
			{
				kind: 'display',
				deviceId: 'device_1',
				capabilities: ['core.members.view'],
				showNames: true,
			},
			{ kind: 'app', appId: 'app_1', roleId: 'admin', mode: 'apply' },
			{
				kind: 'ai',
				mode: 'agent',
				source: 'mcp',
				onBehalfOf: member.id as MemberId,
				roleId: 'admin',
			},
			{ ...actor, via: { appId: 'app_1', appRoleId: 'admin', mode: 'apply' } },
		];
		for (const who of actors) expect(await code(upload(member.id, who))).toBe('forbidden');
		// The AI only ever leaves a draft (a person decides it later); no other way applies the change.
		await upload(member.id, actor);
		const key = (await photoRow(member.id)).photo;
		const outcomes: string[] = [];
		for (const who of actors) {
			try {
				outcomes.push(
					(await k.runner.invoke('core.removeMemberPhoto', { memberId: member.id }, who)).status,
				);
			} catch (error) {
				outcomes.push((error as { code: string }).code);
			}
		}
		expect(outcomes).toEqual(['forbidden', 'forbidden', 'drafted', 'forbidden']);
		expect((await photoRow(member.id)).photo).toBe(key);
	});

	it('refuses what is not a photo and what is too large', async () => {
		const { actor, member } = await k.member('member');
		expect(await code(upload(member.id, actor, file(new TextEncoder().encode('hello'))))).toBe(
			'bad_request',
		);
		expect(await code(upload(member.id, actor, file(jpeg(), 3 * 1024 * 1024)))).toBe('bad_request');
		expect(await code(upload(member.id, actor, file(jpeg(4000, 4000))))).toBe('bad_request');
		expect((await photoRow(member.id)).photo).toBeNull();
	});

	it('deletes the previous file when a photo is replaced', async () => {
		const { actor, member } = await k.member('member');
		await upload(member.id, actor);
		const first = (await photoRow(member.id)).photo as string;
		await upload(member.id, actor);
		const second = (await photoRow(member.id)).photo as string;
		expect(second).not.toBe(first);
		expect(await files().stat(first)).toBeNull();
		expect(await files().stat(second)).not.toBeNull();
	});

	it('refuses an archived or unknown member', async () => {
		const admin = await k.member('admin');
		const { member } = await k.member('member');
		await k.runner.invoke('core.archiveMember', { memberId: member.id }, admin.actor);
		expect(await code(upload(member.id, admin.actor))).toBe('not_found');
		expect(await code(upload('member_0198c2a0-0000-7000-8000-000000000001', admin.actor))).toBe(
			'not_found',
		);
	});

	it('keeps the photo when the member is archived', async () => {
		const admin = await k.member('admin');
		const { member } = await k.member('member');
		await upload(member.id, admin.actor);
		await k.runner.invoke('core.archiveMember', { memberId: member.id }, admin.actor);
		expect((await photoRow(member.id)).photo).not.toBeNull();
	});

	it('refuses a key outside the member, and one that is not a photo key', async () => {
		const a = await k.member('member');
		const b = await k.member('member');
		const own = `core/members/${a.member.id}/photo_x`;
		expect(
			await code(
				k.runner.invoke(
					'core.setMemberPhoto',
					{ memberId: a.member.id, key: `core/members/${b.member.id}/photo_x`, type: 'image/jpeg' },
					a.actor,
				),
			),
		).toBe('bad_request');
		expect(
			await code(
				k.runner.invoke(
					'core.setMemberPhoto',
					{ memberId: a.member.id, key: 'board/notes/photo_x', type: 'image/jpeg' },
					a.actor,
				),
			),
		).toBe('bad_request');
		const set = await k.runner.invoke(
			'core.setMemberPhoto',
			{ memberId: a.member.id, key: own, type: 'image/jpeg' },
			a.actor,
		);
		expect(set.status).toBe('applied');
	});
});

describe('removing a member photo', () => {
	it('clears the photo and a job deletes the file, however often it runs', async () => {
		const { actor, member } = await k.member('member');
		await upload(member.id, actor);
		const key = (await photoRow(member.id)).photo as string;
		const removed = await k.runner.invoke('core.removeMemberPhoto', { memberId: member.id }, actor);
		expect(removed).toMatchObject({ status: 'applied', output: { removed: true } });
		expect(await photoRow(member.id)).toEqual({ photo: null, photo_type: null });
		await k.worker.drain();
		expect(await files().stat(key)).toBeNull();

		// Again: nothing to remove, and a second delete of the same file is no failure.
		expect(
			await k.runner.invoke('core.removeMemberPhoto', { memberId: member.id }, actor),
		).toMatchObject({ output: { removed: false } });
		await k.contextFor('core').enqueue('core.deleteMemberPhoto', { key });
		await expect(k.worker.drain()).resolves.toBe(1);
	});

	it('is refused for another member without the right to manage', async () => {
		const a = await k.member('member');
		const b = await k.member('member');
		expect(
			await code(k.runner.invoke('core.removeMemberPhoto', { memberId: b.member.id }, a.actor)),
		).toBe('forbidden');
	});
});

describe('reading a member photo', () => {
	it('gives the file with its type to a holder of the view right, and not_found without one', async () => {
		const { actor, member } = await k.member('member');
		const route = k.route('core.getMemberPhoto');
		expect(await code(route.call({ params: { memberId: member.id }, actor }))).toBe('not_found');
		await upload(member.id, actor);
		const res = await route.call({ params: { memberId: member.id }, actor });
		expect(res.contentType).toBe('image/jpeg');
		expect(res.cacheControl).toBe('private, max-age=86400');
		expect((await bytesOf(res)).length).toBeGreaterThan(0);
	});

	it('asks for the view right of members, which a display can be granted', () => {
		const found = k.registry.routes.find((r) => r.route.operationId === 'core.getMemberPhoto');
		expect(found?.route.requires).toBe('core.members.view');
		const display = (capabilities: string[]): Actor => ({
			kind: 'display',
			deviceId: 'device_1',
			capabilities,
			showNames: true,
		});
		expect(k.access.can(display(['core.members.view']), 'core.members.view')).toBe(true);
	});
});

describe('the profile picker photo', () => {
	const read = (memberId: string) => k.route('core.getProfilePhoto').call({ params: { memberId } });

	it('is for trusted devices only', () => {
		const found = k.registry.routes.find((r) => r.route.operationId === 'core.getProfilePhoto');
		expect(found?.route.requires).toBe('trusted-device');
	});

	it('serves only members the picker lists', async () => {
		const withPin = await k.member('member');
		const noPin = await k.member('member');
		const passwordsOnly = await k.member('member');
		for (const who of [withPin, noPin, passwordsOnly]) await upload(who.member.id, who.actor);
		await k.route('core.setMemberPin').call({
			params: { memberId: withPin.member.id },
			body: { pin: '2468' },
		});
		const profiles = (await k.route('core.listProfiles').call()) as {
			id: string;
			photo: string | null;
		}[];
		expect(profiles.map((p) => p.id)).toEqual([withPin.member.id]);
		expect(profiles[0]?.photo).not.toBeNull();

		expect((await read(withPin.member.id)).contentType).toBe('image/jpeg');
		// Not in the picker: the same answer as for someone who does not exist.
		expect(await code(read(noPin.member.id))).toBe('not_found');
		expect(await code(read('member_0198c2a0-0000-7000-8000-000000000001'))).toBe('not_found');
	});

	it('is not_found for a listed member without a photo', async () => {
		const { member } = await k.member('member');
		await k.route('core.setMemberPin').call({
			params: { memberId: member.id },
			body: { pin: '2468' },
		});
		expect(await code(read(member.id))).toBe('not_found');
	});
});
