import {
	defineAction,
	defineJob,
	defineNotificationChannel,
	defineRoute,
	type ExtensionContext,
	FamosError,
	isExternalHttpError,
	type JobContext,
	type NotificationMessage,
} from '@famos/sdk';
import { z } from 'zod';
import {
	MemberIdSchema,
	NOTIFY_SERVICE_PATTERN,
	type NotifyStatus,
	type NotifyTargets,
	NotifyTargetsQuerySchema,
	NotifyTargetsSchema,
	PersonLinkSchema,
	SetNotifyTargetInputSchema,
	TestNotifyInputSchema,
} from '../contract/index.ts';
import { homeassistantManage, peopleChanged } from './capabilities.ts';
import { load, recordTokenRefused } from './connection.ts';
import {
	CALL_MAX_BYTES,
	CALL_TIMEOUT_MS,
	ENTITY_MAX_BYTES,
	ENTITY_TIMEOUT_MS,
	LIST_MAX_BYTES,
	LIST_TIMEOUT_MS,
} from './limits.ts';
import { toLink } from './people.ts';
import { type HomeAssistantTables, tables } from './store.ts';
import { CACHE_MS, credentials, memoryOf, once, request } from './values.ts';

/**
 * Texts in the Home Assistant app. An admin picks, for each linked member, the `notify` service
 * of that member's phone; a member then turns the channel on for the kinds they want, as for any
 * channel. A text is one call of that service with the family's token. Home Assistant answers
 * `400` for a service it does not have, which is how a phone that was removed shows. Nothing of
 * the text, the address or the service name is ever logged: only how it went.
 */

type Row = HomeAssistantTables['homeassistant_people'];

const MAX_TARGETS = 200;
const MOBILE_APP = 'mobile_app_';
const TRACKER_PATTERN = /^device_tracker\.([a-z0-9_]+)$/;
/** Taps on "Send a test" within this long are one test. */
const DOUBLE_TAP_MS = 3_000;

/** The `notify` service names of Home Assistant's `GET /api/services` answer; nothing else is kept. */
export function notifyServicesOf(body: unknown): string[] {
	if (!Array.isArray(body)) return [];
	for (const entry of body) {
		if (typeof entry !== 'object' || entry === null) continue;
		const { domain, services } = entry as { domain?: unknown; services?: unknown };
		if (domain !== 'notify' || typeof services !== 'object' || services === null) continue;
		return Object.keys(services)
			.filter((name) => name.length <= 100 && NOTIFY_SERVICE_PATTERN.test(name))
			.sort();
	}
	return [];
}

/** The ids of a person's phones and other trackers, from a `person.*` answer: the only attribute kept. */
export function trackersOf(body: unknown): string[] {
	if (typeof body !== 'object' || body === null) return [];
	const { attributes } = body as { attributes?: unknown };
	if (typeof attributes !== 'object' || attributes === null) return [];
	const { device_trackers } = attributes as { device_trackers?: unknown };
	if (!Array.isArray(device_trackers)) return [];
	return device_trackers.filter(
		(id): id is string => typeof id === 'string' && TRACKER_PATTERN.test(id),
	);
}

/**
 * The services in the order an admin should see them: the phones of the person's trackers first
 * (suggested), then the other phones, then the rest.
 */
export function orderTargets(services: readonly string[], trackers: readonly string[]) {
	const own = new Set(trackers.map((id) => `${MOBILE_APP}${TRACKER_PATTERN.exec(id)?.[1]}`));
	const rank = (service: string) => (own.has(service) ? 0 : service.startsWith(MOBILE_APP) ? 1 : 2);
	return services
		.map((service, index) => ({ service, index, rank: rank(service) }))
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.slice(0, MAX_TARGETS)
		.map(({ service, rank: r }) => ({ service, suggested: r === 0 }));
}

async function readServices(
	ctx: ExtensionContext,
	baseUrl: string,
	token: string,
): Promise<{ status: 'ok' | 'unavailable'; names: string[] }> {
	try {
		const response = await ctx.http.get(
			request(baseUrl, token, '/api/services', LIST_TIMEOUT_MS, LIST_MAX_BYTES),
		);
		if (response.status !== 200) return { status: 'unavailable', names: [] };
		return { status: 'ok', names: notifyServicesOf(JSON.parse(response.text)) };
	} catch (error) {
		ctx.logger.info(
			{ code: isExternalHttpError(error) ? error.code : 'failed' },
			'home assistant services unavailable',
		);
		return { status: 'unavailable', names: [] };
	}
}

