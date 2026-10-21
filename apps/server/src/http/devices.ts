import { isLocalAddress } from '@famos/adapters/http-guard';
import {
	CORE_CAPABILITIES,
	DeviceSchema,
	type DeviceService,
	type Kernel,
	RotationSchema,
	STYLE_IDS,
	toDevice,
} from '@famos/core';
import { FamosError, personPresent, systemActor, type TrustedDevice } from '@famos/sdk';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { parse } from 'hono/utils/cookie';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';
import { addressKey, createRateLimiter } from './rate-limit.ts';

/**
 * Trusted family devices on the HTTP side. Core owns the device records; this module
 * owns the transport: an httpOnly cookie holding the device token.
 */
export const DEVICE_COOKIE = 'famos_device';
/** Browsers cap cookie lifetimes at ~400 days; the cookie is refreshed on every trusted request. */
const DEVICE_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export function deviceTokenFromHeaders(headers: Headers): string | undefined {
	const cookie = headers.get('cookie');
	return cookie ? parse(cookie, DEVICE_COOKIE)[DEVICE_COOKIE] : undefined;
}

export function deviceMiddleware(
	devices: DeviceService,
	secure: boolean,
): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const token = getCookie(c, DEVICE_COOKIE);
		const row = await devices.verify(token);
		// Only family devices count as trusted: a display (kind `kiosk`) never opens the profile
		// picker or PIN sign-in.
		c.set(
			'device',
			row?.kind === 'family' ? ({ id: row.id, name: row.name } satisfies TrustedDevice) : null,
		);
		await next();
		// Refresh the cookie, unless the handler just removed it (forgetting the device).
		const handled = c.res.headers.getSetCookie().some((h) => h.startsWith(`${DEVICE_COOKIE}=`));
		if (row && token && !handled) setDeviceCookie(c, token, secure);
	};
}

// biome-ignore lint/suspicious/noExplicitAny: works with any Hono context.
function setDeviceCookie(c: any, token: string, secure: boolean) {
	setCookie(c, DEVICE_COOKIE, token, {
		httpOnly: true,
		sameSite: 'Lax',
		secure,
		path: '/',
		maxAge: DEVICE_COOKIE_MAX_AGE,
	});
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });

export function mountDeviceRoutes(
	app: OpenAPIHono<AppEnv>,
	kernel: Kernel,
	secure: boolean,
	clientIp: (c: Context) => string,
	publicUrl?: string,
): void {
	const devices = kernel.devices;
	const trust = createRoute({
		method: 'post',
		path: '/api/v1/core/devices/trust',
		operationId: 'core.trustThisDevice',
		summary: 'Mark the calling device as a family device (profile picker and PIN sign-in)',
		tags: ['core'],
		request: {
			body: {
				content: {
					'application/json': { schema: z.object({ name: z.string().trim().min(1).max(60) }) },
				},
				required: true,
			},
		},
		responses: {
			201: { description: 'Device trusted; cookie set', ...json(DeviceSchema) },
			...errorResponses,
		},
		security: [{ session: [] }],
	});
	app.openapi(trust, async (c) => {
		const actor = c.get('actor');
		if (!actor || !personPresent(actor))
			throw new FamosError('unauthenticated', 'Sign in required');
		// This browser is a paired display: replacing its cookie would silently unpair it.
		const current = await devices.verify(getCookie(c, DEVICE_COOKIE));
		if (current?.kind === 'kiosk')
			throw new FamosError('conflict', 'This browser is a paired display');
		const { device, token } = await devices.trust(actor, { name: c.req.valid('json').name });
		setDeviceCookie(c, token, secure);
		await kernel.audit.record(actor, 'core.trustThisDevice', device.id);
		return c.json(toDevice(device), 201);
	});

	const forget = createRoute({
		method: 'post',
		path: '/api/v1/core/devices/forget',
		operationId: 'core.forgetThisDevice',
		summary:
			'Stop using the calling device as a family device: revoke it and remove its cookie (PIN sessions on it end)',
		tags: ['core'],
		responses: {
			200: {
				description: 'Device revoked and cookie removed',
				...json(z.object({ ok: z.literal(true) })),
			},
		},
	});
	app.openapi(forget, async (c) => {
		// Revoke on the server too, or the device would stay listed and PIN sessions on it would live on.
		const forgotten = await devices.forget(getCookie(c, DEVICE_COOKIE));
		deleteCookie(c, DEVICE_COOKIE, { path: '/' });
		// Whoever holds the device's cookie may forget it, signed in or not.
		if (forgotten)
			await kernel.audit.record(
				c.get('actor') ?? systemActor('device'),
				'core.forgetThisDevice',
				forgotten,
			);
		return c.json({ ok: true as const }, 200);
	});

	mountDisplayRoutes(app, kernel, secure, clientIp, publicUrl);
}

const PairStartSchema = z.object({
	deviceCode: z.string(),
	userCode: z.string(),
	expiresAt: z.number(),
	/** Seconds between polls. */
	interval: z.number(),
});

