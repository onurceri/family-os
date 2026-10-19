import type { Kysely } from 'kysely';
import { hasBrand } from './errors.ts';

/**
 * Ports: interfaces for infrastructure that is likely to change. Implementations live in
 * @famos/adapters and are wired only in the composition root (apps/server).
 * The database is deliberately NOT a port .
 */

/**
 * A Kysely instance or transaction with no tables in its type: callers add their own tables
 * with `db.withTables<MyTables>()`, so untyped table access does not compile.
 */
export type DbExecutor = Kysely<object>;

export interface Clock {
	/** Epoch milliseconds (UTC). */
	now(): number;
}

export interface IdGenerator {
	/** Returns `<prefix>_<uuidv7>`. */
	next<P extends string>(prefix: P): `${P}_${string}`;
}

export interface Logger {
	debug(obj: object, msg?: string): void;
	info(obj: object, msg?: string): void;
	warn(obj: object, msg?: string): void;
	error(obj: object, msg?: string): void;
	child(bindings: object): Logger;
}

export interface FileStat {
	size: number;
	contentType: string | undefined;
}

export interface FileStore {
	put(
		key: string,
		data: Uint8Array | AsyncIterable<Uint8Array>,
		contentType?: string,
	): Promise<FileStat>;
	get(key: string): Promise<{ stream: AsyncIterable<Uint8Array>; stat: FileStat } | null>;
	stat(key: string): Promise<FileStat | null>;
	delete(key: string): Promise<void>;
}

/** Which logins a member has. */
export interface SignInMethods {
	/** An email and password. */
	password: boolean;
	/** A PIN (it works only on family devices). */
	pin: boolean;
}

/**
 * Credential management, implemented by the identity adapter. Core never sees
 * passwords or PINs beyond passing them through.
 *
 * Identity calls share the single SQLite connection: NEVER call them inside a unit of work
 * (transaction), or the connection deadlocks waiting for itself.
 */
export interface IdentityAdmin {
	/** Creates (or replaces) an email + password login for a member. */
	setPasswordLogin(input: {
		memberId: string;
		email: string;
		password: string;
		displayName: string;
	}): Promise<void>;
	/** Creates (or replaces) a PIN login for a member whose role allows PIN sign-in. */
	setPin(input: { memberId: string; pin: string; displayName: string }): Promise<void>;
	/**
	 * How each member can sign in, by member id; a member with no login at all is left out. Never
	 * the email, password or PIN: only whether each exists.
	 */
	signInMethods(): Promise<ReadonlyMap<string, SignInMethods>>;
	/** Removes all logins and sessions of a member. */
	revokeAll(memberId: string): Promise<void>;
	/** Signs a member out everywhere; their logins stay (archived, role or credentials changed). */
	endSessions(memberId: string): Promise<void>;
	/** Ends the PIN sessions opened on a family device (the device was revoked). */
	endDeviceSessions(deviceId: string): Promise<void>;
	/** Signs everyone out: every session of every member ends. */
	endAllSessions(): Promise<void>;
	/**
	 * After a restore: for a login that exists in `previous` (the database that was set aside)
	 * and here, takes over the password or PIN hash that was set later there, and returns how
	 * many it took. Logins missing on either side are left alone.
	 */
	carryNewerLogins(previous: DbExecutor): Promise<number>;
}

export interface EnqueueOptions {
	/** Earliest execution time (epoch ms). Defaults to now. */
	runAt?: number;
	/** If a pending/running job with the same key exists, no new job is created. */
	dedupeKey?: string;
	maxAttempts?: number;
}

export interface ClaimedJob {
	id: string;
	name: string;
	payload: unknown;
	attempt: number;
	maxAttempts: number;
}

export type JobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead';

/**
 * Durable job queue. `enqueue` takes the caller's executor so a job can be written in the same
 * transaction as the data change it belongs to: the queue doubles as the outbox.
 */
export interface JobQueue {
	enqueue(
		db: DbExecutor,
		name: string,
		payload: unknown,
		options?: EnqueueOptions,
	): Promise<string>;
	/** Atomically leases the next due job among `names`, or returns undefined. */
	claim(names: readonly string[], leaseMs: number): Promise<ClaimedJob | undefined>;
	complete(id: string): Promise<void>;
	/** Records a failure; schedules a retry at `retryAt`, or marks the job dead when out of attempts. */
	fail(id: string, error: string, retryAt: number): Promise<JobState>;
	/** Returns expired leases to pending (worker crashed mid-job). Returns how many were recovered. */
	recoverExpired(): Promise<number>;
}

/** A rendered notification, ready for a channel. */
export interface NotificationMessage {
	title: string;
	body: string | null;
	/** A path inside the app, or null. */
	url: string | null;
	/** `url` as an absolute address when the family set its public address, else null. */
	link: string | null;
	/** The notification row id: lets a channel replace or tag its copy. */
	tag: string;
	/** What the notification is about (for example the Inbox item whose drafts wait), if anything. */
	source?: { kind: string; id: string };
}

