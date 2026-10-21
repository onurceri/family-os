import {
	type Actor,
	type CapabilityDefinition,
	type Clock,
	type DbExecutor,
	FamosError,
	type IdentityAdmin,
	type IdGenerator,
	personPresent,
} from '@famos/sdk';
import { z } from 'zod';
import type { Access } from './access.ts';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { deviceChanged, displayFitChanged } from './core-events.ts';
import type { InProcessEventBus } from './event-bus.ts';
import { type Features, ownerOf } from './features.ts';
import type { CoreTables, DeviceRow } from './tables.ts';

/**
 * Trusted family devices. An admin marks a device (kitchen tablet, a child's phone)
 * as a family device; it receives a random token kept in an httpOnly cookie. The profile picker
 * and PIN sign-in only work from such devices, so a PIN can never be guessed over the internet.
 * Only the token's SHA-256 is stored. Uses Web Crypto, so core stays runtime-neutral.
 */
export interface DeviceService {
	trust(
		actor: Actor,
		input: { name: string; kind?: DeviceRow['kind'] },
	): Promise<{ device: DeviceRow; token: string }>;
	/** Returns the active device for a token, or null. Updates `last_seen_at` at most hourly. */
	verify(token: string | undefined | null): Promise<DeviceRow | null>;
	list(): Promise<DeviceRow[]>;
	/** Revokes the device and ends the sessions signed in on it. */
	revoke(actor: Actor, deviceId: string): Promise<DeviceRow>;
	/**
	 * Revokes the device in the caller's transaction and nothing more: the action that does it
	 * ends the device's sessions with a job and tells the screens (`deviceChanged`) itself.
	 */
	revokeIn(db: DbExecutor, actor: Actor, deviceId: string): Promise<DeviceRow>;
	/**
	 * The holder of a family device's token stops using it as a family device: the same effect as
	 * `revoke` (record revoked, PIN sessions on it ended), without needing an admin to be signed in.
	 * Returns the device's id, or null when the token is not an active family device (displays are
	 * not affected).
	 */
	forget(token: string | undefined | null): Promise<string | null>;
	/** Whether a family device id is trusted and not revoked (checked for every PIN session). */
	isActive(deviceId: string): Promise<boolean>;

	/* ───────────── Family displays ───────────── */

	/** Starts pairing a display: a long device code for the display, a short user code for the phone. */
	startPairing(input?: { ip?: string }): Promise<PairingStart>;
	/** The display asks whether it was confirmed. The token comes back exactly once. */
	pollPairing(deviceCode: string): Promise<PairingPoll>;
	/**
	 * An admin types the user code, names the display and chooses what it may show. The display is
	 * connected only once it claims the confirmed code (its next poll): `pairingStatus` says when.
	 */
	confirmPairing(
		actor: Actor,
		userCode: string,
		input: DisplayGrant,
	): Promise<{ name: string; pairingId: string }>;
	/**
	 * The open pairing a typed code names, once the grant is valid. A wrong code is counted against every open pairing
	 * (five misses end them all), so it runs on its own, never inside a transaction that a
	 * refusal would roll back with the count.
	 */
	findPairing(actor: Actor, userCode: string, input: DisplayGrant): Promise<string>;
	/** Confirms the pairing `findPairing` found, in the caller's transaction. */
	confirmPairingIn(
		db: DbExecutor,
		actor: Actor,
		pairingId: string,
		input: DisplayGrant,
	): Promise<{ name: string; pairingId: string }>;
	/** Whether the display of a confirmed code has claimed it yet, for the admin who confirmed it. */
	pairingStatus(actor: Actor, pairingId: string): Promise<PairingStatus>;
	/** Renames a display or changes what it may show. */
	updateDisplay(actor: Actor, deviceId: string, patch: Partial<DisplayGrant>): Promise<DeviceRow>;
	/** `updateDisplay` in the caller's transaction; the action tells the display (`deviceChanged`). */
	updateDisplayIn(
		db: DbExecutor,
		actor: Actor,
		deviceId: string,
		patch: Partial<DisplayGrant>,
	): Promise<DeviceRow>;
	/** The view capabilities an admin can give a display (extensions that are on). */
	grantableCapabilities(): CapabilityDefinition[];
	/**
	 * A display tells what its screen had no room for (widget ids, groups of blocks), so its admin
	 * is not left guessing. Kept in memory only: the display tells it again after every fit and
	 * every few minutes, so a restart forgets it for that long at most.
	 */
	reportFit(deviceId: string, leftOut: readonly string[]): Promise<void>;
	/** What a display last said its screen had no room for (empty when it said nothing yet). */
	leftOut(deviceId: string): string[];
}

