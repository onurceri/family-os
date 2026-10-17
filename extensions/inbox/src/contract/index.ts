import { idSchema } from '@famos/sdk';
import { z } from 'zod';

/**
 * Family Inbox contract. Anything shared or uploaded becomes an item; a background job reads it
 * with the family's AI and proposes drafts (calendar events, tasks, shopping items) that a
 * person approves. Drafts live in core and point back here (`sourceKind: 'inbox'`).
 */
export const InboxItemIdSchema = idSchema('inbox_item');

export const CHANNELS = ['share', 'upload', 'text', 'telegram', 'email'] as const;
export const ChannelSchema = z.enum(CHANNELS);

/**
 * received → normalized → extracted, or failed (retryable by a person) / dismissed.
 * `normalized` means the content is prepared and the model step is pending or running.
 * `held`: AI (or reading the Inbox) is turned off; the item is kept unread until read again.
 * `filed`: a person put the item's files on a record ("Add to …"); the AI never reads it
 * (or, filed after it was read, does not read it again).
 */
export const STATUSES = [
	'received',
	'normalized',
	'extracted',
	'failed',
	'dismissed',
	'held',
	'filed',
] as const;

/** The AI feature name of reading items, as switched in Settings → AI. */
export const EXTRACT_FEATURE = 'inbox.extract';
/** The AI feature name of turning voice notes into text. */
export const TRANSCRIBE_FEATURE = 'inbox.transcribe';
/** How many times reading an item is tried before it fails (one reading plus its retries). */
export const READ_ATTEMPTS = 4;
export const ItemStatusSchema = z.enum(STATUSES);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

