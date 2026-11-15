import {
	defineAction,
	defineJob,
	defineRoute,
	FamosError,
	FileResponseSchema,
	type FileStore,
	personPresent,
	readUploadedImage,
	selfOf,
	storeThenRun,
	uploadRequestLimit,
} from '@famos/sdk';
import { z } from 'zod';
import { revokeTokensOf } from '../api-tokens.ts';
import { CORE_CAPABILITIES } from '../core-capabilities.ts';
import { memberChanged } from '../core-events.ts';
import type { createLanguages } from '../languages.ts';
import type { CoreExtensionDeps } from './deps.ts';
import {
	AboutSchema,
	activeAdminCount,
	ColorSchema,
	END_CREDENTIALS_JOB,
	findMember,
	insertMember,
	LocaleSchema,
	MemberIdSchema,
	MemberSchema,
	members,
	NO_SIGN_IN,
	photoToken,
	RoleIdSchema,
	requireMember,
	SignInMethodsSchema,
	toMember,
} from './member-rows.ts';

/** Deletes a profile photo's file once its member no longer points at it; a missing file is fine. */
const DELETE_MEMBER_PHOTO_JOB = 'core.deleteMemberPhoto';

const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const PHOTO_MAX_SIDE = 2048;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const PhotoParams = z.object({ memberId: MemberIdSchema });
const photoKeyPrefix = (memberId: string) => `core/members/${memberId}/`;

