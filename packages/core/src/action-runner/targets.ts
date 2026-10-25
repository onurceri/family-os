import {
	type Actor,
	type AnyActionDefinition,
	compareThing,
	type DbExecutor,
	FamosError,
	targetOf,
} from '@famos/sdk';
import { ownerOf } from '../features.ts';
import type { Admission } from './admission.ts';
import { CLOSED_MATTER, type RowWithId, refusal } from './shared.ts';
import type { ActionRunnerDeps } from './types.ts';

/**
 * The row an input points at: that an AI named it, that it is still the version the caller read,
 * and that it is still there.
 */
export function createTargets(deps: ActionRunnerDeps, { readContext }: Admission) {
	const { logger } = deps;
	/**
	 * The real title of what an input points at, for actions that have a `targetTitle`. An AI must
	 * say in the person's own words which thing it means (`label`), and those words must name the
	 * target: a model that picked the closest thing instead of the named one is refused, so it
	 * tells the person it is not there. Null when the action has no target title or the target
	 * does not exist (the action then reports that itself).
	 */
	async function checkTarget(
		def: AnyActionDefinition,
		input: unknown,
		actor: Actor,
	): Promise<{ title: string | null | undefined; unsure: boolean }> {
		// People see what they pick: nothing to check, and no query unless a draft needs the name.
		if (actor.kind !== 'ai') return { title: undefined, unsure: false };
		const ctx = readContext(def);
		let title: string | null = null;
		let unsure = false;
		if (def.targetTitle) {
			const label = (input as { label?: unknown } | null)?.label;
			const said = typeof label === 'string' ? label.trim() : '';
			if (said === '')
				throw new FamosError(
					'conflict',
					'Say which one you mean: send `label` with the name the person used for it, in their words.',
					refusal('no_label'),
				);
			title = await def.targetTitle(ctx, input);
			if (title !== null) {
				const { locale } = await ctx.family.settings();
				const match = compareThing(said, title, { language: locale });
				const { band } = match;
				// The words in another form ("biology tests" for "Biology test") are a guess the
				// draft marks for a person to check; words that only partly name it are a question
				// for the person, never a change made on a guess.
				unsure = targetOf({ ...match, candidates: [title] }) === 'marked';
				if (band === 'weak' && !unsure)
					throw new FamosError(
						'conflict',
						`'${said}' may be '${title}', but does not surely name it. Ask the person which one they mean.`,
						refusal('unsure_target', said),
					);
				if (band === 'none')
					throw new FamosError(
						'conflict',
						`That is '${title}', not '${said}'.${CLOSED_MATTER}`,
						refusal('other_target', said),
					);
			}
		}
		return { title, unsure };
	}

	/**
	 * The conditional write: the caller read a version of the row the input points at; if it moved
	 * on, nothing may change. Runs inside the transaction of the write, so the check and the write
	 * cannot be pulled apart by another caller.
	 */
	async function assertVersion(
		def: AnyActionDefinition,
		input: unknown,
		ifMatch: number | undefined,
		db: DbExecutor,
	): Promise<void> {
		if (ifMatch === undefined) return;
		const target = def.target?.(input);
		const column = target?.versionColumn;
		if (!target || !column)
			throw new FamosError('bad_request', `${def.id} cannot be changed conditionally`);
		const row = await deps.views
			.db(ownerOf(def.id), db)
			.withTables<Record<string, RowWithId>>()
			.selectFrom(target.table)
			.select(column)
			.where(target.idColumn ?? 'id', '=', target.id)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'What this changes was not found');
		if (row[column] !== ifMatch)
			throw new FamosError('precondition_failed', 'It changed since you read it', {
				version: row[column],
			});
	}

	/** Whether the row an input points at (`target` of the action) is missing or no longer live. */
	async function targetIsGone(def: AnyActionDefinition, input: unknown): Promise<boolean> {
		if (!def.target) return false;
		try {
			const target = def.target(input);
			if (!target) return false;
			const tables = deps.views
				.db(ownerOf(def.id), deps.db)
				.withTables<Record<string, RowWithId>>();
			const idColumn = target.idColumn ?? 'id';
			let query = tables.selectFrom(target.table).select(idColumn).where(idColumn, '=', target.id);
			if (target.liveColumn) query = query.where(target.liveColumn, 'is', null);
			return (await query.executeTakeFirst()) === undefined;
		} catch (error) {
			// A table that cannot be read judges nothing: the suggestion is made as before.
			logger.warn({ err: error, action: def.id }, 'checking the target of a suggestion failed');
			return false;
		}
	}

	return { checkTarget, assertVersion, targetIsGone };
}

export type Targets = ReturnType<typeof createTargets>;
