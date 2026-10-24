<script lang="ts" generics="D extends DraftLike">
	import type { Component } from 'svelte';
	import { useApp } from '../app-context.js';
	import {
		draftByline,
		draftHeadline,
		draftKicker,
		insteadOffer,
		namedInput,
		type PresenterContext,
		proposedByMember,
		unavailableLine,
	} from '../slots.js';
	import DraftCard from './DraftCard.svelte';
	import { createDraftFlow, type DraftCalls, type DraftLike } from './draft-flow.svelte.js';

	/**
	 * A draft rendered by the presenter of the extension that owns its action, with the normal
	 * draft card. The page knows no extension: the presenter is looked up by action id. People who
	 * may approve decide here; everyone else sees "Waiting for approval".
	 */
	let {
		draft: given,
		calls,
		texts,
		compact = false,
		quiet = false,
		byline = true,
		groupLine,
		picked,
		onpick,
		pickLabel,
		oneditchange,
		onedit,
		onreplaced,
		suggestAgain = 'mark',
		nameSubject = true,
		showQuote = true,
		uncertainInEditor = true,
	}: {
		draft: D;
		/** The draft calls of the extension's own client (`draftClient(api)`). */
		calls: DraftCalls<D>;
		/** The words of the notices, in the extension's own catalog. */
		texts: { approved: string; error: string };
		compact?: boolean;
		/** A calm card instead of the alarm ring (in a group, or under an answer). */
		quiet?: boolean;
		/** Whether to say who asked, when it was somebody else (a group already names the sharer). */
		byline?: boolean;
		/** In a capture's group: the group's own line, which no card repeats as its title. */
		groupLine?: string;
		/** In a group: whether the suggestion is ticked, and what ticking does. */
		picked?: boolean;
		onpick?: (picked: boolean) => void;
		/** The tick's label for a suggestion of this name. */
		pickLabel?: (name: string) => string;
		oneditchange?: (editing: boolean) => void;
		/**
		 * In a group: called after the person's edit was saved on the server (`calls.edit`), with
		 * the saved input. The card itself approves nothing when it is saved: the group approves
		 * what is stored.
		 */
		onedit?: (input: unknown) => void;
		/**
		 * Called when the person chose the change the suggestion offered instead: an edit saved for
		 * what it was before no longer fits it.
		 */
		onreplaced?: () => void;
		/** What suggesting a taken-back draft again does (see `DraftFlowOptions.suggestAgain`). */
		suggestAgain?: 'swap' | 'mark';
		/** Whether the card names the thing it is about, even for a draft stored without its name. */
		nameSubject?: boolean;
		/** Whether the message the draft was read from is quoted under the card. */
		showQuote?: boolean;
		/** Whether the editor marks the fields the reading was unsure about. */
		uncertainInEditor?: boolean;
	} = $props();
	const app = useApp();
	const a = (key: string) => app.t(`app:${key}`);

	const flow = createDraftFlow<D>({
		given: () => given,
		get calls() {
			return calls;
		},
		get suggestAgain() {
			return suggestAgain;
		},
		texts: () => ({
			...texts,
			undo: a('draft_undo'),
			suggestedAgain: a('draft_suggested_again'),
		}),
		toast: (message, action) => app.toast(message, action),
		onreplaced: () => onreplaced?.(),
	});
	const draft = $derived(flow.draft);
	const status = $derived(flow.status);
	const presenter = $derived(app.draftPresenter(draft.actionId));
	const context = $derived<PresenterContext>({
		t: app.t,
		members: app.members(),
		formatLocale: app.formatLocale(),
		dateLocale: app.dateLocale(),
		weekStart: app.weekStart(),
		hourCycle: app.hourCycle(),
		timeZone: app.timeZone(),
	});
	$effect(() => {
		void given;
		flow.forgetSaved();
	});
	const input = $derived(
		(flow.saved ?? draft.editedInput ?? draft.input) as Record<string, unknown>,
	);
	const shown = $derived(
		nameSubject ? (namedInput(input, draft.subject) as Record<string, unknown>) : input,
	);
	// A draft addressed to me (a memory, a question) is mine to decide, whatever my role.
	const canDecide = $derived(
		!draft.unavailable &&
			(app.can('core.drafts.approve') ||
				(draft.forMember !== null && draft.forMember === app.me()?.id)),
	);
	const title = $derived(
		presenter?.title(shown, context) ??
			draftHeadline({
				summary: draft.summary,
				titleKey: draft.titleKey,
				actionId: draft.actionId,
				input: shown,
				subject: draft.subject,
				groupLine,
				t: app.t,
			}),
	);
	const mine = $derived(proposedByMember(draft.proposedBy, app.me()?.id));
	const asker = $derived(
		byline ? draftByline(draft, app.me()?.id, app.members(), app.t) : undefined,
	);
	const labels = $derived({
		approve: presenter?.approveLabel?.(context, shown) ?? a('draft_approve'),
		edit: a('draft_edit'),
		save: onedit ? a('draft_save_edit') : a('draft_save'),
		cancel: a('draft_cancel'),
		reject: a('draft_reject'),
		rejectConfirm: a('draft_reject_confirm'),
		checkThis: a('draft_check_this'),
		applied: draft.autoApproved
			? a('draft_auto_approved')
			: (presenter?.appliedLabel?.(context) ?? a('draft_applied')),
		rejected: a('draft_rejected'),
		retry: a('draft_retry'),
		waiting: draft.unavailable
			? unavailableLine(draft.unavailable, app.locale(), app.t)
			: a('draft_waiting'),
		undone: a('draft_undone'),
		expired: a('draft_expired'),
		gone: a('draft_gone'),
		settled: a('draft_settled'),
		approveConfirm: a('draft_approve_confirm'),
		withdrawn: a('draft_withdrawn'),
		withdraw: a('draft_withdraw'),
		undo: a('draft_undo'),
		suggestAgain: a('draft_suggest_again'),
		mayExist: a('draft_may_exist'),
		mayExistSome: a('draft_may_exist_some'),
		addAsNew: a('draft_add_as_new'),
	});
	const offer = $derived(
		insteadOffer({
			instead: draft.instead,
			presenter: draft.instead ? app.draftPresenter(draft.instead.actionId) : undefined,
			context,
			t: app.t,
		}),
	);

	let Editor = $state<Component<{
		input: unknown;
		context: PresenterContext;
		uncertain?: readonly string[];
		onchange(input: unknown): void;
	}> | null>(null);
	$effect(() => {
		const load = presenter?.editor;
		if (!load) return;
		void load().then((m) => (Editor = m.default as typeof Editor));
	});
