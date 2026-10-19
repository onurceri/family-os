import {
	defineJob,
	defineNotificationKind,
	isLlmError,
	type JobContext,
	type LlmFile,
	type ModelRole,
} from '@famos/sdk';
import { z } from 'zod';
import {
	type ErrorCode,
	EXTRACT_FEATURE,
	READ_ATTEMPTS,
	TRANSCRIBE_FEATURE,
} from '../contract/index.ts';
import { itemChanged, PROCESS_JOB } from './items.ts';
import { filesOf, ITEM_KIND, type ItemRow, type StoredFile, tables } from './store.ts';
import { readItem } from './understand/pipeline.ts';

export {
	EXTRACT_MAX_OUTPUT_TOKENS,
	rankByMention,
	readRecordContexts,
	skipOf,
	tidySummary,
} from './understand/pipeline.ts';
export { PROMPT_VERSION } from './understand/prompt.ts';

const MODEL_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif',
	'application/pdf',
]);
const MAX_MODEL_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 200 * 1024;
const MAX_TEXT = 30_000;

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks);
}

const isAudio = (file: StoredFile) => file.type.startsWith('audio/');
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** Failures that leave the voice note unread but do not stop the rest of the item. */
const SKIPPABLE_VOICE_ERRORS: ReadonlySet<string> = new Set([
	'not_configured',
	'disabled',
	'rejected',
]);

/**
 * Voice notes as text. A retryable failure (outage, timeout) throws so the job retries, and a
 * problem a person must fix (no speech-to-text model, voice notes off) leaves the voice note
 * unread: the rest of the item is still read. Other errors (bad key, limit) fail the item.
 */
async function transcribe(ctx: JobContext, row: ItemRow, run: JobRun): Promise<string[]> {
	const audio = filesOf(row).filter((f) => isAudio(f) && f.size <= MAX_AUDIO_BYTES);
	if (audio.length === 0) return [];
	const policy = await ctx.llm.policy(TRANSCRIBE_FEATURE, 'transcribe');
	if (!policy.enabled || !policy.sendVoice) return [];
	const { locale } = await ctx.family.settings();
	const texts: string[] = [];
	for (const file of audio) {
		const stored = await ctx.files.get(file.key);
		if (!stored) continue;
		try {
			const result = await ctx.llm.transcribe({
				feature: TRANSCRIBE_FEATURE,
				areas: ['inbox'],
				audio: await readAll(stored.stream),
				mediaType: file.type,
				filename: file.name,
				// Transcription takes the bare language (`pt` for `pt-BR`).
				language: new Intl.Locale(locale).language,
				timeoutMs: 120_000,
				memberId: row.created_by,
				jobId: run.id,
			});
			if (result.text) texts.push(result.text);
		} catch (error) {
			if (isLlmError(error) && !error.retryable && SKIPPABLE_VOICE_ERRORS.has(error.code)) {
				ctx.logger.info({ itemId: row.id, code: error.code }, 'voice note left unread');
				continue;
			}
			throw error;
		}
	}
	return texts;
}

type JobRun = { id: string; attempt: number; maxAttempts: number };

/**
 * Step 1: the item's text, readable text files and voice notes (as text), ready for the model.
 * Nothing is saved before it finishes, so a retry after a failed transcription starts clean.
 */
async function normalize(
	ctx: JobContext,
	row: ItemRow,
	run: JobRun,
): Promise<{ text: string; transcript: string | null }> {
	const parts = [row.title, row.text, row.url].filter((p): p is string => Boolean(p));
	for (const file of filesOf(row)) {
		if (file.type !== 'text/plain' || file.size > MAX_TEXT_FILE_BYTES) continue;
		const stored = await ctx.files.get(file.key);
		if (stored)
			parts.push(`--- ${file.name} ---\n${new TextDecoder().decode(await readAll(stored.stream))}`);
	}
	const voice = await transcribe(ctx, row, run);
	for (const text of voice) parts.push(`--- Voice note ---\n${text}`);
	return {
		text: parts.join('\n\n').slice(0, MAX_TEXT),
		transcript: voice.length ? voice.join('\n\n').slice(0, MAX_TEXT) : null,
	};
}

