import type { BackupService } from '@famos/adapters/backup';
import type { Email } from '@famos/adapters/email';
import {
	CLIENT_IP_HEADER,
	type Identity,
	KNOWN_DEVICE_HEADER,
	signInTarget,
} from '@famos/adapters/identity-betterauth';
import type { AiSettingsService } from '@famos/adapters/llm-aisdk';
import type { Telegram } from '@famos/adapters/telegram';
import type { WebPush } from '@famos/adapters/webpush';
import { ANONYMOUS, DecisionSchema, IDEMPOTENCY_KEY, type Kernel, sessionEnded } from '@famos/core';
import {
	type AccessControl,
	type Actor,
	type AnyActionDefinition,
	type AnyRouteDefinition,
	FamosError,
	type FileResponse,
	FileResponseSchema,
	type Logger,
	personPresent,
	principalOf,
	type RouteAccess,
	selfOf,
	type TextResponse,
	TextResponseSchema,
	type UploadSpec,
} from '@famos/sdk';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import { describeLoaded, type LoadedWeb, type WebPackage } from '../extensions/web.ts';
import { mountMcp } from '../mcp/http.ts';
import { mountAiRoutes } from './ai.ts';
import { mountApiTokenRoutes } from './api-tokens.ts';
import { mountAppRoutes } from './apps.ts';
import { authenticate } from './authenticate.ts';
import { mountBackupRoutes } from './backups.ts';
import { createClientIp } from './client-ip.ts';
import { deviceMiddleware, deviceTokenFromHeaders, mountDeviceRoutes } from './devices.ts';
import { mountEmailRoutes } from './email.ts';
import type { AppEnv } from './env.ts';
import { errorBody, errorResponses, handleError } from './errors.ts';
import { mountExtensionRoutes } from './extensions.ts';
import type { KnownDevices } from './known-devices.ts';
import { mountOAuthRoutes } from './oauth.ts';
import { mountOAuthEndpoints } from './oauth-endpoints.ts';
import { MAX_BAD_KEYS_PER_MINUTE, mountPublicApi } from './public/index.ts';
import { mountPushRoutes } from './push.ts';
import { createRateLimiter } from './rate-limit.ts';
import { mountSetupChecksRoute } from './setup-checks.ts';
import { mountTelegramRoutes } from './telegram.ts';
import {
	bodyLimits,
	LANGUAGE_PACK_BODY_LIMIT,
	readUpload,
	THEME_PACK_BODY_LIMIT,
} from './uploads.ts';

export type { AppEnv } from './env.ts';

export interface HttpAppDeps {
	kernel: Kernel;
	ai: AiSettingsService;
	webPush: WebPush;
	telegram: Telegram;
	email: Email;
	/** Remote backups, and where local ones live. */
	backups: BackupService;
	backupsDir: string;
	backupSchedule: { hour: number; keep: number };
	/** What the server's key file holds, for the admin who saves it. Left out where there is no server. */
	keyFile?: string;
	identity: Pick<Identity, 'handler' | 'resolveMember' | 'admin' | 'confirmPassword'>;
	/** Browsers that signed in to an account before, which the account-wide sign-in lock lets through. */
	knownDevices: KnownDevices;
	logger: Logger;
	trustedOrigins: string[];
	/** The address the admin configured for the family (`FAMOS_BASE_URL`), when there is one. */
	publicUrl?: string;
	appVersion: string;
	/** Whether cookies get the Secure flag (true when served over HTTPS). */
	secureCookies: boolean;
	/** Proxies (IPs or CIDRs) whose `X-Forwarded-For` is believed (`FAMOS_TRUSTED_PROXIES`). */
	trustedProxies?: readonly string[];
	/** The running extensions and their web packages; by default the kernel's, without packages. */
	extensions?: LoadedWeb;
	/** Names this start of the process: an app waiting for a restart sees it change. */
	boot?: string;
}

/** The kernel's extensions (core is the host's, not one of them) and their web packages. */
export function loadedWeb(kernel: Kernel, packages: readonly WebPackage[] = []): LoadedWeb {
	return describeLoaded(
		kernel.registry.extensions
			.filter((ext) => ext.id !== 'core')
			.map((ext) => ({ id: ext.id, version: ext.manifest.version })),
		packages,
	);
}

export const OPENAPI_INFO = {
	openapi: '3.1.0',
	info: {
		title: 'FamilyOS API',
		version: 'v1',
		description: 'Generated from route and action definitions. Do not edit.',
	},
};

