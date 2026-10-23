import { idSchema } from '@famos/sdk';
import { IsoDateSchema } from '@famos/time';
import { z } from 'zod';

export * from './mentions.ts';

/**
 * Records contract: duties that come back (obligations) and papers (documents) for
 * any record that a domain extension owns (a vehicle, a pet, a home…). Records are known only by
 * their typed id; `records` never reads a domain's tables. Obligations are tracked by calendar
 * date only, in the family time zone.
 */
export const ObligationIdSchema = idSchema('obligation');
export const RecordDocIdSchema = idSchema('record_doc');
export const MemberIdSchema = idSchema('member');

/** A typed id of another extension's record: `<prefix>_<uuid>`, e.g. `vehicle_0192…`. */
export const RecordIdSchema = z
	.string()
	.regex(
		/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		'Expected a typed record id',
	);
/** What kind of record it is, as its owner names it: `vehicle`, `pet`, `home`. */
export const RecordKindSchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
/** The record's name for lists that span records ("Golf", "Luna"). Kept in sync by its owner. */
export const RecordNameSchema = z.string().trim().min(1).max(120);
/** A path inside the app that opens the record, e.g. `/vehicles/vehicle_…`. */
export const RecordUrlSchema = z
	.string()
	.max(300)
	.regex(/^\/(?!\/)[^\s\\]*$/, 'Expected a path inside the app');

/** `custom`, or the id of a preset the domain declared (`liability_insurance`). */
export const ObligationKindSchema = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/);

/** A repeat by whole months or years. A date that does not exist in a month moves to its end. */
export const EverySchema = z
	.object({
		months: z.number().int().min(1).max(120).optional(),
		years: z.number().int().min(1).max(50).optional(),
	})
	.refine((v) => (v.months === undefined) !== (v.years === undefined), {
		message: 'Use either months or years',
	});
export type Every = z.infer<typeof EverySchema>;

/**
 * What a domain extension offers when a record is created: "what usually needs doing". Domains
 * export a list of these from their contract and pass it to the `record.section` slot. `titleKey`
 * is a namespaced translation key of the domain (`vehicles:preset_inspection`).
 */
export interface ObligationPreset {
	id: string;
	titleKey: string;
	/** Repeat interval; omit for a one-off duty (a warranty ending). */
	every?: { months?: number; years?: number };
	/** Reminder lead time in days; defaults to 14. */
	leadDays?: number;
	/** Translation key of a short hint shown next to the title. */
	labelKey?: string;
}

/**
 * What a person may change of a preset when picking it: how often it comes back and
 * how many days ahead to be reminded. Both optional; what is left out comes from the preset.
 * `every: null` means it does not repeat.
 */
export const PresetScheduleSchema = z.object({
	every: EverySchema.nullable().optional(),
	leadDays: z.number().int().min(0).max(365).optional(),
});

/** The repeat and lead time of a pick: the person's choice, else the preset's suggestion. */
export function scheduleOf(
	preset: Pick<ObligationPreset, 'every' | 'leadDays'>,
	pick: z.infer<typeof PresetScheduleSchema>,
): { every: Every | undefined; leadDays: number } {
	const every = pick.every === undefined ? preset.every : (pick.every ?? undefined);
	return {
		every: every as Every | undefined,
		leadDays: pick.leadDays ?? preset.leadDays ?? DEFAULT_LEAD_DAYS,
	};
}

/** A preset ticked in an add form, as the inputs hold it: the due date and the person's schedule. */
export interface PresetPickState {
	on: boolean;
	date: string;
	repeat: 'none' | 'months' | 'years';
	interval: number;
	leadDays: number;
}

/** An unticked pick that starts from the preset's suggestion. */
export function freshPick(preset: Pick<ObligationPreset, 'every' | 'leadDays'>): PresetPickState {
	const every = preset.every;
	return {
		on: false,
		date: '',
		repeat: every?.months ? 'months' : every?.years ? 'years' : 'none',
		interval: every?.months ?? every?.years ?? 1,
		leadDays: preset.leadDays ?? DEFAULT_LEAD_DAYS,
	};
}

/** The schedule part of an action input from what the person set. */
export function scheduleOfPick(pick: PresetPickState): {
	every: Every | null;
	leadDays: number;
} {
	const interval = Math.max(1, Math.round(pick.interval) || 1);
	return {
		every:
			pick.repeat === 'months'
				? { months: Math.min(interval, 120) }
				: pick.repeat === 'years'
					? { years: Math.min(interval, 50) }
					: null,
		leadDays: Math.min(365, Math.max(0, Math.round(pick.leadDays) || 0)),
	};
}