/** Images and PDFs the model reads directly, within a size budget. */
async function modelFiles(
	ctx: JobContext,
	files: StoredFile[],
): Promise<{ files: LlmFile[]; unreadable: string[] }> {
	const out: LlmFile[] = [];
	const unreadable: string[] = [];
	let budget = MAX_MODEL_BYTES;
	for (const file of files) {
		if (file.type === 'text/plain' || isAudio(file)) continue;
		if (!MODEL_TYPES.has(file.type) || file.size > budget) {
			unreadable.push(file.name);
			continue;
		}
		const stored = await ctx.files.get(file.key);
		if (!stored) continue;
		out.push({ data: await readAll(stored.stream), mediaType: file.type });
		budget -= file.size;
	}
	return { files: out, unreadable };
}

async function markFailed(ctx: JobContext, row: ItemRow, code: ErrorCode) {
	await tables(ctx.db)
		.updateTable('inbox_items')
		.set({ status: 'failed', error_code: code, read_attempt: null, updated_at: ctx.clock.now() })
		.where('id', '=', row.id)
		.execute();
	await ctx.ai.reindex(ITEM_KIND, row.id);
	await ctx.events.emit(itemChanged, { itemId: row.id, memberId: row.created_by });
}

/** AI is off: keep the item unread (not a failure) until someone reads it again. */
async function hold(ctx: JobContext, row: ItemRow) {
	await tables(ctx.db)
		.updateTable('inbox_items')
		.set({ status: 'held', error_code: null, read_attempt: null, updated_at: ctx.clock.now() })
		.where('id', '=', row.id)
		.execute();
	await ctx.ai.reindex(ITEM_KIND, row.id);
	await ctx.events.emit(itemChanged, { itemId: row.id, memberId: row.created_by });
}

/** The person's own notification when what they shared from outside the app has been read. */
export const itemReady = defineNotificationKind({
	id: 'inbox.itemReady',
	label: 'inbox:notify_kind_item_ready',
	audience: 'inbox.share',
});
const OUTSIDE_CHANNELS: ReadonlySet<string> = new Set(['telegram', 'email', 'share']);

/** Step 2: the model reads the item into mentions, and the kinds' extensions turn them into drafts. */
async function extract(ctx: JobContext, row: ItemRow, run: JobRun) {
	const db = tables(ctx.db);
	const base = await ctx.llm.policy(EXTRACT_FEATURE, 'smart');
	if (!base.enabled) {
		await hold(ctx, row);
		return;
	}
	const stored = filesOf(row);
	const { files, unreadable } = base.sendFiles
		? await modelFiles(ctx, stored)
		: { files: [], unreadable: [] };
	const withheld = base.sendFiles
		? 0
		: stored.filter((f) => f.type !== 'text/plain' && !isAudio(f)).length;
	const text = row.normalized_text ?? '';
	if (!text.trim() && files.length === 0) {
		const unreadVoice = !row.transcript && stored.some(isAudio);
		await markFailed(
			ctx,
			row,
			unreadVoice ? 'voice_not_read' : withheld > 0 ? 'files_off' : 'unsupported',
		);
		return;
	}

	// Photos need the vision model, which may live elsewhere than the text model: whether the
	// kinds may include local-only areas depends on the model that will read it.
	const role: ModelRole = files.length > 0 ? 'vision' : 'smart';
	const policy = role === 'smart' ? base : await ctx.llm.policy(EXTRACT_FEATURE, role);
	const { summary, kind, model, drafted, skips } = await readItem(ctx, {
		text,
		files,
		unreadable,
		withheld,
		channel: row.channel,
		itemId: row.id,
		extraction: row.extraction,
		sharer: row.created_by,
		role,
		local: policy.local,
		sendPeople: policy.sendPeople,
		model: policy.model,
		jobId: run.id,
		lastTry: run.attempt >= run.maxAttempts,
	});

	// From outside the app the person is not looking at the item: tell them it is ready, once per
	// reading (the key). Telegram adds the buttons of the suggestions they may decide.
	if (drafted > 0 && row.created_by && OUTSIDE_CHANNELS.has(row.channel)) {
		await ctx.notify({
			kind: itemReady.id,
			to: { members: [row.created_by] },
			title: { key: 'inbox:ready_title' },
			body: { key: 'inbox:ready_body', params: { count: drafted } },
			url: '/add',
			source: { kind: 'inbox', id: row.id },
			dedupeKey: `inbox-ready:${row.id}:${row.extraction}`,
		});
	}
	await db
		.updateTable('inbox_items')
		.set({
			status: 'extracted',
			summary,
			kind,
			model,
			proposals: drafted,
			skipped: skips.length,
			skipped_unknown: skips.filter((skip) => skip.reason === 'unknown').length,
			skips: JSON.stringify(skips),
			error_code: null,
			read_attempt: null,
			updated_at: ctx.clock.now(),
		})
		.where('id', '=', row.id)
		// A person may have filed the item while the model was reading it: filed stays filed.
		.where('status', '!=', 'filed')
		.execute();
	await ctx.ai.reindex(ITEM_KIND, row.id);
	await ctx.events.emit(itemChanged, { itemId: row.id, memberId: row.created_by });
}