export interface DisplayGrant {
	name: string;
	/** View-level capability ids the display may use. */
	capabilities: readonly string[];
	/** Member names and colors may be shown on this display. */
	showNames: boolean;
}

export interface PairingStart {
	deviceCode: string;
	userCode: string;
	expiresAt: number;
	/** Seconds between polls. */
	interval: number;
}

export type PairingPoll =
	| { status: 'pending' | 'slow_down' | 'expired' }
	| { status: 'paired'; token: string; device: DeviceRow };

/**
 * A confirmed code, seen from the admin's side: `waiting` until the display claims it (`answering`
 * says whether a display asked with it lately, so a screen that was closed is told apart),
 * `connected` with the new device once it has, `expired` when the code ran out first.
 */
export type PairingStatus =
	| { status: 'waiting'; answering: boolean }
	| { status: 'connected'; deviceId: string }
	| { status: 'expired' };

export const DeviceSchema = z.object({
	id: z.string(),
	name: z.string(),
	kind: z.enum(['family', 'kiosk']),
	createdAt: z.number(),
	lastSeenAt: z.number(),
	/**
	 * Displays only: what the display may show, and what its screen last had no room for (widget
	 * ids, and `family`, `chores`, `extras`, `photo` for groups of Today's blocks).
	 */
	display: z
		.object({
			capabilities: z.array(z.string()),
			showNames: z.boolean(),
			leftOut: z.array(z.string()),
		})
		.nullable(),
});

export const toDevice = (
	row: DeviceRow,
	leftOut: readonly string[] = [],
): z.infer<typeof DeviceSchema> => ({
	id: row.id,
	name: row.name,
	kind: row.kind,
	createdAt: row.created_at,
	lastSeenAt: row.last_seen_at,
	display:
		row.kind === 'kiosk' && row.display_capabilities !== null
			? {
					capabilities: JSON.parse(row.display_capabilities) as string[],
					showNames: row.display_show_names === 1,
					leftOut: [...leftOut],
				}
			: null,
});

/** Pairing codes live ten minutes. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_INTERVAL_SECONDS = 5;
/** A display polling faster than this is told to slow down. */
const MIN_POLL_MS = 4000;
/** A display that asked within this long is still there (it asks every five seconds). */
const ANSWERING_MS = 15_000;
const MAX_WRONG_CODES = 5;
const MAX_OPEN_PAIRINGS = 100;
/**
 * Open codes one address may hold, so a few addresses cannot take every one of the family-wide
 * slots. A household with a few displays starting up at once still fits.
 */
export const MAX_OPEN_PAIRINGS_PER_ADDRESS = 3;
/** No 0/O, 1/I/L: a code read from a screen and typed on a phone must not be ambiguous. */
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** The actor of a paired display, or null when the device is not one. */
export function displayActor(row: DeviceRow | null): Actor | null {
	if (row?.kind !== 'kiosk' || row.revoked_at !== null || row.display_capabilities === null)
		return null;
	return {
		kind: 'display',
		deviceId: row.id,
		capabilities: JSON.parse(row.display_capabilities) as string[],
		showNames: row.display_show_names === 1,
	};
}

/** `abcd efgh`, `ABCD-EFGH` → `ABCD-EFGH`; null when it cannot be a code. */
export function normalizeUserCode(text: string): string | null {
	const clean = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
	if (clean.length !== 8 || [...clean].some((ch) => !USER_CODE_ALPHABET.includes(ch))) return null;
	return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

function randomUserCode(): string {
	const chars: string[] = [];
	// Rejection sampling keeps every letter equally likely.
	const limit = 256 - (256 % USER_CODE_ALPHABET.length);
	while (chars.length < 8) {
		for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
			if (byte < limit && chars.length < 8)
				chars.push(USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length] as string);
		}
	}
	return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