export const DEFAULT_LEAD_DAYS = 14;
/** Capability whose holders are reminded when nobody is assigned. */
export const DEFAULT_AUDIENCE = 'records.view';

export const ObligationFieldsSchema = z.object({
	kind: ObligationKindSchema.default('custom'),
	title: z.string().trim().min(1).max(160).describe('What needs doing, e.g. "Car insurance"'),
	dueDate: IsoDateSchema.describe('When it is due, YYYY-MM-DD, in the family time zone'),
	every: EverySchema.nullable().optional().describe('Repeat by months or years; omit for once'),
	leadDays: z.number().int().min(0).max(365).default(DEFAULT_LEAD_DAYS),
	assigneeId: MemberIdSchema.nullable().optional(),
	audience: z
		.string()
		.regex(/^[a-z][a-z0-9]*(?:\.[a-zA-Z0-9]+)+$/)
		.default(DEFAULT_AUDIENCE)
		.describe('Capability whose holders are reminded when nobody is assigned'),
	notes: z.string().trim().max(2000).nullable().optional(),
	lapses: z
		.boolean()
		.default(false)
		.describe(
			'true for a date that only passes and asks nothing of anyone (a warranty ends); it is never late, does not repeat and leaves the lists once it has passed',
		),
});

export const AddObligationSchema = ObligationFieldsSchema.extend({
	recordId: RecordIdSchema.describe('The record it belongs to'),
	recordKind: RecordKindSchema.describe('The kind of that record, e.g. "vehicle"'),
	recordName: RecordNameSchema.describe('The name of that record as listed, e.g. "Family car"'),
	recordUrl: RecordUrlSchema.nullable().optional(),
});
export type AddObligationInput = z.input<typeof AddObligationSchema>;

/**
 * Changing an obligation keeps its kind, repeat, audience, lead time, assignee, notes and whether
 * it lapses unless they are given (`null` clears the repeat, the assignee or the notes).
 */
export const UpdateObligationSchema = z.object({
	id: ObligationIdSchema,
	obligation: ObligationFieldsSchema.extend({
		kind: ObligationKindSchema.optional(),
		leadDays: ObligationFieldsSchema.shape.leadDays.unwrap().optional(),
		audience: ObligationFieldsSchema.shape.audience.unwrap().optional(),
		every: ObligationFieldsSchema.shape.every.describe(
			'Repeat by months or years; null for once; omit to keep it',
		),
		lapses: ObligationFieldsSchema.shape.lapses.unwrap().optional(),
	}),
});