/** The identity routes that end a session or replace a credential. */
const SESSION_ENDING_PATH =
	/\/(sign-out|revoke-session|revoke-sessions|revoke-other-sessions|change-password|reset-password|set-password)$/;

function actorMiddleware(deps: HttpAppDeps): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		c.set('actor', await authenticate(deps, c.req.raw.headers, 'session'));
		await next();
	};
}

/** The callers a sign-in-only route admits. */
const SIGNED_IN_KINDS: readonly Actor['kind'][] = ['member'];

/** Resolves who calls a route and checks its access. */
function requireActor(c: Context<AppEnv>, access: AccessControl, requires: RouteAccess): Actor {
	const actor = c.get('actor');
	// Unauthenticated callers of public routes: a system actor that holds no capability.
	const anonymous: Actor = { kind: 'system', source: ANONYMOUS };
	// A display is not a person: public and device-trust routes see it as nobody.
	if (requires === 'public') return actor && personPresent(actor) ? actor : anonymous;
	if (requires === 'trusted-device') {
		if (actor && personPresent(actor)) return actor;
		if (c.get('device')) return anonymous;
		throw new FamosError('unauthenticated', 'Sign in, or use a family device');
	}
	if (!actor) throw new FamosError('unauthenticated', 'Sign in required');
	// A route that needs only a sign-in is for a person; a display reaches only capability routes,
	// and only for the view capabilities it holds. Every kind is named, so one added later is
	// refused here until it is decided.
	if (requires === 'signedIn' && !SIGNED_IN_KINDS.includes(actor.kind))
		throw new FamosError('unauthenticated', 'Sign in required');
	if (requires !== 'signedIn' && !access.can(actor, requires))
		throw new FamosError('forbidden', 'Your role does not allow this', {
			reason: actor.kind === 'display' ? 'display' : 'capability',
			capability: requires,
		});
	return actor;
}

/** Routes of a turned-off extension answer `feature_off` (Settings → Features). */
function assertOn(kernel: Kernel, extension: string) {
	if (!kernel.features.isOn(extension))
		throw new FamosError('feature_off', `${extension} is turned off`);
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });

function mountRoute(
	app: OpenAPIHono<AppEnv>,
	deps: HttpAppDeps,
	extension: string,
	def: AnyRouteDefinition,
) {
	const status = def.status ?? (def.method === 'post' ? 201 : 200);
	const path = `/api/v1/${extension}${def.path}`;
	if (def.upload) {
		mountUploadRoute(
			app,
			deps,
			extension,
			def as AnyRouteDefinition & { upload: UploadSpec },
			path,
			status,
		);
		return;
	}
	if (def.response === FileResponseSchema) {
		mountFileRoute(app, deps, extension, def, path);
		return;
	}
	if (def.response === TextResponseSchema) {
		mountTextRoute(app, deps, extension, def, path);
		return;
	}
	const route = createRoute({
		method: def.method,
		path,
		operationId: def.operationId,
		summary: def.summary,
		tags: [extension],
		request: {
			...(def.params && { params: def.params }),
			...(def.query && { query: def.query }),
			...(def.body && { body: { ...json(def.body), required: true } }),
		},
		responses: { [status]: { description: def.summary, ...json(def.response) }, ...errorResponses },
		...(def.requires !== 'public' && { security: [{ session: [] }] }),
	});
	// The definitions are heterogeneous at this boundary; validation already happened via the route schemas.
	// biome-ignore lint/suspicious/noExplicitAny: generic adapter over user-defined route types.
	app.openapi(route, (async (c: any) => {
		assertOn(deps.kernel, extension);
		const actor = requireActor(c, deps.kernel.access, def.requires);
		const result = await def.handle(deps.kernel.contextFor(extension), {
			params: def.params ? c.req.valid('param') : undefined,
			query: def.query ? c.req.valid('query') : undefined,
			body: def.body ? c.req.valid('json') : undefined,
			actor,
			device: c.get('device'),
			files: [],
		});
		return c.json(result, status);
	}) as never);
}

/** Types a browser may render from the app's origin; anything else is sent as a download. */
const INLINE_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif',
	'application/pdf',
	// A font only draws glyphs; the theme stylesheet names it from the app's own origin.
	'font/woff2',
	// Audio only plays; it cannot run script or render markup.
	'audio/ogg',
	'audio/opus',
	'audio/mpeg',
	'audio/mp3',
	'audio/mp4',
	'audio/m4a',
	'audio/x-m4a',
	'audio/aac',
	'audio/wav',
	'audio/x-wav',
	'audio/wave',
	'audio/webm',
	'audio/flac',
]);