async function trackersFor(
	ctx: ExtensionContext,
	baseUrl: string,
	token: string,
	personEntity: string,
): Promise<string[]> {
	try {
		const response = await ctx.http.get(
			request(baseUrl, token, `/api/states/${personEntity}`, ENTITY_TIMEOUT_MS, ENTITY_MAX_BYTES),
		);
		return response.status === 200 ? trackersOf(JSON.parse(response.text)) : [];
	} catch {
		// Without the person the list only loses its suggestion.
		return [];
	}
}

const rowOf = (ctx: ExtensionContext, memberId: string): Promise<Row | undefined> =>
	tables(ctx.db)
		.selectFrom('homeassistant_people')
		.selectAll()
		.where('member_id', '=', memberId)
		.executeTakeFirst();

export const getNotifyTargets = defineRoute({
	method: 'get',
	path: '/notify-targets',
	operationId: 'homeassistant.listNotifyTargets',
	summary:
		"The notify services Home Assistant has, a member's own phones first (read live, cached for a minute)",
	requires: homeassistantManage.id,
	query: NotifyTargetsQuerySchema,
	response: NotifyTargetsSchema,
	async handle(ctx, { query }): Promise<NotifyTargets> {
		const connection = await credentials(ctx);
		if (!connection || connection.token === null) return { targets: [], status: 'not_connected' };
		const { baseUrl, token, stamp } = connection;
		const memory = memoryOf(ctx);
		const key = String(stamp);
		const now = ctx.clock.now();
		let hit = memory.services;
		if (!hit || hit.key !== key || now - hit.at < 0 || now - hit.at >= CACHE_MS) {
			const value = await once(memory, `services:${key}`, () => readServices(ctx, baseUrl, token));
			hit = { key, at: ctx.clock.now(), value };
			// A failure is not kept: the next look asks again.
			memory.services = value.status === 'ok' ? hit : null;
		}
		if (hit.value.status !== 'ok') return { targets: [], status: 'unavailable' };
		const person = query.memberId ? (await rowOf(ctx, query.memberId))?.person_entity : undefined;
		const trackers = person ? await trackersFor(ctx, baseUrl, token, person) : [];
		return { targets: orderTargets(hit.value.names, trackers), status: 'ok' };
	},
});

export const setNotifyTarget = defineAction({
	id: 'homeassistant.setNotifyTarget',
	title: "Choose the phone a member's texts go to in Home Assistant",
	input: SetNotifyTargetInputSchema,
	output: PersonLinkSchema,
	requires: homeassistantManage.id,
	approval: 'never',
	async run(uow, input) {
		const db = tables(uow.db);
		const row = await db
			.selectFrom('homeassistant_people')
			.selectAll()
			.where('member_id', '=', input.memberId)
			.executeTakeFirst();
		if (!row)
			throw new FamosError('not_found', 'That member is not linked to a Home Assistant person');
		// The same phone again keeps what the last send found out about it.
		if (row.notify_service === input.service) return toLink(row);
		await db
			.updateTable('homeassistant_people')
			.set({ notify_service: input.service, notify_status: null, updated_at: uow.clock.now() })
			.where('member_id', '=', input.memberId)
			.execute();
		uow.emit(peopleChanged, {});
		return toLink({ ...row, notify_service: input.service, notify_status: null });
	},
});

export const testNotify = defineAction({
	id: 'homeassistant.testNotify',
	title: "Send a test text to a member's phone through Home Assistant",
	input: TestNotifyInputSchema,
	output: z.object({ ok: z.literal(true) }),
	requires: homeassistantManage.id,
	approval: 'never',
	refuseProposal: async () => 'Only a person can send a test text.',
	async run(uow, input) {
		const row = await tables(uow.db)
			.selectFrom('homeassistant_people')
			.select('notify_service')
			.where('member_id', '=', input.memberId)
			.executeTakeFirst();
		if (!row?.notify_service)
			throw new FamosError('bad_request', 'This member has no phone chosen yet');
		// The answer on the row is for this test: it reads as nothing until the job has one.
		await tables(uow.db)
			.updateTable('homeassistant_people')
			.set({ notify_status: null })
			.where('member_id', '=', input.memberId)
			.execute();
		uow.emit(peopleChanged, {});
		const bucket = Math.floor(uow.clock.now() / DOUBLE_TAP_MS);
		await uow.enqueue(
			'homeassistant.testNotify',
			{ memberId: input.memberId },
			{ dedupeKey: `homeassistant.testNotify:${input.memberId}:${bucket}` },
		);
		return { ok: true as const };
	},
});

