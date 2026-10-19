import { z } from 'zod';

/**
 * The public API (`/api/public/v1`): what an extension chooses to offer outside programs. Nothing
 * is offered unless the extension marks it; marking an action or a route says its public name, its
 * method and its path, and may reshape what it answers. The shapes themselves stay the action's
 * and the route's own Zod schemas.
 */
export type ApiMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** What an answer is shaped with: the family's own settings. */
export interface ApiContext {
	/** IANA time zone of the family; every instant is written with its offset. */
	readonly timeZone: string;
	/** The family's language. */
	readonly language: string;
	/** Renders a key of the extension's catalog (`lists:default_list`) in the family's language. */
	translate(key: string, params?: Record<string, unknown>): string;
}

/** An answer's shape and the function that turns what the action or route returns into it. */
export interface ApiOutput {
	/** The schema of what `project` returns; it names the answer in the generated document. */
	readonly schema: z.ZodType;
	// biome-ignore lint/suspicious/noExplicitAny: the value is what the action or route returns, typed where the exposure is written.
	project(value: any, ctx: ApiContext): unknown;
}

/**
 * Types a projection: `project` receives the value the action or route returns and must give
 * what `schema` describes. Dropping what only the app needs (undo data, internal state) and
 * writing instants with their offset happens here.
 */
export function apiOutput<Value, S extends z.ZodType>(
	schema: S,
	project: (value: Value, ctx: ApiContext) => z.input<S>,
): ApiOutput {
	return { schema, project };
}

/**
 * One operation of the public API. The grammar is the same everywhere: `GET` list and get, `POST`
 * create and named commands (`POST …/complete`), `PATCH` changes some fields, `PUT` replaces the
 * whole record (and needs `If-Match`), `DELETE` removes.
 */
export interface ApiExposure {
	/** The version of the API this belongs to. Within a version, operations are only added to. */
	readonly api: 'v1';
	/** The operation's stable name, `<extension>.<verbNoun>` (the document's `operationId`). */
	readonly name: string;
	readonly method: ApiMethod;
	/**
	 * The path under `/api/public/v1/<extension>`, with `{param}` for a part that names a field of
	 * the action's input, or a param of the route.
	 */
	readonly path: string;
	/**
	 * For an action: a `{param}` of the path whose name is not the input field it sets, as
	 * `{ eventId: 'id' }`. Every `{param}` is the field of the same name unless named here.
	 */
	readonly params?: Readonly<Record<string, string>>;
	/** One line, for the document. */
	readonly summary: string;
	/**
	 * Fields the operation sets itself, so a command is a path and not a flag (`complete` is
	 * `done: true`). They are not part of what a caller sends.
	 */
	readonly fixed?: Readonly<Record<string, unknown>>;
	/** What the operation answers; without it, the action's own output (a route's response). */
	readonly output?: ApiOutput;
	/**
	 * Fields of the action's input that are not part of the public request (the ones only a model
	 * fills, such as a review label). They must be optional.
	 */
	readonly omit?: readonly string[];
	/**
	 * What a field is for, written for the document: the action's own descriptions are written for
	 * a model and name its tools.
	 */
	readonly describe?: Readonly<Record<string, string>>;
}

/** Marks an operation; returns it as it is, typed. */
export function defineApi(exposure: Omit<ApiExposure, 'api'>): ApiExposure {
	return { api: 'v1', ...exposure };
}

/** The shape of the id of an entity, `<prefix>_<uuid>`; one schema per prefix. */
const idShapes = new Map<string, z.ZodType<string>>();

/**
 * A typed id in an answer: a string of the form `<prefix>_<uuid>`. Not named in the generated
 * document: a named schema cannot also be nullable there, and ids often are.
 */
export function apiId(prefix: string): z.ZodType<string> {
	const known = idShapes.get(prefix);
	if (known) return known;
	const shape = z
		.string()
		.regex(new RegExp(`^${prefix}_[0-9a-f-]{36}$`))
		.describe(`An id of the form ${prefix}_<uuid>`);
	idShapes.set(prefix, shape);
	return shape;
}

/** An instant: RFC 3339 with the offset of the family's time zone. */
export const ApiInstantSchema = z.iso
	.datetime({ offset: true })
	.describe('A moment, RFC 3339 with the offset of the family time zone');

/** A calendar day without a time: `YYYY-MM-DD`, in the family's time zone. */
export const ApiDateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.describe('A day, YYYY-MM-DD, in the family time zone');

/** Writes an instant (epoch milliseconds) as RFC 3339 with the offset of `timeZone`. */
export function apiInstant(epochMs: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		timeZoneName: 'longOffset',
	}).formatToParts(new Date(epochMs));
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
	const zone = get('timeZoneName');
	const offset = zone === 'GMT' ? '+00:00' : zone.replace('GMT', '');
	return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
}