/**
 * Reads an inbox item in idempotent steps: normalize (saved), then extract. A retry after a
 * model failure skips the finished step; drafts carry dedupe keys, so a rerun never duplicates.
 * Problems a person must fix (no model, bad key, limit) fail the item at once; outages retry.
 */
export const processItem = defineJob({
	name: PROCESS_JOB,
	payload: z.object({ itemId: z.string() }),
	timeoutMs: 150_000,
	maxAttempts: READ_ATTEMPTS,
	backoff: (attempt) => Math.min(30_000 * 2 ** (attempt - 1), 10 * 60_000),
	async handle(ctx, { itemId }, run) {
		const db = tables(ctx.db);
		let row = await db
			.selectFrom('inbox_items')
			.selectAll()
			.where('id', '=', itemId)
			.executeTakeFirst();
		if (!row || !['received', 'normalized'].includes(row.status)) return;
		try {
			if (row.status === 'received') {
				// With AI off, voice notes cannot be read: keep the item unnormalized, so reading it
				// again later transcribes them.
				if (
					filesOf(row).some(isAudio) &&
					!(await ctx.llm.policy(EXTRACT_FEATURE, 'smart')).enabled
				) {
					return hold(ctx, row);
				}
				const { text, transcript } = await normalize(ctx, row, run);
				await db
					.updateTable('inbox_items')
					.set({
						status: 'normalized',
						normalized_text: text,
						transcript,
						updated_at: ctx.clock.now(),
					})
					.where('id', '=', row.id)
					.where('status', '!=', 'filed')
					.execute();
				row = { ...row, status: 'normalized', normalized_text: text, transcript };
				await ctx.ai.reindex(ITEM_KIND, row.id);
				await ctx.events.emit(itemChanged, { itemId: row.id, memberId: row.created_by });
			}
			await extract(ctx, row, run);
		} catch (error) {
			const last = run.attempt >= run.maxAttempts;
			if (isLlmError(error)) {
				const { code } = error;
				// Turned off between the check and the call.
				if (code === 'disabled') return hold(ctx, row);
				if (!error.retryable || last)
					return markFailed(ctx, row, code === 'local_required' ? 'ai_local_required' : code);
			}
			if (last) return markFailed(ctx, row, 'unavailable');
			// The job runs again after its backoff: say so, instead of a reading that looks stuck.
			await db
				.updateTable('inbox_items')
				.set({ read_attempt: run.attempt + 1, updated_at: ctx.clock.now() })
				.where('id', '=', row.id)
				.execute();
			await ctx.events.emit(itemChanged, { itemId: row.id, memberId: row.created_by });
			throw error;
		}
	},
});