/** File responses (FileResponseSchema): streamed, sandboxed, never rendered as HTML or SVG. */
function mountFileRoute(
	app: OpenAPIHono<AppEnv>,
	deps: HttpAppDeps,
	extension: string,
	def: AnyRouteDefinition,
	path: string,
) {
	app.openAPIRegistry.registerPath({
		method: def.method,
		path,
		operationId: def.operationId,
		summary: def.summary,
		tags: [extension],
		request: { ...(def.params && { params: def.params }) },
		responses: {
			200: {
				description: def.summary,
				content: {
					'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) },
				},
			},
			...errorResponses,
		},
		...(def.requires !== 'public' && { security: [{ session: [] }] }),
	});
	const honoPath = path.replace(/\{([^}]+)\}/g, ':$1');
	app.on(def.method.toUpperCase(), honoPath, async (c) => {
		assertOn(deps.kernel, extension);
		const actor = requireActor(c, deps.kernel.access, def.requires);
		const params = def.params ? def.params.safeParse(c.req.param()) : undefined;
		if (params && !params.success) {
			return c.json(errorBody('bad_request', 'Invalid request', z.treeifyError(params.error)), 400);
		}
		const file = (await def.handle(deps.kernel.contextFor(extension), {
			params: params?.data,
			query: undefined,
			body: undefined,
			actor,
			device: c.get('device'),
			files: [],
		})) as FileResponse;
		const inline = INLINE_TYPES.has(file.contentType.split(';')[0]?.trim().toLowerCase() ?? '');
		const name = encodeURIComponent(file.filename);
		if (file.cacheControl) c.set('ownCaching', true);
		return new Response(ReadableStream.from(file.stream), {
			headers: {
				'content-type': inline ? file.contentType : 'application/octet-stream',
				'content-length': String(file.size),
				'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
				'content-security-policy':
					"sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
				'x-content-type-options': 'nosniff',
				'cache-control': file.cacheControl ?? 'private, no-store',
			},
		});
	});
}

/** Text responses (TextResponseSchema): only calendars and plain text keep their type. */
function mountTextRoute(
	app: OpenAPIHono<AppEnv>,
	deps: HttpAppDeps,
	extension: string,
	def: AnyRouteDefinition,
	path: string,
) {
	app.openAPIRegistry.registerPath({
		method: def.method,
		path,
		operationId: def.operationId,
		summary: def.summary,
		tags: [extension],
		request: { ...(def.params && { params: def.params }) },
		responses: {
			200: {
				description: def.summary,
				content: {
					'text/calendar': { schema: z.string() },
					'text/css': { schema: z.string() },
					'application/json': { schema: z.string() },
				},
			},
			...errorResponses,
		},
		...(def.requires !== 'public' && { security: [{ session: [] }] }),
	});
	const honoPath = path.replace(/\{([^}]+)\}/g, ':$1');
	app.on(def.method.toUpperCase(), honoPath, async (c) => {
		assertOn(deps.kernel, extension);
		const actor = requireActor(c, deps.kernel.access, def.requires);
		const params = def.params ? def.params.safeParse(c.req.param()) : undefined;
		if (params && !params.success) {
			return c.json(errorBody('bad_request', 'Invalid request', z.treeifyError(params.error)), 400);
		}
		const result = (await def.handle(deps.kernel.contextFor(extension), {
			params: params?.data,
			query: undefined,
			body: undefined,
			actor,
			device: c.get('device'),
			files: [],
		})) as TextResponse;
		const type = result.contentType.split(';')[0]?.trim().toLowerCase();
		c.set('ownCaching', true);
		const headers: Record<string, string> = {
			'content-type':
				type === 'text/calendar'
					? 'text/calendar; charset=utf-8'
					: type === 'text/css'
						? 'text/css; charset=utf-8'
						: type === 'application/json'
							? 'application/json; charset=utf-8'
							: 'text/plain; charset=utf-8',
			'content-security-policy': "sandbox; default-src 'none'",
			'x-content-type-options': 'nosniff',
			'cache-control': result.cacheControl ?? 'private, no-store',
			...(result.etag && { etag: result.etag }),
		};
		if (result.etag && c.req.header('if-none-match') === result.etag) {
			return new Response(null, { status: 304, headers });
		}
		return new Response(result.text, { headers });
	});
}