/**
 * A way to reach a person outside the app, such as Web Push or Telegram. Channels are
 * copies of the in-app list: a lost message loses nothing. Texts arrive translated.
 */
export interface NotificationChannel {
	/** `webpush`, `telegram`. */
	readonly id: string;
	/** i18n key shown in preferences, e.g. `app:channel_webpush`. */
	readonly label: string;
	/** Whether this member can be reached (a subscription or a link exists). */
	isAvailableFor(memberId: string): Promise<boolean>;
	/** `gone`: the subscription or link no longer exists. Throw to retry later. */
	send(memberId: string, message: NotificationMessage): Promise<'sent' | 'gone'>;
}

/**
 * Secrets at rest (credentials an extension must keep and later reuse, such as a calendar
 * subscription URL that is itself a password). Implemented from `FAMOS_SECRET` by the composition
 * root; a database copy or backup alone does not reveal what was sealed. Sealing is local and
 * fast, so it may be used inside a unit of work. Never log or return plain values.
 */
export interface SecretBox {
	seal(plain: string): string;
	/** The plain text, or null when it was sealed with another secret or is corrupt. */
	open(sealed: string): string | null;
}

/**
 * Why an outbound request failed. `http_<status>` is a response that was not a success (and not
 * 304); the others never reached a usable response.
 */
export type ExternalHttpErrorCode =
	| 'bad_url'
	| 'blocked_address'
	| 'unreachable'
	| 'timeout'
	| 'redirect_refused'
	| 'too_large'
	| `http_${number}`;

const EXTERNAL_HTTP_ERROR = Symbol.for('famos.ExternalHttpError');

export class ExternalHttpError extends Error {
	readonly [EXTERNAL_HTTP_ERROR] = true;
	readonly code: ExternalHttpErrorCode;

	constructor(code: ExternalHttpErrorCode, message?: string) {
		super(message ?? code);
		this.name = 'ExternalHttpError';
		this.code = code;
	}
}

export const isExternalHttpError = (error: unknown): error is ExternalHttpError =>
	hasBrand(error, EXTERNAL_HTTP_ERROR);

export interface ExternalHttpRequest {
	/**
	 * `https:` (or `webcal:`, which means `https:`); plain `http:` only together with `allowLocal`
	 * (a service on the home network). Credentials in the URL are refused.
	 */
	url: string;
	/**
	 * Extra request headers (for example an API key). They are sent on every hop of a redirect
	 * (which stays on the same host) and must never be logged. `host` is ignored.
	 */
	headers?: Record<string, string>;
	/** Allow private, loopback and link-local addresses (a calendar on the home network). */
	allowLocal?: boolean;
	/** Validators from the previous response, sent as `If-None-Match` / `If-Modified-Since`. */
	conditional?: { etag?: string | null; lastModified?: string | null };
	/** Response body cap in bytes (after decompression). Default 5 MB. */
	maxBytes?: number;
	/** Whole-request limit including redirects. Default 20 s. */
	timeoutMs?: number;
}

export type ExternalHttpResponse =
	| { status: 304; etag: string | null; lastModified: string | null }
	| {
			status: 200;
			/** Decoded body. */
			text: string;
			/** The response's `Content-Type`, if sent. */
			contentType?: string | null;
			etag: string | null;
			lastModified: string | null;
	  };

/** The most a POST may send: a request body is a small JSON document, never a file. */
export const EXTERNAL_HTTP_MAX_POST_BYTES = 64 * 1024;

/** A POST: the request of a GET without validators, and a JSON body. */
export interface ExternalHttpPostRequest extends Omit<ExternalHttpRequest, 'conditional'> {
	/**
	 * The body, serialized by the port and sent as `application/json`. At most
	 * `EXTERNAL_HTTP_MAX_POST_BYTES` once serialized; a larger one is refused (`too_large`)
	 * before anything is sent.
	 */
	json: unknown;
}

export interface ExternalHttpPostResponse {
	/** A 2xx status: anything else throws `http_<status>`. */
	status: number;
	/** Decoded body (often empty). */
	text: string;
}

/**
 * Guarded outbound HTTP for extensions. The implementation resolves the host itself and
 * refuses private, loopback, link-local, unique-local, multicast and reserved addresses (unless
 * `allowLocal`), and enforces a size cap and a timeout. Network I/O: never call it inside a
 * transaction. Throws `ExternalHttpError`.
 */
export interface ExternalHttp {
	/**
	 * A GET. It follows redirects only within the same host. Jobs are the normal place; a route
	 * may use it only for a bounded, cached read-through that a person is waiting for (the ambient
	 * extension's weather proxy).
	 */
	get(request: ExternalHttpRequest): Promise<ExternalHttpResponse>;
	/**
	 * A POST with a JSON body, through the same guard. A POST changes something outside, so it is
	 * sent from job handlers only, never from a route or an action's `run`; it is never re-sent
	 * to a redirect's target (any 3xx is `redirect_refused`).
	 */
	post(request: ExternalHttpPostRequest): Promise<ExternalHttpPostResponse>;
}
