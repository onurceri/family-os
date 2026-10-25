import {
	type ActionResult,
	type Actor,
	type AnyActionDefinition,
	FamosError,
	type MemberId,
	subjectOf,
	UNSURE_TARGET,
	type UnitOfWork,
} from '@famos/sdk';
import {
	AUTO_APPROVE_JOB,
	DEFAULT_DRAFT_NOTIFY_DELAY_MS,
	factsOf,
	qualifies,
	readAutoApproval,
	waitingNotice,
} from '../auto-approval.ts';
import { draftCreated } from '../core-events.ts';
import { decide, refusalError } from '../decide.ts';
import { dayOfSuggestion } from '../draft-expiry.ts';
import {
	findStored,
	type IdempotencyRequest,
	IdempotentReplay,
	idempotencyPrincipal,
	isStoredError,
	storeError,
	storeResult,
} from '../idempotency.ts';
import type { CoreTables } from '../tables.ts';
import type { Admission } from './admission.ts';
import type { Hints } from './hints.ts';
import type { Labels } from './labels.ts';
import { CLOSED_MATTER, parseOrThrow, QUOTE_MAX, refusal } from './shared.ts';
import type { Targets } from './targets.ts';
import type { ActionRunnerDeps, InvokeOptions } from './types.ts';
import type { UnitOfWorkParts } from './unit-of-work.ts';

/**
 * Running an action: a stored answer for a repeated request key, the checks in their order, and
 * then applying it or storing the suggestion a person decides.
 */
