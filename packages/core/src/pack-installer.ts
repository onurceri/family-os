import {
	defineAction,
	defineJob,
	defineRoute,
	type EventDefinition,
	FamosError,
	isFamosError,
	systemActor,
} from '@famos/sdk';
import { z } from 'zod';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { readJson, writeJson } from './settings-json.ts';

const FetchStateSchema = z.object({
	status: z.enum(['fetching', 'done', 'failed']),
	url: z.string(),
	/** A short reason in plain words when it failed; never the response body. */
	error: z.string().nullable(),
	at: z.number(),
});
type FetchState = z.infer<typeof FetchStateSchema>;

export interface PackInstallerOptions {
	/** The settings key the last install's state is kept under. */
	key: string;
	/** The job that fetches the pack. */
	job: string;
	/** The action the job installs through, once the pack is read. */
	installActionId: string;
	/** What the fetched JSON must look like before the install action sees it. */
	schema: z.ZodType;
	maxBytes: number;
	/** What the pack is called in answers: `language`, `theme`. */
	noun: string;
	/** The action that queues the fetch. */
	actionId: string;
	actionTitle: string;
	/** The caller the job installs as. */
	actor: string;
	route: { path: string; operationId: string; summary: string };
	/** Tells open screens something changed; the payload key is null for "no one pack". */
	changed: {
		// biome-ignore lint/suspicious/noExplicitAny: the two events differ only in their payload key
		event: EventDefinition<string, any>;
		key: string;
	};
}

/**
 * Installing a pack from an address: an action queues a job, the job fetches (network I/O is a job's
 * business), checks the shape and installs through the pack's own install action; the outcome is kept
 * for the settings page to show.
 */
export function createPackInstaller(options: PackInstallerOptions) {
	const { key, job, installActionId, schema, maxBytes, noun, changed } = options;

	const fetchState = defineRoute({
		method: 'get',
		path: options.route.path,
		operationId: options.route.operationId,
		summary: options.route.summary,
		requires: CORE_CAPABILITIES.settingsManage.id,
		response: FetchStateSchema.nullable(),
		async handle(ctx) {
			return readJson<FetchState | null>(ctx.db, key, null);
		},
	});

	const installFromUrl = defineAction({
		id: options.actionId,
		title: options.actionTitle,
		input: z.object({ url: z.url().max(2000) }),
		output: z.object({ queued: z.literal(true) }),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		async run(uow, input) {
			if (new URL(input.url).protocol !== 'https:')
				throw new FamosError('bad_request', 'Only https addresses are allowed');
			await writeJson(
				uow.db,
				key,
				{
					status: 'fetching',
					url: input.url,
					error: null,
					at: uow.clock.now(),
				} satisfies FetchState,
				uow.clock.now(),
			);
			// The fetch is network I/O, so it runs as a job (the guarded HTTP port is for jobs).
			await uow.enqueue(job, { url: input.url });
			uow.emit(changed.event, { [changed.key]: null });
			return { queued: true as const };
		},
	});

	const fetchPack = defineJob({
		name: job,
		payload: z.object({ url: z.string() }),
		maxAttempts: 2,
		timeoutMs: 60_000,
		async handle(ctx, payload) {
			const done = (state: Omit<FetchState, 'at' | 'url'>) =>
				writeJson(
					ctx.db,
					key,
					{ ...state, url: payload.url, at: ctx.clock.now() },
					ctx.clock.now(),
				).then(() => ctx.events.emit(changed.event, { [changed.key]: null }));
			let text: string;
			try {
				const res = await ctx.http.get({ url: payload.url, maxBytes });
				if (res.status !== 200) throw new Error('unexpected answer');
				text = res.text;
			} catch {
				await done({ status: 'failed', error: 'The address could not be fetched' });
				return;
			}
			const notAPack = `The address did not return a ${noun} pack`;
			let pack: unknown;
			try {
				pack = JSON.parse(text);
			} catch {
				await done({ status: 'failed', error: notAPack });
				return;
			}
			const parsed = schema.safeParse(pack);
			if (!parsed.success) {
				await done({ status: 'failed', error: notAPack });
				return;
			}
			try {
				const result = await ctx.actions.invoke(
					installActionId,
					{ pack: parsed.data, url: payload.url },
					systemActor(options.actor),
				);
				if (result.status === 'applied') await done({ status: 'done', error: null });
				else await done({ status: 'failed', error: 'The pack was refused' });
			} catch (error) {
				// A pack that fails validation is final: say why, and do not retry.
				const reason = isFamosError(error) ? `: ${error.message}` : '';
				await done({ status: 'failed', error: `The pack was refused${reason}`.slice(0, 500) });
			}
		},
	});

	return { fetchState, installFromUrl, fetchPack, FetchStateSchema };
}
