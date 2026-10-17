import { z } from 'zod';

/** A field of {@link wholeRecord}: sent always, as null to clear it when it may be left empty. */
export type WholeField<F extends z.core.SomeType> =
	F extends z.ZodOptional<infer I extends z.ZodType>
		? I extends z.ZodNullable<z.ZodType>
			? I
			: z.ZodNullable<I>
		: F extends z.ZodDefault<infer I extends z.ZodType>
			? I
			: F;

/** The shape of {@link wholeRecord}. */
export type WholeShape<S extends z.ZodRawShape> = { -readonly [K in keyof S]: WholeField<S[K]> };

/**
 * The input of an action that replaces a whole record with what a form saved, from the fields
 * its create action takes: every field must be sent. A field create lets you leave out is
 * required but nullable here (null clears it), and one with a default is required with a value,
 * so a body that leaves fields out is refused, naming them, instead of quietly clearing them or
 * putting their defaults back. The schema's refinements carry over. Partial changes are a
 * separate action whose fields are optional and mean "keep as it is".
 */
export function wholeRecord<S extends z.ZodRawShape>(
	fields: z.ZodObject<S>,
): z.ZodObject<WholeShape<S>> {
	const shape: Record<string, z.ZodType> = {};
	for (const [key, field] of Object.entries(fields.shape) as [string, z.ZodType][]) {
		let inner = field;
		let clearable = false;
		if (inner instanceof z.ZodOptional) {
			inner = inner.unwrap() as z.ZodType;
			clearable = true;
		} else if (inner instanceof z.ZodDefault) {
			inner = inner.def.innerType as z.ZodType;
		}
		if (clearable && !(inner instanceof z.ZodNullable)) inner = inner.nullable();
		shape[key] = field.description ? inner.describe(field.description) : inner;
	}
	const whole = z.object(shape);
	// A refinement reads the values, which are the same here; only a missing key differs, as null.
	const checks = (fields.def.checks ?? []) as z.core.$ZodCheck<Record<string, unknown>>[];
	return (checks.length ? whole.check(...checks) : whole) as unknown as z.ZodObject<WholeShape<S>>;
}

/**
 * The `storedInput` of an action whose input became {@link wholeRecord}: a draft stored before
 * read a field it left out as empty (or as its default), so that is what the upgrade fills in.
 * `key` names the property that holds the record (`task` in `{ id, task }`); without it the
 * input is the record itself. Anything that is not an object is left for the schema to refuse.
 */
export function storedAsWhole<S extends z.ZodRawShape>(
	fields: z.ZodObject<S>,
	key?: string,
): (input: unknown) => unknown {
	const fill = (record: unknown): unknown => {
		if (!isPlainObject(record)) return record;
		const filled: Record<string, unknown> = { ...record };
		for (const [name, field] of Object.entries(fields.shape) as [string, z.ZodType][]) {
			if (filled[name] !== undefined) continue;
			if (field instanceof z.ZodOptional) filled[name] = null;
			else if (field instanceof z.ZodDefault) filled[name] = field.parse(undefined);
		}
		return filled;
	};
	if (key === undefined) return fill;
	return (input) => (isPlainObject(input) ? { ...input, [key]: fill(input[key]) } : input);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