/** How one call of a `notify` service went; a failure that may pass carries the error. */
type Outcome = 'sent' | 'missing' | 'refused' | { retry: unknown };

async function post(
	ctx: JobContext,
	connection: { base_url: string; updated_at: number },
	token: string,
	service: string,
	body: Record<string, unknown>,
): Promise<Outcome> {
	try {
		await ctx.http.post({
			url: `${connection.base_url}/api/services/notify/${service}`,
			json: body,
			allowLocal: true,
			headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
			timeoutMs: CALL_TIMEOUT_MS,
			maxBytes: CALL_MAX_BYTES,
		});
		ctx.logger.info({ status: 'ok' }, 'home assistant text');
		return 'sent';
	} catch (error) {
		const code = isExternalHttpError(error) ? error.code : 'failed';
		// Only the outcome: the text, the address and the service stay out of logs.
		ctx.logger.info({ status: code }, 'home assistant text');
		if (code === 'http_400') return 'missing';
		if (code === 'http_401' || code === 'http_403') {
			await recordTokenRefused(ctx, connection.updated_at);
			return 'refused';
		}
		return { retry: error };
	}
}

/** Sets the status of a row, only while it still names the service that was tried. */
async function remember(ctx: JobContext, memberId: string, service: string, status: NotifyStatus) {
	const done = await tables(ctx.db)
		.updateTable('homeassistant_people')
		.set({ notify_status: status })
		.where('member_id', '=', memberId)
		.where('notify_service', '=', service)
		.where((eb) => eb.or([eb('notify_status', 'is', null), eb('notify_status', '!=', status)]))
		.executeTakeFirst();
	if (Number(done.numUpdatedRows) > 0) await ctx.events.emit(peopleChanged, {});
}

export const testNotifyJob = defineJob({
	name: 'homeassistant.testNotify',
	payload: z.object({ memberId: MemberIdSchema }),
	timeoutMs: 2 * CALL_TIMEOUT_MS,
	// A person is waiting for the answer: one try, and the row says how it went.
	maxAttempts: 1,
	async handle(ctx, { memberId }) {
		const row = await rowOf(ctx, memberId);
		const connection = await load(ctx.db);
		const token = connection ? ctx.secrets.open(connection.sealed_token) : null;
		const service = row?.notify_service;
		if (!service || !connection || token === null) return;
		const member = (await ctx.family.members()).find((m) => m.id === memberId);
		const locale = member?.locale ?? (await ctx.family.settings()).locale;
		const result = await post(ctx, connection, token, service, {
			title: ctx.translate(locale, 'homeassistant:notify_test_title'),
			message: ctx.translate(locale, 'homeassistant:notify_test_body'),
			data: { tag: `homeassistant-test-${memberId}`, group: 'familyos' },
		});
		const status: NotifyStatus =
			result === 'sent'
				? 'ok'
				: result === 'missing' || result === 'refused'
					? result
					: 'unreachable';
		await remember(ctx, memberId, service, status);
	},
});

/** What a send carries to the Home Assistant app: a link only when the family has set its address. */
export function bodyOf(message: NotificationMessage) {
	return {
		title: message.title,
		message: message.body ?? message.title,
		data: {
			tag: message.tag,
			group: 'familyos',
			...(message.link && { url: message.link, clickAction: message.link }),
		},
	};
}

export const homeassistantChannel = defineNotificationChannel({
	id: 'homeassistant',
	label: 'homeassistant:channel_label',
	hint: 'homeassistant:channel_hint',
	byDefault: 'off',
	async isAvailableFor(ctx, memberId) {
		const connection = await load(ctx.db);
		if (!connection || connection.status === 'token_refused') return false;
		if (ctx.secrets.open(connection.sealed_token) === null) return false;
		return Boolean((await rowOf(ctx, memberId))?.notify_service);
	},
	async send(ctx, memberId, message) {
		const row = await rowOf(ctx, memberId);
		const connection = await load(ctx.db);
		const token = connection ? ctx.secrets.open(connection.sealed_token) : null;
		const service = row?.notify_service;
		if (!service || !connection || token === null) return 'gone';
		const result = await post(ctx, connection, token, service, bodyOf(message));
		if (result === 'sent') {
			await remember(ctx, memberId, service, 'ok');
			return 'sent';
		}
		if (result === 'missing') {
			await remember(ctx, memberId, service, 'missing');
			return 'gone';
		}
		if (result === 'refused') return 'gone';
		// No answer or a failure of Home Assistant's own: the queue tries again.
		throw result.retry;
	},
});