/**
 * Upload routes are documented in OpenAPI but parsed by hand: zod-openapi would validate the
 * multipart body against a JSON-style schema and reject the files.
 */
function mountUploadRoute(
	app: OpenAPIHono<AppEnv>,
	deps: HttpAppDeps,
	extension: string,
	def: AnyRouteDefinition & { upload: UploadSpec },
	path: string,
	status: number,
) {
	const fieldsShape = def.body instanceof z.ZodObject ? def.body.shape : {};
	const formSchema = z.object({
		...fieldsShape,
		files: z.array(z.string().openapi({ format: 'binary' })).optional(),
	});
	app.openAPIRegistry.registerPath({
		method: def.method,
		path,
		operationId: def.operationId,
		summary: def.summary,
		tags: [extension],
		request: {
			...(def.params && { params: def.params }),
			body: { content: { 'multipart/form-data': { schema: formSchema } }, required: true },
		},
		responses: { [status]: { description: def.summary, ...json(def.response) }, ...errorResponses },
		...(def.requires !== 'public' && { security: [{ session: [] }] }),
	});
	const honoPath = path.replace(/\{([^}]+)\}/g, ':$1');
	app.on(def.method.toUpperCase(), honoPath, async (c) => {
		assertOn(deps.kernel, extension);
		const actor = requireActor(c, deps.kernel.access, def.requires);
		const params = def.params ? def.params.safeParse(c.req.param()) : undefined;
		if (params && !params.success) {
			return c.json(errorBody('bad_request', 'Invalid request', z.treeifyError(params.error)), 400);
		}
		const { body, files } = await readUpload(c, def);
		const result = await def.handle(deps.kernel.contextFor(extension), {
			params: params?.data,
			query: undefined,
			body,
			actor,
			device: c.get('device'),
			files,
		});
		return c.json(result, status as 200);
	});
}

const ActionResultSchema = (output: z.ZodType) =>
	z.discriminatedUnion('status', [
		z.object({ status: z.literal('applied'), output }),
		z.object({ status: z.literal('drafted'), draftId: z.string() }),
	]);

function mountAction(app: OpenAPIHono<AppEnv>, deps: HttpAppDeps, def: AnyActionDefinition) {
	const route = createRoute({
		method: 'post',
		path: `/api/v1/actions/${def.id}`,
		operationId: def.id,
		summary: def.title,
		...(def.description && { description: def.description }),
		tags: ['actions', def.id.split('.')[0] ?? 'actions'],
		request: {
			body: { ...json(def.input), required: true },
			headers: z.object({
				'idempotency-key': z.string().regex(IDEMPOTENCY_KEY).optional().openapi({
					description:
						'Makes the call safe to repeat (1-100 characters: letters, digits, `_`, `-`). The same key for the same action returns the first result without running it again (response header `Idempotent-Replayed: true`); for another action it is refused with 422. Keys are kept 7 days.',
				}),
			}),
		},
		responses: {
			200: {
				description: 'Applied, or stored as a draft for approval',
				...json(ActionResultSchema(def.output)),
			},
			...errorResponses,
		},
		security: [{ session: [] }],
	});
	// biome-ignore lint/suspicious/noExplicitAny: generic adapter over user-defined action types.
	app.openapi(route, (async (c: any) => {
		// Sign-in here; the action runner checks `requires` and approval.
		const actor = requireActor(c, deps.kernel.access, 'signedIn');
		const key: string | undefined = c.req.valid('header')['idempotency-key'];
		let replayed = false;
		const result = await deps.kernel.runner.invoke(def.id, c.req.valid('json'), actor, {
			...(key && {
				idempotencyKey: key,
				onReplay: () => {
					replayed = true;
				},
			}),
		});
		if (replayed) c.header('idempotent-replayed', 'true');
		return c.json(result, 200);
	}) as never);
}

/**
 * A form asks this while it is open (when a field that decides it changes), so it is cheap and
 * frequent; the limit only keeps a runaway page from turning it into a stream of queries.
 */
const CHECKS_PER_MINUTE = 240;

