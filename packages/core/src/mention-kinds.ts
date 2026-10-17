import {
	type Actor,
	type AiActionInfo,
	type AiAreaAccess,
	type AiKindInfo,
	type Clock,
	type DbExecutor,
	type FamilyReader,
	FamosError,
	findTarget,
	type IndexedMention,
	type Logger,
	MENTION_LIMIT,
	type MentionContext,
	type MentionEnv,
	type MentionKindDefinition,
	type MentionRecord,
	MentionSchema,
	REFUSAL_REASONS,
	type RefusalReason,
	type Resolution,
	resolvePeople,
} from '@famos/sdk';
import { clockTimes, dateWords, numericDateOrder, resolveDay, todayIn, zoned } from '@famos/time';
import type { Registry } from './registry.ts';

export interface MentionKindsDeps {
	registry: Registry;
	isOn(extensionId: string): boolean;
	areaAccess(extensionId: string): AiAreaAccess;
	aiCatalog(options: { local?: boolean; actor?: Actor }): AiActionInfo[];
	/** The extension's own tables, read-only. */
	readDb(extensionId: string): DbExecutor;
	family: FamilyReader;
	translate(locale: string, key: string, params?: Record<string, unknown>): string;
	vocabulary(key: string): readonly string[];
	clock: Clock;
	logger: Logger;
}

export interface MentionKinds {
	aiKinds(options?: { local?: boolean; actor?: Actor }): AiKindInfo[];
	resolveMentions(
		kindId: string,
		mentions: readonly IndexedMention[],
		env: MentionEnv,
		actor: Actor,
	): Promise<Resolution[]>;
}

interface OwnedKind {
	extension: string;
	kind: MentionKindDefinition;
}

const SUBJECT_MAX = 200;

const subjectText = (value: unknown): string | null =>
	typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, SUBJECT_MAX) : null;

const subjectOf = (m: IndexedMention) =>
	subjectText(m.mention.title) ?? subjectText(m.mention.target);

const refusal = (reason: RefusalReason, subject: string | null, from: readonly number[]) => ({
	refuse: { reason, subject, from },
});

const fromOf = (resolution: unknown): unknown => {
	if (typeof resolution !== 'object' || resolution === null) return undefined;
	const r = resolution as Record<string, { from?: unknown } | undefined>;
	return (r.propose ?? r.refuse)?.from;
};

/**
 * Holds what a resolver returned to its mentions: every given mention is in exactly one
 * resolution. A resolution that names no mention, one it was not given, or one an earlier
 * resolution already holds is left out (a resolver bug, logged); its mentions are then refused
 * with the others no resolution holds. A suggestion of an action the kind does not name is
 * refused. So a reading never yields more suggestions than mentions.
 */
export function settleResolutions(
	kind: MentionKindDefinition,
	given: readonly IndexedMention[],
	returned: readonly unknown[],
	logger: Logger,
): Resolution[] {
	const allowed = new Set(given.map((m) => m.index));
	const claimed = new Set<number>();
	const settled: Resolution[] = [];
	for (const resolution of returned) {
		const from = fromOf(resolution);
		const indexes = Array.isArray(from) ? (from as unknown[]) : [];
		const valid =
			indexes.length > 0 &&
			new Set(indexes).size === indexes.length &&
			indexes.every((i) => typeof i === 'number' && allowed.has(i) && !claimed.has(i));
		if (!valid) {
			logger.warn({ kind: kind.id }, 'a resolver returned a resolution its mentions do not back');
			continue;
		}
		const held = (indexes as number[]).toSorted((a, b) => a - b);
		for (const i of held) claimed.add(i);
		const r = resolution as Resolution;
		if ('propose' in r) {
			const p = r.propose;
			if (!kind.actions.includes(p.actionId)) {
				logger.warn(
					{ kind: kind.id, action: p.actionId },
					'a resolver proposed an action its kind does not name',
				);
				settled.push(refusal('incomplete', subjectText(p.subject), held));
				continue;
			}
			const uncertain = Array.isArray(p.uncertain)
				? [...new Set(p.uncertain.filter((f): f is string => typeof f === 'string'))]
				: [];
			const targetTitle = subjectText(p.targetTitle);
			settled.push({
				propose: {
					actionId: p.actionId,
					input: p.input,
					subject: subjectText(p.subject),
					...(targetTitle !== null && { targetTitle }),
					...(uncertain.length > 0 && { uncertain }),
					from: held,
				},
			});
		} else {
			const reason = (REFUSAL_REASONS as readonly string[]).includes(r.refuse.reason)
				? r.refuse.reason
				: 'incomplete';
			settled.push(refusal(reason, subjectText(r.refuse.subject), held));
		}
	}
	for (const m of given)
		if (!claimed.has(m.index)) settled.push(refusal('incomplete', subjectOf(m), [m.index]));
	return settled;
}

const firstOf = (r: Resolution) => Math.min(...('propose' in r ? r.propose : r.refuse).from);

/**
 * The mention kinds extensions declare, as the AI pipeline reaches them: which are offered for a
 * reading, and their resolvers run in their extension's read-only view.
 */