/** Adding, changing and archiving family members, and who lives here. */
export function createMembers(
	deps: CoreExtensionDeps,
	languages: ReturnType<typeof createLanguages>,
) {
	/** A role id is a built-in role or an existing custom role. */
	const assertRole = (roleId: string) => {
		const access = deps.access();
		if (!access.isBuiltIn(roleId) && !access.customRoles().some((r) => r.id === roleId)) {
			throw new FamosError('bad_request', `Unknown role "${roleId}"`);
		}
	};

	const createMember = defineAction({
		id: 'core.createMember',
		title: 'Add a family member',
		input: z.object({
			displayName: z.string().trim().min(1).max(60),
			roleId: RoleIdSchema,
			about: AboutSchema.optional(),
			color: ColorSchema.optional(),
			locale: LocaleSchema.optional(),
		}),
		output: MemberSchema,
		requires: CORE_CAPABILITIES.membersManage.id,
		approval: 'never',
		async run(uow, input) {
			assertRole(input.roleId);
			if (input.locale) languages.assertKnown(input.locale);
			const row = await insertMember(uow, input);
			uow.emit(memberChanged, { memberId: row.id });
			return toMember(row);
		},
	});

	const updateMember = defineAction({
		id: 'core.updateMember',
		title: 'Update a family member',
		input: z.object({
			memberId: MemberIdSchema,
			displayName: z.string().trim().min(1).max(60).optional(),
			roleId: RoleIdSchema.optional(),
			about: AboutSchema.nullable().optional(),
			color: ColorSchema.optional(),
			locale: LocaleSchema.nullable().optional(),
		}),
		output: MemberSchema,
		requires: CORE_CAPABILITIES.membersManage.id,
		approval: 'never',
		async run(uow, input) {
			if (input.roleId !== undefined) assertRole(input.roleId);
			if (input.locale) languages.assertKnown(input.locale);
			const current = await findMember(uow.db, input.memberId);
			if (
				current.role_id === 'admin' &&
				input.roleId !== undefined &&
				input.roleId !== 'admin' &&
				(await activeAdminCount(uow.db)) <= 1
			) {
				throw new FamosError('conflict', 'The last admin cannot be demoted', {
					reason: 'last_admin',
				});
			}
			await members(uow.db)
				.updateTable('core_members')
				.set({
					...(input.displayName !== undefined && { display_name: input.displayName }),
					...(input.roleId !== undefined && { role_id: input.roleId }),
					...(input.about !== undefined && { about: input.about?.trim() || null }),
					...(input.color !== undefined && { color: input.color }),
					...(input.locale !== undefined && { locale: input.locale }),
					updated_at: uow.clock.now(),
				})
				.where('id', '=', input.memberId)
				.execute();
			uow.emit(memberChanged, { memberId: input.memberId });
			return toMember(await findMember(uow.db, input.memberId));
		},
	});

	const setMyLanguage = defineAction({
		id: 'core.setMyLanguage',
		title: 'Choose my own language',
		input: z.object({ locale: LocaleSchema.nullable() }),
		output: MemberSchema,
		// Everyone may choose how the app speaks to them; it changes nothing for anyone else.
		requires: CORE_CAPABILITIES.notificationsReceive.id,
		approval: 'never',
		async run(uow, input) {
			const actor = requireMember(uow.actor);
			if (input.locale) languages.assertKnown(input.locale);
			await members(uow.db)
				.updateTable('core_members')
				.set({ locale: input.locale, updated_at: uow.clock.now() })
				.where('id', '=', actor.memberId)
				.execute();
			uow.emit(memberChanged, { memberId: actor.memberId });
			return toMember(await findMember(uow.db, actor.memberId));
		},
	});

	const archiveMember = defineAction({
		id: 'core.archiveMember',
		title: 'Remove a family member from the family',
		input: z.object({ memberId: MemberIdSchema }),
		output: MemberSchema,
		requires: CORE_CAPABILITIES.membersManage.id,
		approval: 'never',
		async run(uow, input) {
			const current = await findMember(uow.db, input.memberId);
			if (
				current.role_id === 'admin' &&
				current.archived_at === null &&
				(await activeAdminCount(uow.db)) <= 1
			) {
				throw new FamosError('conflict', 'The last admin cannot be archived', {
					reason: 'last_admin',
				});
			}
			const now = uow.clock.now();
			await members(uow.db)
				.updateTable('core_members')
				.set({ archived_at: now, updated_at: now })
				.where('id', '=', input.memberId)
				.execute();
			// Keys and addresses end in this transaction, or not at all.
			await revokeTokensOf(uow.db, input.memberId, now);
			await uow.enqueue(END_CREDENTIALS_JOB, { memberId: input.memberId });
			uow.emit(memberChanged, { memberId: input.memberId, endSessions: true });
			return toMember(await findMember(uow.db, input.memberId));
		},
	});

	/** A person may change their own photo; anyone else's needs the right to manage members. */
	const assertMayChangePhoto = (
		who: { actor: Parameters<typeof selfOf>[0]; can(capability: string): boolean },
		memberId: string,
	) => {
		const self = selfOf(who.actor);
		const person = personPresent(who.actor);
		if (person && (self === memberId || who.can(CORE_CAPABILITIES.membersManage.id))) return;
		throw new FamosError('forbidden', 'Only the person themselves or a manager can change a photo');
	};

	/** The member a photo change is about: present and not archived. */
	const photoSubject = async (db: Parameters<typeof findMember>[0], memberId: string) => {
		const row = await findMember(db, memberId);
		if (row.archived_at !== null) throw new FamosError('not_found', 'Member not found');
		return row;
	};

	/** Stores the photo the upload route already put in the file store. */
	const setMemberPhoto = defineAction({
		id: 'core.setMemberPhoto',
		title: 'Set the photo of a family member',
		input: z.object({
			memberId: MemberIdSchema,
			// Only keys the upload route makes: the action is also reachable at /actions.
			key: z.string().regex(/^core\/members\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/),
			type: z.enum(PHOTO_TYPES),
		}),
		output: z.object({ previousKey: z.string().nullable() }),
		// Everyone may set their own; the check in `run` decides about anyone else's.
		requires: CORE_CAPABILITIES.notificationsReceive.id,
		approval: 'never',
		async run(uow, { memberId, key, type }) {
			if (!key.startsWith(photoKeyPrefix(memberId)))
				throw new FamosError('bad_request', 'The photo belongs to another member');
			assertMayChangePhoto(uow, memberId);
			const row = await photoSubject(uow.db, memberId);
			await members(uow.db)
				.updateTable('core_members')
				.set({ photo: key, photo_type: type, updated_at: uow.clock.now() })
				.where('id', '=', memberId)
				.execute();
			uow.emit(memberChanged, { memberId });
			return { previousKey: row.photo === key ? null : row.photo };
		},
	});

	const removeMemberPhoto = defineAction({
		id: 'core.removeMemberPhoto',
		title: 'Remove the photo of a family member',
		input: z.object({ memberId: MemberIdSchema }),
		output: z.object({ removed: z.boolean() }),
		requires: CORE_CAPABILITIES.notificationsReceive.id,
		approval: 'never',
		async run(uow, { memberId }) {
			assertMayChangePhoto(uow, memberId);
			const row = await findMember(uow.db, memberId);
			if (!row.photo) return { removed: false };
			await members(uow.db)
				.updateTable('core_members')
				.set({ photo: null, photo_type: null, updated_at: uow.clock.now() })
				.where('id', '=', memberId)
				.execute();
			// The file goes with a job, so it is removed only if the change really is saved.
			await uow.enqueue(DELETE_MEMBER_PHOTO_JOB, { key: row.photo });
			uow.emit(memberChanged, { memberId });
			return { removed: true };
		},
	});

	const deleteMemberPhoto = defineJob({
		name: DELETE_MEMBER_PHOTO_JOB,
		payload: z.object({ key: z.string().min(1) }),
		async handle(ctx, { key }) {
			await ctx.files.delete(key);
		},
	});

	const uploadMemberPhoto = defineRoute({
		method: 'post',
		path: '/members/{memberId}/photo',
		operationId: 'core.uploadMemberPhoto',
		summary:
			'Set the profile photo of a member (multipart: one JPEG, PNG or WebP image; the app shrinks and re-encodes it first)',
		requires: 'signedIn',
		params: PhotoParams,
		upload: {
			maxBytes: uploadRequestLimit(PHOTO_MAX_BYTES),
			maxFiles: 1,
			accept: [...PHOTO_TYPES],
		},
		response: z.object({ ok: z.literal(true) }),
		async handle(ctx, { params, files, actor }) {
			// Refused before any of the body is read or stored.
			assertMayChangePhoto({ actor, can: (c) => ctx.access.can(actor, c) }, params.memberId);
			await photoSubject(ctx.db, params.memberId);
			const photo = await readUploadedImage(files, {
				maxBytes: PHOTO_MAX_BYTES,
				maxSide: PHOTO_MAX_SIDE,
			});
			const key = `${photoKeyPrefix(params.memberId)}${ctx.ids.next('photo')}`;
			const { previousKey } = await storeThenRun(
				ctx.files,
				{ key, bytes: photo.bytes, type: photo.type },
				() =>
					ctx.actions.invoke<{ previousKey: string | null }>(
						'core.setMemberPhoto',
						{ memberId: params.memberId, key, type: photo.type },
						actor,
					),
			);
			// The new photo is saved; a leftover old file is only wasted space.
			if (previousKey) await ctx.files.delete(previousKey).catch(() => undefined);
			return { ok: true as const };
		},
	});

	const servePhoto = async (
		ctx: { files: Pick<FileStore, 'get'> },
		row: { photo: string | null; photo_type: string | null },
	) => {
		const stored = row.photo ? await ctx.files.get(row.photo) : null;
		if (!row.photo || !row.photo_type || !stored) throw new FamosError('not_found', 'No photo');
		return {
			stream: stored.stream,
			contentType: row.photo_type,
			size: stored.stat.size,
			filename: 'photo',
			// The address carries the photo's id, so a new photo is a new address.
			cacheControl: 'private, max-age=86400',
		};
	};

	const getMemberPhoto = defineRoute({
		method: 'get',
		path: '/members/{memberId}/photo',
		operationId: 'core.getMemberPhoto',
		summary: 'The profile photo of a member',
		requires: CORE_CAPABILITIES.membersView.id,
		params: PhotoParams,
		response: FileResponseSchema,
		async handle(ctx, { params }) {
			const row = await members(ctx.db)
				.selectFrom('core_members')
				.select(['photo', 'photo_type'])
				.where('id', '=', params.memberId)
				.where('archived_at', 'is', null)
				.executeTakeFirst();
			if (!row) throw new FamosError('not_found', 'No photo');
			return servePhoto(ctx, row);
		},
	});

	/** The people the profile picker lists: they have a PIN and a role that lets them use it. */
	const pickerMembers = async (db: Parameters<typeof findMember>[0]) => {
		const rows = await members(db)
			.selectFrom('core_members')
			.select(['id', 'display_name', 'color', 'role_id', 'photo', 'photo_type'])
			.where('archived_at', 'is', null)
			.orderBy('created_at')
			.execute();
		const access = deps.access();
		const methods = await deps.identity.signInMethods();
		return rows.filter(
			(r) =>
				methods.get(r.id)?.pin === true &&
				access.effective(r.role_id).has(CORE_CAPABILITIES.signInPin.id),
		);
	};

	const getProfilePhoto = defineRoute({
		method: 'get',
		path: '/profiles/{memberId}/photo',
		operationId: 'core.getProfilePhoto',
		summary: 'The photo of a person in the profile picker',
		requires: 'trusted-device',
		params: PhotoParams,
		response: FileResponseSchema,
		async handle(ctx, { params }) {
			const row = (await pickerMembers(ctx.db)).find((r) => r.id === params.memberId);
			if (!row) throw new FamosError('not_found', 'No photo');
			return servePhoto(ctx, row);
		},
	});

	const listMembers = defineRoute({
		method: 'get',
		path: '/members',
		operationId: 'core.listMembers',
		summary: 'Active family members',
		requires: CORE_CAPABILITIES.membersView.id,
		// How each person signs in: only for those who manage people.
		response: z.array(MemberSchema.extend({ signIn: SignInMethodsSchema.optional() })),
		async handle(ctx, { actor }) {
			const rows = await members(ctx.db)
				.selectFrom('core_members')
				.selectAll()
				.where('archived_at', 'is', null)
				.orderBy('created_at')
				.execute();
			// A display sees names and colors only: no role and no private notes.
			if (actor.kind === 'display')
				return rows.map((row) => ({ ...toMember(row), roleId: '', about: null }));
			if (!deps.access().can(actor, CORE_CAPABILITIES.membersManage.id)) return rows.map(toMember);
			const methods = await deps.identity.signInMethods();
			return rows.map((row) => ({ ...toMember(row), signIn: methods.get(row.id) ?? NO_SIGN_IN }));
		},
	});

	const listProfiles = defineRoute({
		method: 'get',
		path: '/profiles',
		operationId: 'core.listProfiles',
		summary: 'Profile picker for PIN sign-in (name, color and photo only)',
		// Only trusted family devices (or signed-in members) see who lives here.
		requires: 'trusted-device',
		response: z.array(
			z.object({
				id: z.string(),
				displayName: z.string(),
				color: z.string(),
				photo: z.string().nullable(),
			}),
		),
		async handle(ctx) {
			return (await pickerMembers(ctx.db)).map((r) => ({
				id: r.id,
				displayName: r.display_name,
				color: r.color,
				photo: photoToken(r.photo),
			}));
		},
	});

	return {
		createMember,
		updateMember,
		setMyLanguage,
		archiveMember,
		setMemberPhoto,
		removeMemberPhoto,
		deleteMemberPhoto,
		uploadMemberPhoto,
		getMemberPhoto,
		getProfilePhoto,
		listMembers,
		listProfiles,
	};
}
