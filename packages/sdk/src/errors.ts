/**
 * Errors that cross the core/HTTP boundary. Inbound adapters map `code` to a transport status;
 * anything else is treated as an internal error and never leaks details to clients.
 */
export type FamosErrorCode =
	| 'bad_request'
	| 'unauthenticated'
	| 'forbidden'
	| 'not_found'
	| 'conflict'
	/** A quota or rate limit was reached; trying later may work. */
	| 'limit_reached'
	/** The extension is turned off (More → Features). */
	| 'feature_off'
	/** An `Idempotency-Key` was reused for a different action. */
	| 'idempotency_mismatch'
	/** The thing changed since the version the caller named (`ifMatch`). */
	| 'precondition_failed'
	/** What the caller asked about was kept only for a while and is no longer there. */
	| 'gone'
	| 'unavailable';

/**
 * Marks an error class by a registered symbol. An extension installed on its own can carry another
 * copy of this module, whose classes are different objects, so `instanceof` would miss its errors;
 * a symbol from `Symbol.for` is the same in every copy.
 */
export const hasBrand = (error: unknown, brand: symbol): boolean =>
	typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[brand] === true;

const FAMOS_ERROR = Symbol.for('famos.FamosError');

export class FamosError extends Error {
	readonly [FAMOS_ERROR] = true;
	readonly code: FamosErrorCode;
	readonly details: unknown;

	constructor(code: FamosErrorCode, message: string, details?: unknown) {
		super(message);
		this.name = 'FamosError';
		this.code = code;
		this.details = details;
	}
}

export const isFamosError = (error: unknown): error is FamosError => hasBrand(error, FAMOS_ERROR);

/** The HTTP status each error code maps to (shared by the API and the stored idempotent results). */
export const ERROR_HTTP_STATUS: Record<FamosErrorCode, number> = {
	bad_request: 400,
	unauthenticated: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	limit_reached: 429,
	feature_off: 404,
	idempotency_mismatch: 422,
	precondition_failed: 412,
	gone: 410,
	unavailable: 503,
};

/**
 * Why the action runner refused an AI's proposal, in `details.refused` of the `conflict` it
 * throws: what it asks for is already so (`settled`), its words name something other than what it
 * points at (`other_target`) or only partly name it (`unsure_target`), or it named nothing
 * (`no_label`).
 */
export type ProposalRefusal = 'settled' | 'other_target' | 'unsure_target' | 'no_label';
/** The `details` of such a refusal; `subject` is what the proposal was about, when known. */
export interface ProposalRefusalDetails {
	refused: ProposalRefusal;
	subject?: string;
}