/** What running an action with an input would do for the caller, without running it. */
function mountActionCheck(app: OpenAPIHono<AppEnv>, deps: HttpAppDeps) {
	const limit = createRateLimiter({ max: CHECKS_PER_MINUTE, windowMs: 60_000 });
	const route = createRoute({
		method: 'post',
		path: '/api/v1/actions/{actionId}/check',
		operationId: 'core.checkAction',
		summary: 'What running an action with this input would do for you: apply, suggest or refuse',
		description:
			'Decided exactly as running it would be (its capability, its approval rule, whose thing it is), but nothing runs and nothing is recorded.',
		tags: ['actions', 'core'],
		request: {
			params: z.object({ actionId: z.string().min(1).max(200) }),
			body: { ...json(z.object({ input: z.unknown() })), required: true },
		},
		responses: {
			200: { description: 'The decision for this input', ...json(DecisionSchema) },
			...errorResponses,
		},
		security: [{ session: [] }],
	});
	// biome-ignore lint/suspicious/noExplicitAny: the body's input is checked by the action's own schema.
	app.openapi(route, (async (c: any) => {
		const actor = requireActor(c, deps.kernel.access, 'signedIn');
		const who = principalOf(actor);
		if (!limit.hit(who)) throw new FamosError('limit_reached', 'Too many checks; try again soon');
		const { actionId } = c.req.valid('param');
		const { input } = c.req.valid('json');
		return c.json(await deps.kernel.runner.check(actionId, input, actor), 200);
	}) as never);
}

/**
 * A device the family already knows for this account: a family device, or a browser that signed in
 * to it with the password before. Displays are not family devices and never sign in.
 */
async function knownDevice(deps: HttpAppDeps, headers: Headers, email: string): Promise<boolean> {
	if (deps.knownDevices.knows(headers.get('cookie'), email)) return true;
	const device = await deps.kernel.devices.verify(deviceTokenFromHeaders(headers));
	return device?.kind === 'family';
}

