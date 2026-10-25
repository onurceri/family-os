import {
	type Actor,
	type DbExecutor,
	FamosError,
	idSchema,
	personPresent,
	type UnitOfWork,
} from '@famos/sdk';
import { z } from 'zod';
import { LanguageCodeSchema } from '../family.ts';
import type { CoreTables, MemberRow } from '../tables.ts';

/**
 * Member colors. Eight hues kept away from coral/red so a member's
 * color never reads as "attention". Assigned in order; admins can change them.
 */
export const MEMBER_COLORS = [
	'#3d7aae',
	'#c38f22',
	'#975cbd',
	'#2f9a94',
	'#c66591',
	'#68778b',
	'#996c46',
	'#5c923d',
];

export const MemberIdSchema = idSchema('member');
export const ColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);
export const LocaleSchema = LanguageCodeSchema;
export const RoleIdSchema = z.string().min(1).max(60);
export const AboutSchema = z.string().trim().max(300);

export const MemberSchema = z.object({
	id: z.string(),
	displayName: z.string(),
	roleId: z.string(),
	/** Free text about the person, for context; no security meaning. */
	about: z.string().nullable(),
	color: z.string(),
	locale: LocaleSchema.nullable(),
	createdAt: z.number(),
	archived: z.boolean(),
});
export type Member = z.infer<typeof MemberSchema>;

/** Which logins a person has (never the email, password or PIN themselves). */
export const SignInMethodsSchema = z.object({
	/** An email and password: works on every device. */
	password: z.boolean(),
	/** A PIN: works only on family devices. */
	pin: z.boolean(),
});
export const NO_SIGN_IN = { password: false, pin: false };

export const toMember = (row: MemberRow): Member => ({
	id: row.id,
	displayName: row.display_name,
	roleId: row.role_id,
	about: row.about,
	color: row.color,
	locale: row.locale,
	createdAt: row.created_at,
	archived: row.archived_at !== null,
});

export const members = (db: DbExecutor) => db.withTables<CoreTables>();

export async function findMember(db: DbExecutor, id: string): Promise<MemberRow> {
	const row = await members(db)
		.selectFrom('core_members')
		.selectAll()
		.where('id', '=', id)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Member not found');
	return row;
}

export async function activeAdminCount(db: DbExecutor): Promise<number> {
	const row = await members(db)
		.selectFrom('core_members')
		.select((eb) => eb.fn.countAll<number>().as('n'))
		.where('role_id', '=', 'admin')
		.where('archived_at', 'is', null)
		.executeTakeFirstOrThrow();
	return Number(row.n);
}

export async function insertMember(
	uow: Pick<UnitOfWork, 'db' | 'ids' | 'clock'>,
	input: {
		displayName: string;
		roleId: string;
		about?: string | undefined;
		color?: string | undefined;
		locale?: Member['locale'] | undefined;
	},
): Promise<MemberRow> {
	const count = await members(uow.db)
		.selectFrom('core_members')
		.select((eb) => eb.fn.countAll<number>().as('n'))
		.executeTakeFirstOrThrow();
	const now = uow.clock.now();
	const row: MemberRow = {
		id: uow.ids.next('member'),
		display_name: input.displayName,
		role_id: input.roleId,
		about: input.about?.trim() || null,
		color: input.color ?? MEMBER_COLORS[Number(count.n) % MEMBER_COLORS.length] ?? '#4b5563',
		locale: input.locale ?? null,
		created_at: now,
		updated_at: now,
		archived_at: null,
	};
	await members(uow.db).insertInto('core_members').values(row).execute();
	return row;
}

export const requireMember = (actor: Actor) => {
	if (!personPresent(actor)) throw new FamosError('forbidden', 'Only members can do this');
	return actor;
};

/** Ends a member's keys and extension credentials; retried until it succeeds. */
export const END_CREDENTIALS_JOB = 'core.endCredentials';