</script>

<DraftCard
	kind={presenter?.kind(context) ?? draftKicker({ actionId: draft.actionId, t: app.t })}
	askedBy={asker}
	icon={presenter?.icon}
	{title}
	source={showQuote && draft.quote
		? app.t('app:draft_from_message', { quote: draft.quote })
		: undefined}
	fields={presenter?.fields(shown, context, draft.before) ?? []}
	uncertain={draft.uncertainFields}
	mayExist={draft.mayExist}
	mayExistSome={draft.mayExistSome}
	instead={offer && { ...offer, onchoose: () => void flow.choose() }}
	{status}
	error={flow.failed || draft.status === 'failed' ? a('draft_failed') : null}
	{labels}
	busy={flow.busy}
	{canDecide}
	{compact}
	oneditchange={(on) => {
		if (on) flow.edited = undefined;
		oneditchange?.(on);
	}}
	{quiet}
	selectable={onpick
		? {
				checked: picked ?? true,
				label: pickLabel ? pickLabel(title) : title,
				onchange: onpick,
			}
		: undefined}
	onapprove={() => flow.approve()}
	onreject={() => flow.reject()}
	reason={flow.reason}
	onwithdraw={mine && !canDecide ? () => flow.reject(true) : undefined}
	onsuggestagain={status === 'undone' && mine && flow.canSuggestAgain
		? () => void flow.suggestAgain()
		: undefined}
	onundo={status === 'applied' && flow.undoable && canDecide
		? () => void flow.undo(draft.id)
		: undefined}
	onsave={Editor
		? () => {
				if (!onedit) return void flow.approve(flow.edited);
				if (flow.edited === undefined) return;
				void flow.saveEdit(flow.edited, onedit);
			}
		: undefined}
>
	{#snippet editor()}
		{#if Editor}
			<Editor
				{input}
				{context}
				uncertain={uncertainInEditor ? draft.uncertainFields : undefined}
				onchange={(next: unknown) => (flow.edited = next)}
			/>
		{/if}
	{/snippet}
</DraftCard>