/** Why an item failed: the model error codes, or a file the pipeline cannot read. */
export const ErrorCodeSchema = z.enum([
	'not_configured',
	'limit_reached',
	'auth',
	'rejected',
	'data_policy',
	/** The area may only use local models, and none is set for this kind of work. */
	'ai_local_required',
	'timeout',
	'unavailable',
	'invalid_output',
	/** The answer ran past the output cap; reading the item again would end the same way. */
	'output_too_long',
	'unsupported',
	/** Only files were shared, and the family does not send files to the AI. */
	'files_off',
	/** A voice note could not be turned into text and there was nothing else to read. */
	'voice_not_read',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** What papers can be labelled as when filed; the same values as `DOCUMENT_LABELS` in records. */
export const FILE_LABELS = ['policy', 'invoice', 'card', 'receipt', 'other'] as const;
export const FileLabelSchema = z.enum(FILE_LABELS);
export type FileLabel = z.infer<typeof FileLabelSchema>;

/** Where an item's files go when a person files it themselves (the AI is not involved). */
export const FileToSchema = z.object({
	recordId: z.string().min(1).max(120),
	recordKind: z.string().min(1).max(40),
	label: FileLabelSchema.optional(),
	/** For display only ("Golf"); the record is known by its id. */
	recordName: z.string().trim().max(120).optional(),
});
export type FileTo = z.infer<typeof FileToSchema>;

export const FiledToSchema = z.object({
	recordId: z.string(),
	recordKind: z.string(),
	label: FileLabelSchema,
	recordName: z.string().nullable(),
});

export const ItemFileSchema = z.object({
	name: z.string(),
	type: z.string(),
	size: z.number().int(),
});

/**
 * What the model made of an item: something to act on, nothing to act on, or a question for
 * the family assistant (it is classified here, never answered).
 */
export const ExtractionKindSchema = z.enum(['actionable', 'nothing', 'question']);
export type ExtractionKind = z.infer<typeof ExtractionKindSchema>;

/**
 * Why a proposal was left out: what it asks for is already so (the item is already on the list,
 * the task already done), it pointed at something the household does not have, it was missing
 * something it needs, the person it was made for may not do it, or it came from words inside the
 * message written to the AI or the app rather than from what the message states.
 */
export const SKIP_REASONS = [
	'already',
	'unknown',
	'ambiguous',
	'incomplete',
	'not_allowed',
	'instruction',
] as const;
export const SkipReasonSchema = z.enum(SKIP_REASONS);
export type SkipReason = z.infer<typeof SkipReasonSchema>;

/** A proposal that was left out: why, and what it was about when that is known ("Ice cream"). */
export const SkipSchema = z.object({
	reason: SkipReasonSchema,
	subject: z.string().nullable(),
});
export type Skip = z.infer<typeof SkipSchema>;

export const InboxItemSchema = z.object({
	id: z.string(),
	channel: ChannelSchema,
	title: z.string().nullable(),
	text: z.string().nullable(),
	url: z.string().nullable(),
	files: z.array(ItemFileSchema),
	status: ItemStatusSchema,
	/** The record the files were filed on, when the status is `filed`. */
	filedTo: FiledToSchema.nullable(),
	/** What was said in the item's voice notes (speech to text), when they were read. */
	transcript: z.string().nullable(),
	/** A short label from the model for what the item is (a few words, not a sentence). */
	summary: z.string().nullable(),
	/** What the model made of the item; null while unread or when no model read it. */
	kind: ExtractionKindSchema.nullable(),
	errorCode: ErrorCodeSchema.nullable(),
	/**
	 * While a failed reading waits to be tried again: the number of the attempt that comes next
	 * (of `READ_ATTEMPTS`). Null when the item is not waiting for a retry.
	 */
	attempt: z.number().int().nullable(),
	/** Drafts proposed from this item. */
	proposals: z.number().int(),
	/** Proposals the model made that did not pass validation. */
	skipped: z.number().int(),
	/** Of the skipped, those that pointed at something that is not on the household's lists. */
	skippedUnknown: z.number().int(),
	/** Each proposal that was left out, with why, in the order the model made them. */
	skips: z.array(SkipSchema),
	createdBy: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

/** Text fields of the upload form (files travel as multipart parts). */
export const NewItemFieldsSchema = z.object({
	channel: ChannelSchema.default('upload'),
	title: z.string().trim().max(300).optional(),
	text: z.string().trim().max(20_000).optional(),
	url: z.url().max(2_000).optional(),
	/**
	 * File the item's files on a record instead of sending it to the AI (all `fileTo…` fields
	 * together, or none). Flat because the upload is a multipart form.
	 */
	fileToRecordId: z.string().min(1).max(120).optional(),
	fileToRecordKind: z.string().min(1).max(40).optional(),
	fileToLabel: FileLabelSchema.optional(),
	fileToRecordName: z.string().trim().max(120).optional(),
});

export const UPLOAD_LIMITS = {
	maxBytes: 25 * 1024 * 1024,
	maxFiles: 6,
	accept: ['image/*', 'audio/*', 'application/pdf', 'text/plain'],
} as const;

/** What one member may add in 24 hours, so a lost phone or a script cannot fill the disk. */
export const UPLOAD_QUOTA = {
	items: 200,
	bytes: 300 * 1024 * 1024,
	windowMs: 24 * 60 * 60 * 1000,
} as const;

export const itemChangedPayload = z.object({ itemId: z.string() });

/** Typed or shared text up to this long, in one paragraph, is its own title. */
export const OWN_TITLE_MAX = 120;

/** The parts of an item that name it. */
export type Nameable = Pick<InboxItem, 'title' | 'text' | 'url' | 'transcript' | 'summary'> & {
	files: readonly { name: string }[];
};

/**
 * How an item is named (lists, the detail heading, search): its title; plain short typed text
 * (no files, no voice) is its own title, so what a person wrote is what they see; else the
 * model's short label, else the first line, else the first file.
 */
export function itemTitle(item: Nameable): string {
	const explicit = item.title?.trim();
	if (explicit) return explicit;
	const text = item.text?.trim() ?? '';
	if (
		text &&
		item.files.length === 0 &&
		!item.transcript &&
		!item.url &&
		text.length <= OWN_TITLE_MAX &&
		!/\n\s*\n/.test(text)
	)
		return text.replace(/\s+/g, ' ');
	const firstLine = (item.text ?? item.url ?? '').split('\n').find((l) => l.trim());
	return (
		item.summary?.trim() || firstLine?.trim().slice(0, OWN_TITLE_MAX) || item.files[0]?.name || ''
	);
}

/** A record Quick add can file papers into ("Add to …"). */
export interface FileTarget {
	recordId: string;
	recordKind: string;
	/** What the person sees ("Golf", "Luna"). */
	name: string;
}

declare global {
	interface FamosExtensionSlots {
		/**
		 * Records a person can file Quick add papers into, contributed by domain extensions. Each
		 * contribution shows its own records as choices (and nothing when it has none); `selected`
		 * is the current choice across all contributions. With no contribution Quick add hides
		 * "Add to…".
		 */
		'inbox.fileTarget': { selected: FileTarget | null; onselect(target: FileTarget | null): void };
	}
}