export function createInvoke(
	deps: ActionRunnerDeps,
	{
		env,
		getAction,
		assertCallable,
		readContext,
		settledReason,
		decideInput,
		unitOfWork,
		audit,
		targetIdOf,
		apply,
		checkTarget,
		assertVersion,
		targetIsGone,
		namedSubject,
		seemsToExist,
		alternativeOf,
		aiProposerLabel,
		proposerLabel,
	}: Admission & UnitOfWorkParts & Targets & Hints & Labels,
) {
	const { clock, ids, access } = deps;
	async function invoke<O>(
		actionId: string,
		rawInput: unknown,
		actor: Actor,
		options: InvokeOptions = {},
	): Promise<ActionResult<O>> {
		const principal = idempotencyPrincipal(actor);
		if (principal === null || !options.idempotencyKey) {
			return invokeOnce(actionId, rawInput, actor, options, null);
		}
		const request: IdempotencyRequest = { key: options.idempotencyKey, principal };
		const replay = (stored: Awaited<ReturnType<typeof findStored>>) => {
			if (stored?.kind === 'error') throw stored.error;
			options.onReplay?.();
			return stored?.value as ActionResult<O>;
		};
		const stored = await findStored(deps.db, request, actionId);
		if (stored) return replay(stored);
		try {
			return await invokeOnce<O>(actionId, rawInput, actor, options, request);
		} catch (error) {
			if (error instanceof IdempotentReplay) return replay(error.stored);
			// Refusals are answered the same way next time; other failures stay retryable.
			if (isStoredError(error)) {
				await storeError(deps.db, request, actionId, clock.now(), error);
			}
			throw error;
		}
	}

	async function invokeOnce<O>(
		actionId: string,
		rawInput: unknown,
		actor: Actor,
		options: InvokeOptions,
		idem: IdempotencyRequest | null,
	): Promise<ActionResult<O>> {
		const def = getAction(actionId);
		assertCallable(options.caller ?? 'core', def, actor);
		// What is refused whatever the input is refused before the input is read.
		const before = decide(def, actor, env);
		if (before.outcome === 'refuse' && !before.depends) throw refusalError(before);
		const parsed = parseOrThrow(def.input, rawInput, `input for ${actionId}`);
		const input = def.resolveNames ? await def.resolveNames(readContext(def), parsed) : parsed;
		const { title: checkedTitle, unsure: targetUnsure } = await checkTarget(def, input, actor);
		const settled = await settledReason(def, actor, input);
		const decision = await decideInput(def, actor, input, settled);
		if (decision.outcome === 'refuse') {
			if (decision.reason === 'settled')
				throw new FamosError(
					'conflict',
					`${settled}${CLOSED_MATTER}`,
					refusal('settled', checkedTitle),
				);
			throw refusalError(decision);
		}
		/** Inside the transaction: a concurrent request may have stored the key meanwhile. */
		const guard = async (uow: UnitOfWork) => {
			if (!idem) return;
			const stored = await findStored(uow.db, idem, actionId);
			if (stored) throw new IdempotentReplay(stored);
		};
		const remember = (uow: UnitOfWork, result: ActionResult<unknown>) =>
			idem ? storeResult(uow.db, idem, actionId, clock.now(), result) : Promise.resolve();

		if (decision.outcome === 'apply') {
			// Slow or networked work (a model call) happens before the transaction opens.
			const prepared = def.prepare ? await def.prepare(input, actor) : undefined;
			const output = await unitOfWork(actor, async (uow, view) => {
				await guard(uow);
				await assertVersion(def, input, options.ifMatch, uow.db);
				const out = await apply(uow, view, def, input, null, prepared);
				await remember(uow, { status: 'applied', output: out });
				return out;
			});
			return { status: 'applied', output: output as O };
		}
		// A suggestion about something that is not there is refused as the direct run would be,
		// instead of waiting for a person to find out it can never be applied.
		if (await targetIsGone(def, input))
			throw new FamosError('not_found', 'What this changes was not found');
		const meta = options.draft ?? {};
		// Every draft carries the real name of what it changes, so cards and notices show what
		// will happen whoever proposed it (a screen sends only the id).
		const targetName = def.targetTitle
			? (checkedTitle ?? (await def.targetTitle(readContext(def), input)))
			: await namedSubject(def, input);
		const stored = targetName ? { ...(input as object), label: targetName.slice(0, 200) } : input;
		const subject = subjectOf(JSON.stringify(stored));
		const date = dayOfSuggestion(def, input);
		// A target the AI named only in another form of its words is shown as "check this".
		const uncertainFields = [
			...new Set([...(meta.uncertainFields ?? []), ...(targetUnsure ? [UNSURE_TARGET] : [])]),
		];
		// Personal drafts (memory, questions to a person) go to the member the assistant works for.
		const personalTo =
			actor.kind === 'ai' && def.ai?.addressToMember && actor.onBehalfOf ? actor.onBehalfOf : null;
		let draftId = ids.next('draft');
		let autoApproved = false;
		let byOthers = false;
		await unitOfWork(actor, async (uow) => {
			await guard(uow);
			await assertVersion(def, input, options.ifMatch, uow.db);
			if (meta.dedupeKey) {
				const existing = await uow.db
					.withTables<CoreTables>()
					.selectFrom('core_drafts')
					.select('id')
					.where('dedupe_key', '=', meta.dedupeKey)
					.executeTakeFirst();
				if (existing) {
					draftId = existing.id as typeof draftId;
					await remember(uow, {
						status: 'drafted',
						draftId,
						...(subject ? { subject } : {}),
						...(date ? { date } : {}),
					});
					return;
				}
			}
			const now = clock.now();
			// Auto-approval comes first: a job approves it, so it is not addressed to anyone.
			const setting = def.autoApprove ? (await readAutoApproval(uow.db))[actionId] : undefined;
			const personal = factsOf(actor, meta.forMember, personalTo);
			// A suggestion read from something a member shared belongs to that member: they may take
			// it back, and it is listed among their own.
			const proposer: Actor =
				actor.kind === 'ai' && !actor.onBehalfOf && meta.forMember
					? { ...actor, onBehalfOf: meta.forMember as MemberId }
					: actor;
			const auto =
				setting !== undefined &&
				personal.proposerMemberId !== null &&
				(await qualifies(uow.db, access, setting, personal));
			// Otherwise an AI draft belongs to the person behind it when they could decide it
			// themselves; if not (a supervised member), it goes to the approvers.
			const addressedTo =
				personalTo ??
				(!auto && actor.kind === 'ai' && personal.proposerMemberId !== null
					? await deciderBehind(uow, def, personal.proposerMemberId)
					: null);
			await uow.db
				.withTables<CoreTables>()
				.insertInto('core_drafts')
				.values({
					id: draftId,
					action_id: actionId,
					input: JSON.stringify(stored),
					edited_input: null,
					status: 'pending',
					proposed_by: JSON.stringify(proposer),
					source_kind: meta.sourceKind ?? null,
					source_id: meta.sourceId ?? null,
					summary: meta.summary ?? null,
					model: meta.model ?? null,
					prompt_version: meta.promptVersion ?? null,
					confidence: meta.confidence ?? null,
					uncertain_fields: uncertainFields.length ? JSON.stringify(uncertainFields) : null,
					quote: meta.quote?.trim() ? meta.quote.trim().slice(0, QUOTE_MAX) : null,
					dedupe_key: meta.dedupeKey ?? null,
					decided_by: null,
					decided_at: null,
					applied_at: null,
					result: null,
					error: null,
					for_member: addressedTo,
					created_at: now,
					updated_at: now,
				})
				.execute();
			await audit(uow, actionId, 'drafted', draftId, targetIdOf(def, input));
			const facts = { ...personal, addressedTo };
			// A person's AI whose draft goes to the approvers: someone else decides it.
			byOthers = !auto && actor.kind === 'ai' && facts.proposerMemberId !== null && !addressedTo;
			uow.emit(draftCreated, {
				draftId,
				actionId,
				proposerKind: actor.kind,
				proposerMemberId: facts.proposerMemberId,
				sourceKind: meta.sourceKind ?? null,
				forMember: addressedTo,
			});
			// A draft addressed to one member needs no announcement: they are looking at it.
			if (addressedTo) {
				await remember(uow, {
					status: 'drafted',
					draftId,
					...(subject ? { subject } : {}),
					...(date ? { date } : {}),
				});
				return;
			}
			if (auto && facts.proposerMemberId !== null) {
				// Nobody is told it waits (the job does if it cannot approve).
				await uow.enqueue(
					AUTO_APPROVE_JOB,
					{ draftId, proposerMemberId: facts.proposerMemberId },
					{ dedupeKey: `${AUTO_APPROVE_JOB}:${draftId}` },
				);
				autoApproved = true;
				await remember(uow, {
					status: 'drafted',
					draftId,
					...(subject ? { subject } : {}),
					...(date ? { date } : {}),
				});
				return;
			}
			// Tell whoever may approve, and who asked; several drafts from one shared item collapse
			// into one.
			const who =
				actor.kind === 'ai'
					? await aiProposerLabel(uow, facts.proposerMemberId, meta)
					: await proposerLabel(uow, actor);
			await uow.notify(
				waitingNotice(
					{
						id: draftId,
						summary: meta.summary ?? null,
						sourceKind: meta.sourceKind ?? null,
						sourceId: meta.sourceId ?? null,
						input: JSON.stringify(stored),
					},
					def,
					facts.proposerMemberId,
					deps.draftNotifyDelayMs ?? DEFAULT_DRAFT_NOTIFY_DELAY_MS,
					who,
				),
			);
			await remember(uow, {
				status: 'drafted',
				draftId,
				...(subject ? { subject } : {}),
				...(date ? { date } : {}),
			});
		});
		// The proposer is told too, so an AI can warn the person before they look at the card.
		const exists = await seemsToExist(def, input, { actionId });
		// And of what it could change instead: an agent tells the person, who chooses when deciding.
		const offered = autoApproved ? null : await alternativeOf(def, input, { actionId });
		const named = (offered?.input as { label?: unknown } | undefined)?.label;
		const instead =
			offered && typeof named === 'string'
				? {
						name: named,
						...(offered.at && { at: offered.at }),
						...(offered.to && { to: offered.to }),
					}
				: undefined;
		return {
			status: 'drafted',
			draftId,
			...(exists ? { mayExist: exists } : {}),
			...(instead && { instead }),
			...(autoApproved ? { autoApproval: true as const } : {}),
			...(byOthers ? { decidedByOthers: true as const } : {}),
			...(subject ? { subject } : {}),
			...(date ? { date } : {}),
		};
	}

	/**
	 * The person behind an AI draft, when they could decide it themselves: not archived, and
	 * holding `core.drafts.approve` and whatever the action needs (the same as `assertApprover`).
	 * Read through the transaction. Null when the draft should go to the approvers.
	 */
	async function deciderBehind(
		uow: UnitOfWork,
		def: AnyActionDefinition,
		memberId: string,
	): Promise<string | null> {
		const member = await uow.db
			.withTables<CoreTables>()
			.selectFrom('core_members')
			.select(['role_id', 'archived_at'])
			.where('id', '=', memberId)
			.executeTakeFirst();
		if (!member || member.archived_at !== null) return null;
		const held = access.effective(member.role_id);
		if (!held.has('core.drafts.approve')) return null;
		if (def.requires && !held.has(def.requires)) return null;
		if (typeof def.approval === 'object' && !held.has(def.approval.unless)) return null;
		return memberId;
	}

	return { invoke };
}