export function createHttpApp(deps: HttpAppDeps): OpenAPIHono<AppEnv> {
	const app = new OpenAPIHono<AppEnv>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					errorBody('bad_request', 'Invalid request', z.treeifyError(result.error)),
					400,
				);
			}
		},
	});

	app.onError((error, c) => handleError(error, c, deps.logger));
	app.use('*', secureHeaders({ crossOriginEmbedderPolicy: false }));
	app.get('/health', (c) =>
		c.json({ status: 'ok', version: deps.appVersion, ...(deps.boot && { boot: deps.boot }) }),
	);

	// Sign-in bodies are tiny; refuse large ones before better-auth parses them.
	app.use('/api/auth/*', bodyLimit({ maxSize: 16 * 1024 }));
	const clientIp = createClientIp(deps.trustedProxies ?? []);
	app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
		// better-auth rate-limits by this header only; set it from the socket, never from the client.
		const headers = new Headers(c.req.raw.headers);
		headers.set(CLIENT_IP_HEADER, clientIp(c));
		// Whether the device is known is decided here, from the family device and sign-in cookies,
		// never taken from the client.
		headers.delete(KNOWN_DEVICE_HEADER);
		const target = await signInTarget(c.req.raw);
		const email = target?.kind === 'email' ? target.id : null;
		if (email && (await knownDevice(deps, headers, email))) headers.set(KNOWN_DEVICE_HEADER, '1');
		// Signing out (or ending sessions, or changing the password) must close the member's open
		// realtime sockets too: they were opened with the session that is going away.
		const endsSession = SESSION_ENDING_PATH.test(new URL(c.req.url).pathname);
		const before = endsSession ? await authenticate(deps, c.req.raw.headers, 'session') : null;
		const response = await deps.identity.handler(new Request(c.req.raw, { headers }));
		const self = before ? selfOf(before) : null;
		if (self !== null && response.ok) await deps.kernel.bus.emit(sessionEnded, { memberId: self });
		if (!email || !response.ok) return response;
		// A right password makes this browser known for the account from now on.
		const remembered = new Response(response.body, response);
		remembered.headers.append(
			'set-cookie',
			deps.knownDevices.remember(headers.get('cookie'), email, deps.secureCookies),
		);
		return remembered;
	});

	// API responses contain family data: never cache them (browser, proxies, service worker).
	app.use('/api/*', async (c, next) => {
		await next();
		// Only a text route (an ICS feed polled by phones) or a file route that asks for it may choose its own caching.
		if (!c.get('ownCaching')) c.header('cache-control', 'no-store');
	});
	app.use('/api/v1/*', csrf({ origin: deps.trustedOrigins }));
	const uploads = deps.kernel.registry.routes
		.filter(({ route }) => route.upload)
		.map(({ extension, route }) => ({
			method: route.method,
			path: `/api/v1/${extension}${route.path}`,
			maxBytes: route.upload?.maxBytes ?? 0,
		}));
	// A language pack is JSON of up to 2 MB, above the default body limit.
	app.use(
		'/api/v1/*',
		bodyLimits([
			...uploads,
			{
				method: 'post',
				path: '/api/v1/actions/core.installLanguagePack',
				maxBytes: LANGUAGE_PACK_BODY_LIMIT,
			},
			// A theme pack is JSON with base64 fonts of up to 2 MB.
			{
				method: 'post',
				path: '/api/v1/actions/core.installThemePack',
				maxBytes: THEME_PACK_BODY_LIMIT,
			},
		]),
	);
	app.use('/api/v1/*', actorMiddleware(deps));
	app.use('/api/v1/*', deviceMiddleware(deps.kernel.devices, deps.secureCookies));

	mountExtensionRoutes(app, deps.extensions ?? loadedWeb(deps.kernel));
	mountDeviceRoutes(app, deps.kernel, deps.secureCookies, clientIp, deps.publicUrl);
	mountAiRoutes(app, deps.ai, deps.kernel);
	mountPushRoutes(app, deps.webPush, deps.kernel);
	mountSetupChecksRoute(app, {
		kernel: deps.kernel,
		ai: deps.ai,
		backups: deps.backups,
		identity: deps.identity.admin,
		publicUrl: deps.publicUrl,
	});
	mountApiTokenRoutes(app, deps.kernel);
	mountOAuthRoutes(app, deps.kernel);
	mountAppRoutes(app, deps.kernel);
	// MCP answers carry family data for a token: never cache them.
	app.use('/mcp/*', async (c, next) => {
		await next();
		c.header('cache-control', 'no-store');
	});
	// Wrong keys are counted per client address across both bearer doors, so a guesser gets no
	// second budget by trying the other one.
	const badTokens = createRateLimiter({ max: MAX_BAD_KEYS_PER_MINUTE, windowMs: 60_000 });
	mountMcp(app, {
		kernel: deps.kernel,
		ai: deps.ai,
		appVersion: deps.appVersion,
		logger: deps.logger,
		clientIp,
		badTokens,
	});
	// Signing in AI apps: no cookie, no CSRF check; the apps prove themselves with their own
	// secrets, and a wrong one counts against the same budget as a wrong token at `/mcp`.
	mountOAuthEndpoints(app, { kernel: deps.kernel, clientIp, badTokens });
	// Connected apps: a bearer key and nothing else, so no cookie, session or CSRF check applies.
	mountPublicApi(app, {
		kernel: deps.kernel,
		logger: deps.logger,
		appVersion: deps.appVersion,
		clientIp,
		badTokens,
	});
	mountTelegramRoutes(app, deps.telegram, deps.kernel.access, deps.kernel.audit);
	mountEmailRoutes(app, deps.email, deps.kernel);
	mountBackupRoutes(app, {
		backups: deps.backups,
		kernel: deps.kernel,
		dir: deps.backupsDir,
		schedule: deps.backupSchedule,
		identity: deps.identity,
		clientIp,
		...(deps.keyFile !== undefined && { keyFile: deps.keyFile }),
	});
	for (const { extension, route } of deps.kernel.registry.routes)
		mountRoute(app, deps, extension, route);
	mountActionCheck(app, deps);
	// An internal action has no route: a job or the AI runs it through the runner.
	for (const action of deps.kernel.registry.actions.values())
		if (action.expose !== 'internal') mountAction(app, deps, action);

	app.openAPIRegistry.registerComponent('securitySchemes', 'session', {
		type: 'apiKey',
		in: 'cookie',
		name: 'better-auth.session_token',
	});
	// The document lists the installed extensions and every route, so only a signed-in member
	// may read it. It is built on the first request, when every route is registered.
	let openApiDocument: ReturnType<typeof app.getOpenAPI31Document> | undefined;
	app.use('/api/openapi.json', actorMiddleware(deps));
	app.get('/api/openapi.json', (c) => {
		const actor = c.get('actor');
		if (!actor || !personPresent(actor))
			return c.json(errorBody('unauthenticated', 'Sign in first'), 401);
		openApiDocument ??= app.getOpenAPI31Document(OPENAPI_INFO);
		return c.json(openApiDocument);
	});
	app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404));
	return app;
}

export { actorMiddleware };
