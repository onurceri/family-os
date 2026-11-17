import {
	defineJob,
	defineRoute,
	type EventBus,
	type ExtensionContext,
	FamosError,
	isFullSignIn,
	personPresent,
	selfOf,
} from '@famos/sdk';
import { z } from 'zod';
import { revokeTokensOf } from '../api-tokens.ts';
import { CORE_CAPABILITIES } from '../core-capabilities.ts';
import { sessionEnded } from '../core-events.ts';
import { DecisionSchema } from '../decide.ts';
import { SleepWindowSchema, sleepOf } from '../device-sleep.ts';
import { slideshowOn } from '../device-slideshow.ts';
import { DeviceSchema, toDevice } from '../devices.ts';
import { NextUpModeSchema, readNextUp } from '../next-up.ts';
import type { CoreExtensionDeps } from './deps.ts';
import {
	END_CREDENTIALS_JOB,
	findMember,
	MemberIdSchema,
	MemberSchema,
	NO_SIGN_IN,
	requireMember,
	SignInMethodsSchema,
	toMember,
} from './member-rows.ts';

/**
 * Who is signed in and what they may do, trusted devices, a member's logins, and ending
 * sessions and the credentials made with them.
 */
export function createSignIn(deps: CoreExtensionDeps) {
	const me = defineRoute({
		method: 'get',
		path: '/me',
		operationId: 'core.getMe',
		summary: 'The signed-in member, with what their role allows',
		requires: 'signedIn',
		response: MemberSchema.extend({
			/** What this sign-in allows: a PIN sign-in never holds critical capabilities. */
			capabilities: z.array(z.string()),
			/** How this person can sign in. */
			signIn: SignInMethodsSchema,
			/** Signed in with a password (not a PIN): only then may keys, tokens and addresses be made. */
			fullSignIn: z.boolean(),
			/** Extensions turned off in Settings → Family → Extensions; their UI is hidden. */
			disabledExtensions: z.array(z.string()),
			/** Whose next thing the hero on Today shows (`core.setMyNextUp`). */
			nextUp: NextUpModeSchema,
			/**
			 * The trusted family device this session is on, and whether it shows the family's photos
			 * after a while without a touch; null on any other browser (a display, a personal phone).
			 */
			device: z.object({ slideshow: z.boolean(), sleep: SleepWindowSchema.nullable() }).nullable(),
		}),
		async handle(ctx, { actor, device }) {
			const row = await findMember(ctx.db, requireMember(actor).memberId);
			const access = deps.access();
			const signIn = (await deps.identity.signInMethods()).get(row.id) ?? NO_SIGN_IN;
			return {
				...toMember(row),
				capabilities: [...access.effective(row.role_id)].filter((c) => access.can(actor, c)),
				signIn,
				fullSignIn: isFullSignIn(actor),
				disabledExtensions: [...deps.features().disabled()],
				nextUp: await readNextUp(ctx.db, row.id),
				device: device
					? {
							slideshow: await slideshowOn(ctx.db, device.id),
							sleep: await sleepOf(ctx.db, device.id),
						}
					: null,
			};
		},
	});

	/** The dark hours of a family device, for its sign-in page where nobody is signed in yet. */
	const deviceSleep = defineRoute({
		method: 'get',
		path: '/device/sleep',
		operationId: 'core.getDeviceSleep',
		summary: 'The hours this family device goes dark, for its sign-in page',
		requires: 'trusted-device',
		response: z.object({
			sleep: SleepWindowSchema.nullable(),
			/** What the hours are read in and written with: nobody is signed in to say. */
			timeZone: z.string(),
			formatLocale: z.string(),
			hourCycle: z.enum(['h12', 'h23']),
		}),
		async handle(ctx, { device }) {
			const family = await ctx.family.settings();
			return {
				sleep: device ? await sleepOf(ctx.db, device.id) : null,
				timeZone: family.timeZone,
				formatLocale: family.formatLocale,
				hourCycle: family.hourCycle,
			};
		},
	});

	/**
	 * For every data-changing action that is on, what running it would do for this sign-in, for
	 * any input. An answer marked `depends` can change with the input (their own thing, an
	 * exception of the action): `POST /api/v1/actions/{actionId}/check` gives the exact one.
	 */
	const myAccess = defineRoute({
		method: 'get',
		path: '/access',
		operationId: 'core.getAccess',
		summary:
			'What the signed-in member may do with each action (apply, suggest or not at all); `depends` answers can change with the input',
		requires: 'signedIn',
		response: z.object({ actions: z.record(z.string(), DecisionSchema) }),
		async handle(_ctx, { actor }) {
			return { actions: deps.runner().decisions(actor) };
		},
	});

	const listDevices = defineRoute({
		method: 'get',
		path: '/devices',
		operationId: 'core.listDevices',
		summary: 'Trusted family devices',
		requires: CORE_CAPABILITIES.devicesManage.id,
		response: z.array(DeviceSchema),
		async handle() {
			const devices = deps.devices();
			return (await devices.list()).map((row) => toDevice(row, devices.leftOut(row.id)));
		},
	});

	const currentDevice = defineRoute({
		method: 'get',
		path: '/devices/current',
		operationId: 'core.getCurrentDevice',
		summary: 'The trusted device this request comes from, if any',
		requires: 'public',
		response: z.object({ device: z.object({ id: z.string(), name: z.string() }).nullable() }),
		async handle(_ctx, { device }) {
			return { device };
		},
	});

	const MemberParams = z.object({ memberId: MemberIdSchema });

	/**
	 * Revokes the member's API tokens and enqueues the job that ends the extensions' credentials,
	 * in one transaction, before their sessions end: if it fails the sign-out does not happen and
	 * the person tries again, so nothing they meant to stop keeps working.
	 */
	const endCredentialsOf = (ctx: ExtensionContext, memberId: string) =>
		ctx.db.transaction().execute(async (trx) => {
			await revokeTokensOf(trx, memberId, ctx.clock.now());
			await deps.enqueueIn(trx, END_CREDENTIALS_JOB, { memberId });
		});

	/** Signs a member out everywhere and closes their open realtime connections at once. */
	const endSessionsOf = async (ctx: { events: EventBus }, memberId: string) => {
		await deps.identity.endSessions(memberId);
		await ctx.events.emit(sessionEnded, { memberId });
	};

	const setPin = defineRoute({
		method: 'put',
		path: '/members/{memberId}/pin',
		operationId: 'core.setMemberPin',
		summary: "Set a member's PIN login",
		requires: CORE_CAPABILITIES.membersManage.id,
		params: MemberParams,
		body: z.object({ pin: z.string().regex(/^\d{4,6}$/) }),
		response: z.object({ ok: z.literal(true) }),
		status: 200,
		async handle(ctx, { params, body, actor }) {
			const member = await findMember(ctx.db, params.memberId);
			// A custom role may be kept to passwords. (A PIN sign-in never administers, whatever the role.)
			if (!deps.access().effective(member.role_id).has(CORE_CAPABILITIES.signInPin.id)) {
				throw new FamosError('conflict', "This member's role signs in with a password, not a PIN");
			}
			await deps.identity.setPin({
				memberId: member.id,
				pin: body.pin,
				displayName: member.display_name,
			});
			await endSessionsOf(ctx, member.id);
			await deps.audit.record(actor, 'core.setMemberPin', member.id);
			return { ok: true as const };
		},
	});

	const setPassword = defineRoute({
		method: 'put',
		path: '/members/{memberId}/password',
		operationId: 'core.setMemberPassword',
		summary: "Set a member's email + password login",
		requires: CORE_CAPABILITIES.membersManage.id,
		params: MemberParams,
		body: z.object({ email: z.email(), password: z.string().min(10).max(200) }),
		response: z.object({ ok: z.literal(true) }),
		async handle(ctx, { params, body, actor }) {
			const member = await findMember(ctx.db, params.memberId);
			// The old password may be known to someone: what it made (keys, addresses) ends with it.
			await endCredentialsOf(ctx, member.id);
			await deps.identity.setPasswordLogin({
				memberId: member.id,
				...body,
				displayName: member.display_name,
			});
			// A new password signs the member out everywhere, except an admin changing their own.
			if (selfOf(actor) !== member.id) await endSessionsOf(ctx, member.id);
			await deps.audit.record(actor, 'core.setMemberPassword', member.id);
			return { ok: true as const };
		},
	});

	const signOutEverywhere = defineRoute({
		method: 'post',
		path: '/sessions/end',
		operationId: 'core.signOutEverywhere',
		summary: "End all of the caller's sessions, on every device",
		requires: 'signedIn',
		response: z.object({ ok: z.literal(true) }),
		status: 200,
		async handle(ctx, { actor }) {
			if (!personPresent(actor)) throw new FamosError('unauthenticated', 'Sign in required');
			// Keys and calendar addresses are sign-ins too: they end with the sessions.
			await endCredentialsOf(ctx, actor.memberId);
			await endSessionsOf(ctx, actor.memberId);
			await deps.audit.record(actor, 'core.signOutEverywhere', actor.memberId);
			return { ok: true as const };
		},
	});

	const endCredentials = defineJob({
		name: END_CREDENTIALS_JOB,
		payload: z.object({ memberId: z.string() }),
		maxAttempts: 10,
		timeoutMs: 30_000,
		backoff: (attempt) => Math.min(60_000, 2_000 * 2 ** (attempt - 1)),
		async handle(ctx, { memberId }) {
			// Again, in case a token was made between the change and now.
			await revokeTokensOf(ctx.db, memberId, ctx.clock.now());
			for (const ext of deps.registry().extensions)
				await ext.endCredentials?.(deps.jobContext(ext.id), memberId);
		},
	});

	return {
		me,
		deviceSleep,
		myAccess,
		listDevices,
		currentDevice,
		setPin,
		setPassword,
		signOutEverywhere,
		endCredentials,
	};
}