const SEEN_RESOLUTION_MS = 60 * 60 * 1000;

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createDeviceService(deps: {
	db: DbExecutor;
	clock: Clock;
	ids: IdGenerator;
	bus: InProcessEventBus;
	identity: Pick<IdentityAdmin, 'endDeviceSessions'>;
	/** Capability checks; a getter because the registry is built after this service. */
	access: () => Access;
	/** Which extensions are on; a getter for the same reason. */
	features: () => Features;
}): DeviceService {
	/** Last poll per device code, to answer `slow_down` (in memory: a restart only forgets it). */
	const lastPoll = new Map<string, number>();
	/** What each display last said it had no room for. */
	const fits = new Map<string, string[]>();
	const pairings = () => deps.db.withTables<CoreTables>();
	const grantable = (): CapabilityDefinition[] =>
		deps
			.access()
			.capabilities.filter(
				(c) =>
					c.level === 'view' &&
					(ownerOf(c.id) !== 'core' || c.id === CORE_CAPABILITIES.draftsWaiting.id) &&
					deps.features().isOn(ownerOf(c.id)),
			);
	/** Only view capabilities of extensions that are on can be given (names go with `showNames`). */
	const checkGrant = (capabilities: readonly string[]): string[] => {
		const allowed = new Set(grantable().map((c) => c.id));
		for (const id of capabilities) {
			if (!allowed.has(id))
				throw new FamosError('bad_request', `"${id}" cannot be given to a display`);
		}
		return [...new Set(capabilities)].sort();
	};
	const cleanName = (text: string) => {
		const name = text.trim().slice(0, 60);
		if (!name) throw new FamosError('bad_request', 'Display name is required');
		return name;
	};
	const devices = () => deps.db.withTables<CoreTables>();
	const requireAdmin = (actor: Actor): string => {
		if (!personPresent(actor) || !deps.access().can(actor, 'core.devices.manage')) {
			throw new FamosError('forbidden', 'Not allowed to manage family devices');
		}
		return actor.memberId;
	};

	const markRevoked = async (db: DbExecutor, deviceId: string): Promise<DeviceRow> => {
		const result = await db
			.withTables<CoreTables>()
			.updateTable('core_devices')
			.set({ revoked_at: deps.clock.now() })
			.where('id', '=', deviceId)
			.where('revoked_at', 'is', null)
			.returningAll()
			.executeTakeFirst();
		if (!result) throw new FamosError('not_found', 'Device not found');
		fits.delete(deviceId);
		return result;
	};

	const revokeById = async (deviceId: string): Promise<DeviceRow> => {
		const result = await markRevoked(deps.db, deviceId);
		await deps.identity.endDeviceSessions(deviceId);
		await deps.bus.publish(deviceChanged.name, { deviceId });
		return result;
	};

	const findPairing = async (
		actor: Actor,
		userCode: string,
		input: DisplayGrant,
	): Promise<string> => {
		requireAdmin(actor);
		// Checked before the code, so a bad grant never counts as a wrong code.
		cleanName(input.name);
		checkGrant(input.capabilities);
		const now = deps.clock.now();
		const code = normalizeUserCode(userCode);
		const row = code
			? await pairings()
					.selectFrom('core_display_pairings')
					.select('id')
					.where('user_code', '=', code)
					.where('status', '=', 'pending')
					.where('expires_at', '>', now)
					.where('attempts', '<', MAX_WRONG_CODES)
					.executeTakeFirst()
			: undefined;
		if (!row) {
			// A wrong code counts against every open pairing: five misses end them all, so the
			// codes cannot be guessed (the displays simply ask for a new one).
			await pairings()
				.updateTable('core_display_pairings')
				.set((eb) => ({ attempts: eb('attempts', '+', 1) }))
				.where('status', '=', 'pending')
				.where('expires_at', '>', now)
				.execute();
			throw new FamosError('not_found', 'This code is not valid (any more)');
		}
		return row.id;
	};

	const confirmPairingIn = async (
		db: DbExecutor,
		actor: Actor,
		pairingId: string,
		input: DisplayGrant,
	): Promise<{ name: string; pairingId: string }> => {
		const confirmedBy = requireAdmin(actor);
		const name = cleanName(input.name);
		const capabilities = checkGrant(input.capabilities);
		const confirmed = await db
			.withTables<CoreTables>()
			.updateTable('core_display_pairings')
			.set({
				status: 'confirmed',
				name,
				capabilities: JSON.stringify(capabilities),
				show_names: input.showNames ? 1 : 0,
				confirmed_by: confirmedBy,
			})
			.where('id', '=', pairingId)
			.where('status', '=', 'pending')
			.where('expires_at', '>', deps.clock.now())
			.returning('id')
			.executeTakeFirst();
		if (!confirmed) throw new FamosError('not_found', 'This code is not valid (any more)');
		return { name, pairingId };
	};

	const updateDisplayIn = async (
		db: DbExecutor,
		actor: Actor,
		deviceId: string,
		patch: Partial<DisplayGrant>,
	): Promise<DeviceRow> => {
		requireAdmin(actor);
		const set: Partial<DeviceRow> = {};
		if (patch.name !== undefined) set.name = cleanName(patch.name);
		if (patch.capabilities !== undefined)
			set.display_capabilities = JSON.stringify(checkGrant(patch.capabilities));
		if (patch.showNames !== undefined) set.display_show_names = patch.showNames ? 1 : 0;
		const table = db.withTables<CoreTables>();
		const row = await table
			.selectFrom('core_devices')
			.selectAll()
			.where('id', '=', deviceId)
			.where('kind', '=', 'kiosk')
			.where('revoked_at', 'is', null)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Display not found');
		if (Object.keys(set).length > 0)
			await table.updateTable('core_devices').set(set).where('id', '=', deviceId).execute();
		return { ...row, ...set };
	};

	return {
		async trust(actor, input) {
			const createdBy = requireAdmin(actor);
			const name = input.name.trim().slice(0, 60);
			if (!name) throw new FamosError('bad_request', 'Device name is required');
			const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
			const now = deps.clock.now();
			const device: DeviceRow = {
				id: deps.ids.next('device'),
				name,
				kind: input.kind ?? 'family',
				token_hash: await sha256Hex(token),
				created_by: createdBy,
				created_at: now,
				last_seen_at: now,
				revoked_at: null,
				display_capabilities: null,
				display_show_names: 0,
			};
			await devices().insertInto('core_devices').values(device).execute();
			await deps.bus.publish(deviceChanged.name, { deviceId: device.id });
			return { device, token };
		},

		async verify(token) {
			if (!token || token.length < 32 || token.length > 128) return null;
			const row = await devices()
				.selectFrom('core_devices')
				.selectAll()
				.where('token_hash', '=', await sha256Hex(token))
				.where('revoked_at', 'is', null)
				.executeTakeFirst();
			if (!row) return null;
			const now = deps.clock.now();
			if (now - row.last_seen_at >= SEEN_RESOLUTION_MS) {
				await devices()
					.updateTable('core_devices')
					.set({ last_seen_at: now })
					.where('id', '=', row.id)
					.execute();
				row.last_seen_at = now;
			}
			return row;
		},

		async isActive(deviceId) {
			const row = await devices()
				.selectFrom('core_devices')
				.select('id')
				.where('id', '=', deviceId)
				.where('kind', '=', 'family')
				.where('revoked_at', 'is', null)
				.executeTakeFirst();
			return row !== undefined;
		},

		list() {
			return devices()
				.selectFrom('core_devices')
				.selectAll()
				.where('revoked_at', 'is', null)
				.orderBy('created_at')
				.execute();
		},

		async forget(token) {
			if (!token || token.length < 32 || token.length > 128) return null;
			const row = await devices()
				.selectFrom('core_devices')
				.select('id')
				.where('token_hash', '=', await sha256Hex(token))
				.where('kind', '=', 'family')
				.where('revoked_at', 'is', null)
				.executeTakeFirst();
			if (!row) return null;
			await revokeById(row.id);
			return row.id;
		},

		async revoke(actor, deviceId) {
			requireAdmin(actor);
			return revokeById(deviceId);
		},

		async revokeIn(db, actor, deviceId) {
			requireAdmin(actor);
			return markRevoked(db, deviceId);
		},

		async startPairing(input) {
			const now = deps.clock.now();
			// Old records go; a flood of unconfirmed codes cannot fill the table either.
			await pairings()
				.deleteFrom('core_display_pairings')
				.where('expires_at', '<', now - PAIRING_TTL_MS)
				.execute();
			const open = await pairings()
				.selectFrom('core_display_pairings')
				.select((eb) => eb.fn.countAll<number>().as('n'))
				.where('status', '!=', 'consumed')
				.where('expires_at', '>', now)
				.executeTakeFirstOrThrow();
			if (Number(open.n) >= MAX_OPEN_PAIRINGS)
				throw new FamosError('limit_reached', 'Too many displays are waiting to be paired');
			if (input?.ip) {
				const own = await pairings()
					.selectFrom('core_display_pairings')
					.select((eb) => eb.fn.countAll<number>().as('n'))
					.where('status', '!=', 'consumed')
					.where('expires_at', '>', now)
					.where('created_ip', '=', input.ip)
					.executeTakeFirstOrThrow();
				if (Number(own.n) >= MAX_OPEN_PAIRINGS_PER_ADDRESS)
					throw new FamosError('limit_reached', 'Too many displays are waiting to be paired here');
			}

			const deviceCode = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
			let userCode = randomUserCode();
			for (let tries = 0; tries < 5; tries++) {
				const clash = await pairings()
					.selectFrom('core_display_pairings')
					.select('id')
					.where('user_code', '=', userCode)
					.where('status', '=', 'pending')
					.where('expires_at', '>', now)
					.executeTakeFirst();
				if (!clash) break;
				userCode = randomUserCode();
			}
			const expiresAt = now + PAIRING_TTL_MS;
			await pairings()
				.insertInto('core_display_pairings')
				.values({
					id: deps.ids.next('pairing'),
					device_code_hash: await sha256Hex(deviceCode),
					user_code: userCode,
					expires_at: expiresAt,
					attempts: 0,
					status: 'pending',
					name: null,
					capabilities: null,
					show_names: 0,
					confirmed_by: null,
					device_id: null,
					created_ip: input?.ip ?? null,
					created_at: now,
				})
				.execute();
			return { deviceCode, userCode, expiresAt, interval: PAIRING_INTERVAL_SECONDS };
		},

		async pollPairing(deviceCode) {
			if (deviceCode.length < 32 || deviceCode.length > 128) return { status: 'expired' };
			const hash = await sha256Hex(deviceCode);
			const now = deps.clock.now();
			const row = await pairings()
				.selectFrom('core_display_pairings')
				.selectAll()
				.where('device_code_hash', '=', hash)
				.executeTakeFirst();
			if (!row || row.status === 'consumed' || row.expires_at <= now) {
				lastPoll.delete(hash);
				return { status: 'expired' };
			}
			const last = lastPoll.get(hash);
			lastPoll.set(hash, now);
			if (lastPoll.size > 1000) {
				for (const [key, at] of lastPoll) if (now - at > PAIRING_TTL_MS) lastPoll.delete(key);
			}
			if (last !== undefined && now - last < MIN_POLL_MS) return { status: 'slow_down' };
			if (row.status === 'pending') return { status: 'pending' };

			// Confirmed: exactly one poll wins and receives the token.
			const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
			const device: DeviceRow = {
				id: deps.ids.next('device'),
				name: row.name ?? 'Display',
				kind: 'kiosk',
				token_hash: await sha256Hex(token),
				created_by: row.confirmed_by ?? '',
				created_at: now,
				last_seen_at: now,
				revoked_at: null,
				display_capabilities: row.capabilities ?? '[]',
				display_show_names: row.show_names,
			};
			const won = await pairings()
				.updateTable('core_display_pairings')
				.set({ status: 'consumed', device_id: device.id })
				.where('id', '=', row.id)
				.where('status', '=', 'confirmed')
				.returning('id')
				.executeTakeFirst();
			if (!won) return { status: 'expired' };
			lastPoll.delete(hash);
			await devices().insertInto('core_devices').values(device).execute();
			await deps.bus.publish(deviceChanged.name, { deviceId: device.id });
			return { status: 'paired', token, device };
		},

		async confirmPairing(actor, userCode, input) {
			return confirmPairingIn(deps.db, actor, await findPairing(actor, userCode, input), input);
		},

		findPairing,
		confirmPairingIn,

		async pairingStatus(actor, pairingId) {
			requireAdmin(actor);
			const now = deps.clock.now();
			const row = await pairings()
				.selectFrom('core_display_pairings')
				.select(['status', 'device_id', 'expires_at', 'device_code_hash'])
				.where('id', '=', pairingId)
				.executeTakeFirst();
			// Gone: cleaned up long after it ran out.
			if (!row) return { status: 'expired' };
			if (row.status === 'consumed' && row.device_id)
				return { status: 'connected', deviceId: row.device_id };
			if (row.status !== 'confirmed' || row.expires_at <= now) return { status: 'expired' };
			const last = lastPoll.get(row.device_code_hash);
			return { status: 'waiting', answering: last !== undefined && now - last < ANSWERING_MS };
		},

		async updateDisplay(actor, deviceId, patch) {
			const row = await updateDisplayIn(deps.db, actor, deviceId, patch);
			await deps.bus.publish(deviceChanged.name, { deviceId });
			return row;
		},

		updateDisplayIn,

		grantableCapabilities: grantable,

		async reportFit(deviceId, leftOut) {
			const next = [...new Set(leftOut)].sort();
			const before = fits.get(deviceId) ?? [];
			if (next.length === 0) fits.delete(deviceId);
			else fits.set(deviceId, next);
			if (next.join() !== before.join())
				await deps.bus.publish(displayFitChanged.name, { deviceId });
		},

		leftOut: (deviceId) => [...(fits.get(deviceId) ?? [])],
	};
}