export const ObligationSchema = z.object({
	id: z.string(),
	recordId: z.string(),
	recordKind: z.string(),
	recordName: z.string(),
	recordUrl: z.string().nullable(),
	kind: z.string(),
	title: z.string(),
	dueDate: z.string(),
	every: EverySchema.nullable(),
	/** The RFC 5545 rule behind `every` (FREQ and INTERVAL only). */
	rrule: z.string().nullable(),
	leadDays: z.number().int(),
	assigneeId: z.string().nullable(),
	audience: z.string(),
	notes: z.string().nullable(),
	/** A date that only passes (a warranty ends): never overdue, nothing to mark done. */
	lapses: z.boolean(),
	lastDoneOn: z.string().nullable(),
	archivedAt: z.number().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type Obligation = z.infer<typeof ObligationSchema>;

export const HistoryEntrySchema = z.object({
	id: z.string(),
	obligationId: z.string(),
	/** The due date that was completed. */
	dueDate: z.string(),
	doneOn: z.string(),
	doneBy: z.string().nullable(),
	note: z.string().nullable(),
	createdAt: z.number(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const CompleteObligationSchema = z.object({
	id: ObligationIdSchema.describe('The obligation'),
	/** The day it was done; defaults to today. */
	doneOn: IsoDateSchema.optional().describe('The day it was done, YYYY-MM-DD; omit for today'),
	note: z
		.string()
		.trim()
		.max(500)
		.nullable()
		.optional()
		.describe('A short note, e.g. a policy number or what was done'),
	/** The due date the caller saw; a stale completion (already rolled forward) is ignored. */
	dueDate: IsoDateSchema.optional(),
	/**
	 * When it is next due, if the caller knows (a renewed policy runs until…). Without it a
	 * repeating obligation follows its usual cycle. For a repeating obligation it becomes the
	 * new anchor of the series. Completing again with the date it already has changes nothing.
	 */
	nextDueDate: IsoDateSchema.optional().describe(
		'When it is next due, YYYY-MM-DD (e.g. the end of the renewed cover); omit if unknown',
	),
	/** Only for people reviewing a suggestion: which obligation it is. Never stored. */
	label: z
		.string()
		.trim()
		.max(200)
		.optional()
		.describe(
			'The obligation as listed, e.g. "Car insurance (Family car)"; only shown to the reviewer',
		),
});

/** What a completion changed, so it can be taken back (`records.undoCompletion`). */
export const CompletionBeforeSchema = z.object({
	/** The history entry the completion added. */
	entryId: idSchema('obligation_done'),
	dueDate: IsoDateSchema,
	rruleStart: IsoDateSchema.nullable(),
	lastDoneOn: IsoDateSchema.nullable(),
});

/** A completed obligation, and what it was before; `before` is null when nothing changed. */
export const CompletedObligationSchema = ObligationSchema.extend({
	before: CompletionBeforeSchema.nullable(),
});

export const UndoCompletionSchema = CompletionBeforeSchema.extend({ id: ObligationIdSchema });

export const RenameRecordSchema = z.object({
	recordId: RecordIdSchema,
	name: RecordNameSchema,
	url: RecordUrlSchema.nullable().optional(),
});

export const DOCUMENT_LABELS = ['policy', 'invoice', 'card', 'receipt', 'other'] as const;
export const DocumentLabelSchema = z.enum(DOCUMENT_LABELS);
export type DocumentLabel = z.infer<typeof DocumentLabelSchema>;

/** Files that arrived through the Inbox sit under `inbox/<item id>/<n>`. */
export const InboxFileSchema = z.object({
	key: z.string().regex(/^inbox\/[A-Za-z0-9_-]+\/\d{1,3}$/),
	name: z.string().min(1).max(255),
	type: z.string().max(100),
});

export const AttachDocumentSchema = z.object({
	recordId: RecordIdSchema,
	recordKind: RecordKindSchema,
	files: z.array(InboxFileSchema).min(1).max(20),
	label: DocumentLabelSchema.default('other'),
	expiresOn: IsoDateSchema.nullable().optional(),
	/** The Inbox item the files came from. */
	sourceItemId: z.string().max(100).nullable().optional(),
});
export type AttachDocumentInput = z.input<typeof AttachDocumentSchema>;

export const UpdateDocumentSchema = z.object({
	id: RecordDocIdSchema,
	name: z.string().trim().min(1).max(255).optional(),
	label: DocumentLabelSchema.optional(),
	expiresOn: IsoDateSchema.nullable().optional(),
});

export const RecordDocumentSchema = z.object({
	id: z.string(),
	recordId: z.string(),
	recordKind: z.string(),
	name: z.string(),
	type: z.string(),
	size: z.number().int(),
	label: DocumentLabelSchema,
	expiresOn: z.string().nullable(),
	sourceItemId: z.string().nullable(),
	createdBy: z.string().nullable(),
	createdAt: z.number(),
});
export type RecordDocument = z.infer<typeof RecordDocumentSchema>;

/** `audience`: the capability of the area the duty belongs to; only its holders hear of it. */
export const obligationChangedPayload = z.object({ recordId: z.string(), audience: z.string() });
/** `audience`: the capability of the area the record's papers belong to; records.view when left out. */
export const documentChangedPayload = z.object({
	recordId: z.string(),
	audience: z.string().optional(),
});

/** What a record's page passes to the sections of its `record.section` slot. */
export interface RecordSectionProps {
	recordId: string;
	recordKind: string;
	recordName: string;
	recordUrl?: string;
	/** Capability whose holders are reminded about new obligations when nobody is assigned. */
	audience?: string;
	presets?: readonly ObligationPreset[];
}

declare global {
	interface FamosExtensionSlots {
		/**
		 * A section of a record's page. The domain extension owns the page and renders this slot
		 * with `<Slot name="record.section" props={…} />`; `records` contributes the obligations
		 * and the papers, other extensions can add their own. `recordName` and `recordUrl` let a
		 * section keep lists that span records readable.
		 */
		'record.section': RecordSectionProps;
	}
}