const PollSchema = z.discriminatedUnion('status', [
	z.object({ status: z.enum(['pending', 'slow_down', 'expired']) }),
	z.object({ status: z.literal('paired'), device: z.object({ id: z.string(), name: z.string() }) }),
]);

const PairingStatusSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('waiting'), answering: z.boolean() }),
	z.object({ status: z.literal('connected'), deviceId: z.string() }),
	z.object({ status: z.literal('expired') }),
]);

/**
 * Pairing family displays. A display's cookie is its credential, so pairing lives outside the
 * action runner like device trust; confirming a code, renaming a display and changing what it
 * may show are actions (`core.confirmDisplayPairing`, `core.updateDisplay`).
 */
/**
 * A browser the family uses cannot also be a display (409): a member's session outranks the display
 * cookie, and pairing would replace a trusted family device's cookie, untrusting it silently.
 */
function refuseFamilyBrowser(c: Context<AppEnv>) {
	const actor = c.get('actor');
	if ((actor && personPresent(actor)) || c.get('device'))
		throw new FamosError('conflict', 'This browser is used by the family');
}

function mountDisplayRoutes(
	app: OpenAPIHono<AppEnv>,
	kernel: Kernel,
	secure: boolean,
	clientIp: (c: Context) => string,
	publicUrl?: string,
) {
	const devices = kernel.devices;
	// Starting a pairing is public: cap it per address so nobody can fill the table with codes.
	// Five starts in ten minutes is enough for a household's displays; the codes one address may
	// hold open at once are capped in the kernel, so no address can take every slot.
	const startLimit = createRateLimiter({ max: 5, windowMs: 10 * 60 * 1000 });

	const start = createRoute({
		method: 'post',
		path: '/api/v1/core/displays/pair',
		operationId: 'core.startDisplayPairing',
		summary: 'A display asks for a pairing code',
		tags: ['core'],
		responses: {
			201: { description: 'Codes for the display to show and poll with', ...json(PairStartSchema) },
			...errorResponses,
		},
	});
	app.openapi(start, async (c) => {
		refuseFamilyBrowser(c);
		const ip = clientIp(c);
		if (!startLimit.hit(ip)) throw new FamosError('limit_reached', 'Too many pairing attempts');
		// The home network has slots of its own, so a flood from the internet cannot stop the family
		// pairing a display at home.
		return c.json(
			await devices.startPairing({ ip: addressKey(ip), local: isLocalAddress(ip) }),
			201,
		);
	});

	const poll = createRoute({
		method: 'post',
		path: '/api/v1/core/displays/pair/poll',
		operationId: 'core.pollDisplayPairing',
		summary: 'A display asks whether it was confirmed (the device cookie is set once)',
		tags: ['core'],
		request: {
			body: {
				content: {
					'application/json': { schema: z.object({ deviceCode: z.string().min(1).max(200) }) },
				},
				required: true,
			},
		},
		responses: {
			200: { description: 'Pairing state', ...json(PollSchema) },
			...errorResponses,
		},
	});
	app.openapi(poll, async (c) => {
		const result = await devices.pollPairing(c.req.valid('json').deviceCode);
		if (result.status !== 'paired') return c.json({ status: result.status }, 200);
		setDeviceCookie(c, result.token, secure);
		// The display's key is made now, by nobody signed in: the admin who confirmed the code is
		// on the device record and in the audit row of the confirmation.
		await kernel.audit.record(systemActor('pairing'), 'core.pollDisplayPairing', result.device.id);
		return c.json(
			{ status: 'paired' as const, device: { id: result.device.id, name: result.device.name } },
			200,
		);
	});

	const pairing = createRoute({
		method: 'get',
		path: '/api/v1/core/displays/pairings/{pairingId}',
		operationId: 'core.getDisplayPairing',
		summary: 'Whether the display of a confirmed code has claimed it yet',
		tags: ['core'],
		request: { params: z.object({ pairingId: z.string().max(80) }) },
		responses: {
			200: { description: 'The pairing, seen from the admin', ...json(PairingStatusSchema) },
			...errorResponses,
		},
		security: [{ session: [] }],
	});
	app.openapi(pairing, async (c) => {
		const actor = c.get('actor');
		if (!actor || !personPresent(actor))
			throw new FamosError('unauthenticated', 'Sign in required');
		return c.json(await devices.pairingStatus(actor, c.req.valid('param').pairingId), 200);
	});

	const address = createRoute({
		method: 'get',
		path: '/api/v1/core/devices/address',
		operationId: 'core.getFamilyAddress',
		summary: 'The address the family reaches FamilyOS at, when the admin has set one',
		tags: ['core'],
		responses: {
			200: {
				description: 'The configured address, or null',
				...json(z.object({ url: z.string().nullable() })),
			},
			...errorResponses,
		},
		security: [{ session: [] }],
	});
	app.openapi(address, async (c) => {
		const actor = c.get('actor');
		if (!actor || !personPresent(actor))
			throw new FamosError('unauthenticated', 'Sign in required');
		if (!kernel.access.can(actor, CORE_CAPABILITIES.devicesManage.id))
			throw new FamosError('forbidden', 'Your role does not allow this', {
				reason: 'capability',
				capability: CORE_CAPABILITIES.devicesManage.id,
			});
		return c.json({ url: publicUrl ?? null }, 200);
	});

	const grantable = createRoute({
		method: 'get',
		path: '/api/v1/core/displays/capabilities',
		operationId: 'core.listDisplayCapabilities',
		summary: 'What a display can be allowed to show',
		tags: ['core'],
		responses: {
			200: {
				description: 'View capabilities of the extensions that are on',
				...json(z.array(z.object({ id: z.string(), label: z.string(), owner: z.string() }))),
			},
			...errorResponses,
		},
		security: [{ session: [] }],
	});
	app.openapi(grantable, async (c) => {
		const actor = c.get('actor');
		if (!actor || !personPresent(actor))
			throw new FamosError('unauthenticated', 'Sign in required');
		if (!kernel.access.can(actor, CORE_CAPABILITIES.devicesManage.id))
			throw new FamosError('forbidden', 'Your role does not allow this', {
				reason: 'capability',
				capability: CORE_CAPABILITIES.devicesManage.id,
			});
		return c.json(
			devices.grantableCapabilities().map((cap) => ({
				id: cap.id,
				label: cap.label,
				owner: cap.id.split('.')[0] as string,
			})),
			200,
		);
	});

	const me = createRoute({
		method: 'get',
		path: '/api/v1/core/displays/me',
		operationId: 'core.getThisDisplay',
		summary: 'The display this request comes from, and what it may show',
		tags: ['core'],
		responses: {
			200: {
				description: 'The paired display',
				...json(
					z.object({
						name: z.string(),
						/** What the family is called, when it chose a name. */
						familyName: z.string().nullable(),
						capabilities: z.array(z.string()),
						showNames: z.boolean(),
						timeZone: z.string(),
						locale: z.string(),
						formatLocale: z.string(),
						weekStart: z.number().int().min(1).max(7),
						hourCycle: z.enum(['h12', 'h23']),
						temperatureUnit: z.enum(['celsius', 'fahrenheit']),
						/** Extensions turned off in Settings → Features; their widgets are hidden. */
						disabledExtensions: z.array(z.string()),
						/** The theme chosen for this display, else the family's. */
						theme: z.string().nullable(),
						/** The style chosen for this display, else the family's. */
						style: z.enum(STYLE_IDS),
						/** The blocks this display's Today hides: its own choice, else the family's. */
						hidden: z.array(z.string()),
						/** The pages this display shows between Today's turns; null shows only Today. */
						rotation: RotationSchema.nullable(),
					}),
				),
			},
			...errorResponses,
		},
	});
	app.openapi(me, async (c) => {
		const actor = c.get('actor');
		refuseFamilyBrowser(c);
		if (actor?.kind !== 'display')
			throw new FamosError('unauthenticated', 'This is not a paired display');
		const row = await devices.verify(getCookie(c, DEVICE_COOKIE));
		if (!row) throw new FamosError('unauthenticated', 'This is not a paired display');
		const family = await kernel.ctx.family.settings();
		const look = await kernel.themes.effective(kernel.ctx.db, actor);
		const held = [
			...actor.capabilities,
			...(actor.showNames ? [CORE_CAPABILITIES.membersView.id] : []),
		];
		return c.json(
			{
				name: row.name,
				familyName: family.name ?? null,
				// Only what works right now (an extension turned off drops out).
				capabilities: held.filter(
					(id) => kernel.access.capability(id) && kernel.access.can(actor, id),
				),
				showNames: actor.showNames,
				timeZone: family.timeZone,
				locale: family.locale,
				formatLocale: family.formatLocale,
				weekStart: family.weekStart,
				hourCycle: family.hourCycle,
				temperatureUnit: family.temperatureUnit,
				disabledExtensions: [...kernel.features.disabled()],
				theme: look.theme,
				style: look.style,
				hidden: look.hidden,
				rotation: await kernel.themes.rotationOf(kernel.ctx.db, actor.deviceId),
			},
			200,
		);
	});

	// What the display's screen had no room for. Not a change of the family's data (it is the
	// screen describing itself, kept in memory like `last_seen_at`). A read, like the display's
	// other requests: a display only ever reads, and that stays checkable from outside.
	const fit = createRoute({
		method: 'get',
		path: '/api/v1/core/displays/me/fit',
		operationId: 'core.reportDisplayFit',
		summary: 'The display tells what its screen had no room for',
		tags: ['core'],
		request: {
			// Comma-separated widget and block ids; empty when everything fitted.
			query: z.object({ leftOut: z.string().max(4000).default('') }),
		},
		responses: {
			204: { description: 'Noted' },
			...errorResponses,
		},
	});
	app.openapi(fit, async (c) => {
		const actor = c.get('actor');
		refuseFamilyBrowser(c);
		if (actor?.kind !== 'display')
			throw new FamosError('unauthenticated', 'This is not a paired display');
		const leftOut = c.req
			.valid('query')
			.leftOut.split(',')
			.map((id) => id.trim())
			.filter((id) => id.length > 0 && id.length <= 100)
			.slice(0, 40);
		await devices.reportFit(actor.deviceId, leftOut);
		return c.body(null, 204);
	});
}
