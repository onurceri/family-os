<script lang="ts">
	import { isApiError } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import { firstName, IconButton, Page, SidePanel } from '@famos/ui/famos';
	import {
		CalendarDays,
		List,
		ListChecks,
		MessagesSquare,
		ShoppingCart,
		Sparkles,
		SquarePen,
	} from '@lucide/svelte';
	import { tick, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { Message, Thread } from '../contract/index.js';
	import AnswerCard from './AnswerCard.svelte';
	import AnswerDrafts from './AnswerDrafts.svelte';
	import AnswerText from './AnswerText.svelte';
	import AskField from './AskField.svelte';
	import {
		deleteThread,
		isOpen,
		loadThread,
		loadThreads,
		renameThread,
		sendMessage,
	} from './data.js';
	import { greetingKey, hourIn, SUGGESTIONS, type SuggestionArea } from './greeting.js';
	import { useAssistant } from './i18n.js';
	import { openPath } from './nav.js';
	import { reduceStream, type StreamState, settleStream } from './stream.js';
	import ThreadList from './ThreadList.svelte';

	/**
	 * The Ask page, in the chat template: a conversation column (760 px) and the
	 * conversation list, a pane at the frame's left edge from 1280 px (the frame's `aside`), a
	 * drawer below that. A new conversation is a greeting (the first name), the message box and four
	 * suggestions, a third down the page; a conversation flows top to bottom
	 * with the message box pinned to the bottom. Answers stream in from the member-targeted events
	 * and are plain text; changes the assistant proposes show under its answer as draft cards.
	 */
	const { app, t } = useAssistant();
	let threads = $state<Thread[]>([]);
	let current = $state<string | null>(null);
	let messages = $state<Message[]>([]);
	let streams = $state<StreamState>({});
	let text = $state('');
	let sending = $state(false);
	/** Answers the member stopped waiting for: the indicator is hidden, the job continues. */
	let stopped = $state<string[]>([]);
	let drawer = $state(false);
	let composer = $state<HTMLTextAreaElement>();
	let end = $state<HTMLElement>();
	let pinned = true;
	/** From 1280 px the conversations are a column of the page, not a drawer. */
	const roomy = new MediaQuery('min-width: 80rem', false);

	const FAILURES: Record<string, Parameters<typeof t>[0]> = {
		disabled: 'failed_disabled',
		not_configured: 'failed_not_configured',
		limit_reached: 'failed_limit_reached',
		auth: 'failed_auth',
		data_policy: 'failed_data_policy',
		local_required: 'failed_local_required',
		timeout: 'failed_timeout',
		no_answer: 'failed_no_answer',
		forbidden: 'failed_forbidden',
	};
	const ICONS: Record<SuggestionArea, typeof CalendarDays> = {
		calendar: CalendarDays,
		shopping: ShoppingCart,
		tasks: ListChecks,
		list: List,
	};
	const failure = (code: string | null) => t(FAILURES[code ?? ''] ?? 'failed_other');
	const waiting = $derived(messages.some((m) => isOpen(m) && !stopped.includes(m.id)));
	const title = $derived(threads.find((thread) => thread.id === current)?.title);
	const isAdmin = $derived(app.can('core.ai.manage'));
	const empty = $derived(messages.length === 0);
	/** "Good morning, Sofia.": the first name, unless someone else in the family shares it. */
	const greeting = $derived(
		t(greetingKey(hourIn(app.timeZone())), { name: firstName(app.members(), app.me()) }),
	);
	const coarse = () => matchMedia('(pointer: coarse)').matches;

	/** The last question, asked again after a failure. */
	const lastQuestion = $derived(messages.findLast((m) => m.role === 'user')?.content);
	const lastFailed = $derived(messages.at(-1)?.status === 'failed' ? messages.at(-1)?.id : null);

	const remembered = () => `famos.assistant.thread.${app.me()?.id ?? ''}`;
	function remember(id: string | null) {
		try {
			if (id) localStorage.setItem(remembered(), id);
			else localStorage.removeItem(remembered());
		} catch {
			// Storage can be blocked; the page then simply starts empty.
		}
	}
	const saved = () => {
		try {
			return localStorage.getItem(remembered());
		} catch {
			return null;
		}
	};

	async function refreshThreads() {
		try {
			threads = await loadThreads();
		} catch {
			app.toast(t('error'));
		}
	}

	/** The open conversation is in the address (`?thread=`), so a link opens it and Back works. */
	const threadInUrl = () => new URLSearchParams(location.search).get('thread');
	function show(id: string | null) {
		if (threadInUrl() === id) return;
		openPath(id ? `/assistant?thread=${id}` : '/assistant');
	}
	function onpopstate() {
		const id = threadInUrl();
		if (id !== current) void open(id, false);
	}

	async function open(id: string | null, sync = true) {
		current = id;
		remember(id);
		if (sync) show(id);
		streams = {};
		stopped = [];
		messages = [];
		drawer = false;
		pinned = true;
		if (id) await refresh(id);
		else void focusComposer();
	}

	async function refresh(id: string) {
		try {
			const detail = await loadThread(id);
			if (current !== id) return;
			messages = detail.messages;
			streams = settleStream(streams, new Set(detail.messages.filter(isOpen).map((m) => m.id)));
		} catch {
			// A deleted thread: back to the empty state.
			if (current === id) await open(null);
		}
	}

	async function focusComposer() {
		await tick();
		if (!coarse()) composer?.focus();
	}

	async function send(question = text.trim()) {
		if (!question || sending || waiting) return;
		sending = true;
		try {
			const sent = await sendMessage(question, current ?? undefined);
			text = '';
			if (current !== sent.threadId) {
				current = sent.threadId;
				remember(sent.threadId);
				show(sent.threadId);
			}
			pinned = true;
			await Promise.all([refresh(sent.threadId), refreshThreads()]);
		} catch (error) {
			app.toast(isApiError(error) && error.code === 'conflict' ? t('busy') : t('error'));
		} finally {
			sending = false;
		}
	}

	async function rename(id: string, name: string) {
		try {
			await renameThread(id, name);
			await refreshThreads();
		} catch {
			app.toast(t('error'));
		}
	}

	async function remove(id: string) {
		try {
			await deleteThread(id);
			if (current === id) await open(null);
			await refreshThreads();
			app.toast(t('deleted'));
		} catch {
			app.toast(t('error'));
		}
	}

	function onScroll() {
		pinned = innerHeight + scrollY >= document.documentElement.scrollHeight - 96;
	}

	$effect(() => {
		// `?q=` arrives from a link (the Inbox's "Ask the assistant"): it fills the composer and
		// is dropped from the address; the person presses send.
		const prefill = untrack(() => {
			const q = app.query().get('q')?.trim();
			if (q) app.setQuery({ q: null }, { replace: true });
			return q;
		});
		if (prefill) text = prefill;
		void refreshThreads().then(() => {
			const wanted = Boolean(prefill) || new URLSearchParams(location.search).has('ask');
			const id = threadInUrl() ?? saved();
			if ((wanted && !threadInUrl()) || !id || !threads.some((thread) => thread.id === id)) {
				if (wanted) void tick().then(() => composer?.focus());
				return;
			}
			void open(id, false);
		});
		// Answers arrive over the WebSocket for this member only; polling below covers a dropped one.
		return app.onEvent('assistant.', (name, payload) => {
			const event = payload as {
				threadId: string;
				messageId: string;
				text?: string;
				reset?: boolean;
			};
			if (event.threadId !== current) return;
			if (name === 'assistant.delta')
				streams = reduceStream(streams, {
					kind: 'delta',
					messageId: event.messageId,
					text: event.text ?? '',
					reset: event.reset,
				});
			if (name === 'assistant.done') {
				void refresh(event.threadId).then(() => {
					if (!coarse() && (!document.activeElement || document.activeElement === document.body))
						void focusComposer();
				});
				void refreshThreads();
			}
		});
	});

	// A dropped WebSocket must not strand the answer: poll while one is being written, for at most
	// two minutes (a job that never runs must not keep a page polling for hours).
	$effect(() => {
		if (!current || !messages.some(isOpen)) return;
		const id = current;
		let left = 40;
		const timer = setInterval(() => {
			if (--left <= 0) clearInterval(timer);
			void refresh(id);
		}, 3000);
		return () => clearInterval(timer);
	});

	// Follow the answer as it grows, unless the member scrolled up to read.
	$effect(() => {
		void messages;
		void streams;
		if (!pinned || empty) return;
		void tick().then(() => end?.scrollIntoView({ block: 'end' }));
	});
</script>

<svelte:window {onpopstate} onscroll={onScroll} />

{#snippet threadList(heading = true)}
	<ThreadList
		{heading}
		{threads}
		{current}
		onopen={(id) => void open(id)}
		onnew={() => void open(null)}
		onrename={rename}
		ondelete={remove}
	/>
{/snippet}

{#snippet field()}
	<AskField
		bind:value={text}
		bind:field={composer}
		disabled={waiting}
		busy={sending}
		onsend={() => void send()}
	/>
{/snippet}

{#snippet history()}
	<aside class="side" aria-label={t('threads')}>
		{@render threadList()}
	</aside>
{/snippet}

<Page template="chat" aside={roomy.current ? history : undefined}>
	<section class="chat" aria-label={t('title')}>
		<header class="flex min-h-[var(--ctl)] items-center gap-1">
			<h1
				class="type-page min-w-0 flex-1"
				class:sr-only={empty && roomy.current}
				class:thread-title={Boolean(title)}
			>
				{title ?? t('title')}
			</h1>
			{#if !roomy.current}
				<Button variant="ghost" onclick={() => (drawer = true)} aria-expanded={drawer}>
					<MessagesSquare aria-hidden="true" />{t('threads')}
				</Button>
				<IconButton label={t('new_thread')} onclick={() => void open(null)}>
					<SquarePen />
				</IconButton>
			{/if}
		</header>

		{#if empty}
			<div class="start">
				<div class="start-body">
					<div class="grid gap-3 text-center">
						<p class="type-greeting">{greeting}</p>
						<p class="text-ink-soft text-[16px]">{t('greeting_hint')}</p>
					</div>
					{@render field()}
					<ul class="suggestions" aria-label={t('examples')}>
						{#each SUGGESTIONS as suggestion (suggestion.area)}
							{@const Icon = ICONS[suggestion.area]}
							<li>
								<button
									type="button"
									class="suggestion"
									disabled={sending}
									onclick={() => void send(t(suggestion.question))}
								>
									<Icon class="icon" aria-hidden="true" />
									<span class="grid gap-0.5">
										<span class="text-[15px] font-bold">{t(suggestion.title)}</span>
										<span class="text-ink-soft text-[14px] leading-snug"
											>{t(suggestion.question)}</span
										>
									</span>
								</button>
							</li>
						{/each}
					</ul>
					<p class="text-ink-soft text-center text-[13px] leading-relaxed">
						{t('privacy_line')}
						·
						{#if isAdmin}
							<a href="/settings/ai" class="quiet-link">{t('privacy_link')}</a>
						{:else}
							{t('privacy_link_plain')}
						{/if}
					</p>
				</div>
			</div>
		{:else}
			<ol class="messages" role="log" aria-live="polite" aria-label={t('conversation')}>
				{#each messages as message (message.id)}
					{@const running = isOpen(message)}
					{@const ids = message.toolCalls.flatMap((c) => (c.draftId ? [c.draftId] : []))}
					{#if message.role === 'user'}
						<li class="mine" data-role="user">
							<span class="sr-only">{t('you')}:</span>
							<p class="bubble">{message.content}</p>
						</li>
					{:else}
						<li class="theirs" data-role="assistant">
							<span class="mark" aria-hidden="true"><Sparkles /></span>
							<div class="min-w-0">
								<span class="sr-only">{t('assistant')}:</span>
								{#if message.status === 'failed'}
									<p class="text-attention font-semibold" role="alert">
										{failure(message.errorCode)}
									</p>
									{#if isAdmin && message.errorCode === 'data_policy'}
										<a href="/settings/ai/privacy" class="quiet-link text-sm"
											>{t('open_ai_privacy')}</a
										>
									{/if}
									{#if lastFailed === message.id && lastQuestion}
										<Button
											type="button"
											variant="outline"
											class="mt-3"
											disabled={sending}
											onclick={() => void send(lastQuestion)}>{t('ask_again')}</Button
										>
									{/if}
								{:else if running}
									{#if streams[message.id]}
										<AnswerText text={streams[message.id] ?? ''} />
									{:else if message.content}
										<AnswerText text={message.content} />
									{/if}
									{#if stopped.includes(message.id)}
										<p class="text-ink-soft text-sm">{t('stopped_waiting')}</p>
									{:else}
										<p class="text-ink-soft flex min-h-9 items-center gap-2 text-sm" role="status">
											<span class="dots" aria-hidden="true"
												><span></span><span></span><span></span></span
											>
											{t('typing')}
											<Button
												variant="ghost"
												size="sm"
												class="ml-auto"
												onclick={() => (stopped = [...stopped, message.id])}
												>{t('stop_waiting')}</Button
											>
										</p>
									{/if}
								{:else}
									<div class="grid gap-3">
										{#if message.content}<AnswerText text={message.content} />{/if}
										{#each message.cards as card, i (i)}<AnswerCard {card} />{/each}
									</div>
								{/if}
								{#if ids.length > 0}
									<AnswerDrafts messageId={message.id} {ids} lines={message.suggested} />
								{/if}
							</div>
						</li>
					{/if}
				{/each}
			</ol>
			<div bind:this={end} class="scroll-mb-56"></div>
			<div class="dock">{@render field()}</div>
		{/if}
	</section>
</Page>

{#if !roomy.current}
	<!-- Below 1280 px the conversations open in a drawer (a sheet on a phone). -->
	<SidePanel
		open={drawer}
		title={t('threads')}
		closeLabel={t('close')}
		onclose={() => (drawer = false)}
	>
		{@render threadList(false)}
	</SidePanel>
{/if}

<style>
	/* The chat template fills the window, so the message box sits at the bottom even in a short
	   conversation (`--chat-dock`, `--shell-top` come from the frame). */
	.chat {
		/* The strip between the message box and the tab bar. */
		--under: 0.5rem;
	}
	@media (min-width: 48rem) {
		.chat {
			--under: 1rem;
		}
	}
	.side {
		position: sticky;
		top: var(--shell-top);
		height: calc(100dvh - var(--shell-top) - var(--chat-dock));
		overflow-y: auto;
		/* Room for the focus rings. */
		padding: 2px;
		margin: -2px;
	}
	/* A conversation's name can be long: two lines at most, smaller on a phone. */
	.thread-title {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow-wrap: anywhere;
	}
	@media (width < 48rem) {
		.thread-title {
			font-size: 1.25rem;
		}
	}
	h1:not(.thread-title) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chat {
		display: flex;
		flex-direction: column;
		gap: 16px;
		min-width: 0;
	}
	/* A new conversation sits at the optical centre, a third down (the room above it is half the
	   room below), so it relates to the top of the history beside it. */
	.start {
		display: grid;
		flex: 1;
		grid-template-rows: 1fr auto 2fr;
		padding-block: 8px 24px;
	}
	.start-body {
		display: grid;
		grid-row: 2;
		gap: 24px;
	}
	.suggestions {
		display: grid;
		gap: 10px;
	}
	@media (min-width: 40rem) {
		.suggestions {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.suggestion {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		width: 100%;
		height: 100%;
		padding: 14px 16px;
		border: 0;
		border-radius: var(--r-card);
		background: var(--surface);
		box-shadow: inset 0 0 0 1px var(--line);
		color: var(--ink);
		font: inherit;
		text-align: start;
		cursor: pointer;
		outline: none;
		transition:
			box-shadow 150ms ease-out,
			background-color 150ms ease-out;
	}
	.suggestion :global(.icon) {
		flex: none;
		width: 20px;
		height: 20px;
		margin-top: 1px;
		color: var(--ink-soft);
	}
	@media (hover: hover) {
		.suggestion:hover {
			box-shadow:
				var(--shadow-lit),
				inset 0 0 0 1px color-mix(in oklab, var(--ink) 25%, var(--line));
		}
		.suggestion:hover :global(.icon) {
			color: var(--ink);
		}
	}
	.suggestion:focus-visible {
		box-shadow:
			0 0 0 2px var(--wall),
			0 0 0 4px var(--info);
	}
	.suggestion:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	.quiet-link {
		color: var(--ink);
		font-weight: 600;
		text-decoration: underline;
		text-decoration-color: var(--line);
		text-decoration-thickness: 1.5px;
		text-underline-offset: 3px;
		border-radius: 4px;
		outline: none;
	}
	.quiet-link:hover {
		text-decoration-color: currentColor;
	}
	.quiet-link:focus-visible {
		box-shadow:
			0 0 0 2px var(--wall),
			0 0 0 4px var(--info);
	}
	.messages {
		display: grid;
		flex: 1;
		align-content: start;
		gap: 24px;
		padding-block: 8px 16px;
	}
	.mine {
		display: flex;
		justify-content: flex-end;
		padding-inline-start: 15%;
	}
	.bubble {
		min-width: 0;
		padding: 10px 16px;
		background: var(--surface);
		border-radius: 18px;
		border-end-end-radius: 6px;
		box-shadow: inset 0 0 0 1px var(--line);
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	.theirs {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr);
		gap: 12px;
		line-height: 1.55;
	}
	.mark {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 999px;
		background: color-mix(in oklab, var(--accent) 22%, transparent);
		color: color-mix(in oklab, var(--accent) 70%, var(--ink));
	}
	.mark :global(svg) {
		width: 16px;
		height: 16px;
	}
	.dots {
		display: inline-flex;
		gap: 4px;
	}
	.dots span {
		width: 6px;
		height: 6px;
		border-radius: 999px;
		background: var(--ink-soft);
		animation: blink 1.2s ease-in-out infinite;
	}
	.dots span:nth-child(2) {
		animation-delay: 0.2s;
	}
	.dots span:nth-child(3) {
		animation-delay: 0.4s;
	}
	@keyframes blink {
		0%,
		80%,
		100% {
			opacity: 0.3;
		}
		40% {
			opacity: 1;
		}
	}
	.dock {
		position: sticky;
		bottom: var(--chat-dock);
		z-index: 10;
		padding-top: 20px;
		background: linear-gradient(to bottom, transparent, var(--wall) 20px);
	}
	/* The page background continues under the box down to the tab bar, so nothing shows there. */
	.dock::after {
		content: '';
		position: absolute;
		inset-inline: 0;
		top: 100%;
		height: var(--under);
		background: var(--wall);
	}
	@media (prefers-reduced-motion: reduce) {
		.dots span {
			animation: none;
			opacity: 0.6;
		}
		.suggestion {
			transition: none;
		}
	}
</style>