export function createMentionKinds(deps: MentionKindsDeps): MentionKinds {
	const all: OwnedKind[] = deps.registry.extensions.flatMap((e) =>
		(e.ai?.kinds ?? []).map((kind) => ({ extension: e.id, kind })),
	);
	const byId = new Map(all.map((k) => [k.kind.id, k]));

	const offered = (options: { local?: boolean; actor?: Actor } = {}) => {
		const catalog = new Set(deps.aiCatalog(options).map((a) => a.id));
		return all.filter(({ extension, kind }) => {
			if (!deps.isOn(extension)) return false;
			const area = deps.areaAccess(extension);
			if (area === 'off' || (area === 'local' && options.local !== true)) return false;
			return kind.actions.every((id) => catalog.has(id));
		});
	};

	const contextFor = async (extension: string, env: MentionEnv): Promise<MentionContext> => {
		const settings = await deps.family.settings();
		const members = (await deps.family.members()).map((m) => ({
			id: m.id,
			displayName: m.displayName,
		}));
		const now = deps.clock.now();
		const today = todayIn(settings.timeZone, now);
		const clock = zoned(now, settings.timeZone);
		const nowTime = `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
		const dateOrder = numericDateOrder(settings.formatLocale);
		// Read for each reading: a language pack installed since brings its words.
		const dates = dateWords(deps.vocabulary);
		const text = env.text;
		return {
			db: deps.readDb(extension),
			family: deps.family,
			translate: deps.translate,
			vocabulary: deps.vocabulary,
			today,
			now,
			timeZone: settings.timeZone,
			weekStart: settings.weekStart,
			dateOrder,
			hourCycle: settings.hourCycle,
			locale: settings.locale,
			formatLocale: settings.formatLocale,
			text,
			sharer: env.sharer,
			members,
			records: env.records,
			day: (ref, direction = 'future', time) =>
				resolveDay(ref, {
					today,
					weekStart: settings.weekStart,
					order: dateOrder,
					direction,
					time,
					now: nowTime,
					words: dates,
				}),
			time(mention) {
				const written = mention.timeText ? clockTimes(mention.timeText) : [];
				const [only] = written;
				if (written.length === 1 && only) return { time: only, certain: true };
				if (!mention.time) return null;
				// Several times written: the model's is certain only when it is one of them.
				if (written.length > 1)
					return { time: mention.time, certain: written.includes(mention.time) };
				// Digits without minutes or a 12-hour mark ("at 4"): morning or afternoon is a guess.
				const bareHour = settings.hourCycle === 'h12' && /\d/u.test(mention.timeText ?? '');
				return { time: mention.time, certain: !bareHour };
			},
			people: (mention) =>
				resolvePeople(mention, {
					members,
					sharer: env.sharer,
					text,
					locale: settings.locale,
				}),
			target: (targetWords, candidates) => findTarget(targetWords, candidates, { text }),
			record: (aboutWords, kinds) =>
				findTarget<MentionRecord>(
					aboutWords,
					kinds ? env.records.filter((r) => kinds.includes(r.kind)) : env.records,
					{ text },
				),
		};
	};

	return {
		aiKinds: (options) =>
			offered(options).map(({ extension, kind }) => ({
				id: kind.id,
				extension,
				describe: kind.describe,
				slots: kind.slots,
				...(kind.variants && { variants: kind.variants }),
				...(kind.knownFrom && { knownFrom: kind.knownFrom }),
				examples: kind.examples,
				limit: kind.limit ?? MENTION_LIMIT,
			})),

		async resolveMentions(kindId, mentions, env, actor) {
			if (actor.kind !== 'ai')
				throw new FamosError('forbidden', 'Only the AI reads mentions into suggestions');
			const owned = byId.get(kindId);
			const options = { local: actor.local === true, actor };
			if (!owned || !offered(options).includes(owned))
				throw new FamosError('forbidden', `The AI may not read "${kindId}" now`);
			if (mentions.length > MENTION_LIMIT)
				throw new FamosError('bad_request', `At most ${MENTION_LIMIT} mentions at a time`);
			const indexes = new Set<number>();
			for (const { index, mention } of mentions) {
				if (!Number.isInteger(index) || index < 0 || indexes.has(index))
					throw new FamosError('bad_request', 'Mentions need distinct indexes');
				indexes.add(index);
				if (!MentionSchema.safeParse(mention).success || mention.kind !== kindId)
					throw new FamosError('bad_request', `Every mention must be a "${kindId}" mention`);
			}
			const { kind, extension } = owned;
			const ordered = mentions.toSorted((a, b) => a.index - b.index);
			const limit = kind.limit ?? MENTION_LIMIT;
			const given = ordered.slice(0, limit);
			const beyond = ordered
				.slice(limit)
				.map((m) => refusal('incomplete', subjectOf(m), [m.index]));
			let returned: readonly unknown[] = [];
			if (given.length > 0) {
				try {
					const out: unknown = await kind.resolve(await contextFor(extension, env), given);
					if (Array.isArray(out)) returned = out;
					else deps.logger.warn({ kind: kindId }, 'a resolver returned no list');
				} catch (error) {
					deps.logger.error({ err: error, kind: kindId }, 'a resolver failed');
				}
			}
			return [...settleResolutions(kind, given, returned, deps.logger), ...beyond].toSorted(
				(a, b) => firstOf(a) - firstOf(b),
			);
		},
	};
}
