<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { Dialog, IconButton, Menu, type MenuItem } from '@famos/ui/famos';
	import { BookmarkPlus, Ellipsis, Pencil, Plug, SquarePen, Trash2 } from '@lucide/svelte';
	import type { Thread } from '../contract/index.js';
	import { usedAgo } from './greeting.js';
	import { useAssistant } from './i18n.js';

	/**
	 * The member's conversations, as a quiet column: "New conversation" at the top, the threads
	 * (title and when it was last used; rename and delete in each row's menu), and at the foot the
	 * links to the assistant's memory and, for people who may use it, connected apps.
	 * The same list sits beside the chat on wide windows and in the drawer on narrower ones.
	 */
	let {
		threads,
		current,
		onopen,
		onnew,
		onrename,
		ondelete,
		heading = true,
	}: {
		threads: readonly Thread[];
		current: string | null;
		onopen: (id: string) => void;
		onnew: () => void;
		onrename: (id: string, title: string) => void | Promise<void>;
		ondelete: (id: string) => void | Promise<void>;
		/** False inside the drawer, whose own title already names the list. */
		heading?: boolean;
	} = $props();
	const { app, t } = useAssistant();
	const canConnect = $derived(app.can('core.mcp.use'));

	let editing = $state<string | null>(null);
	let draft = $state('');
	let deleting = $state<Thread | null>(null);

	const when = (ms: number) =>
		usedAgo(ms, {
			language: app.locale(),
			dateLocale: app.dateLocale(),
			timeZone: app.timeZone(),
			justNow: t('just_now'),
		});

	function edit(thread: Thread) {
		editing = thread.id;
		draft = thread.title;
	}

	async function save(thread: Thread) {
		const title = draft.trim();
		editing = null;
		if (title && title !== thread.title) await onrename(thread.id, title);
	}

	async function confirmDelete() {
		const thread = deleting;
		deleting = null;
		if (thread) await ondelete(thread.id);
	}

	function focusOnMount(node: HTMLInputElement) {
		node.focus();
		node.select();
	}

	const items = (thread: Thread): MenuItem[] => [
		{ id: 'rename', label: t('thread_rename'), icon: pencilIcon, onselect: () => edit(thread) },
		{
			id: 'delete',
			label: t('thread_delete'),
			icon: trashIcon,
			danger: true,
			onselect: () => (deleting = thread),
		},
	];
</script>

{#snippet pencilIcon()}<Pencil />{/snippet}
{#snippet trashIcon()}<Trash2 />{/snippet}

<div class="threads">
	<div class="list">
		<div class="head">
			{#if heading}
				<h2 class="text-ink-soft px-3 text-xs font-bold tracking-wide uppercase">{t('threads')}</h2>
			{:else}
				<span></span>
			{/if}
			<IconButton label={t('new_thread')} title={t('new_thread')} size="sm" onclick={onnew}>
				<SquarePen />
			</IconButton>
		</div>
		{#if threads.length === 0}
			<p class="text-ink-soft px-3 py-2 text-sm">{t('no_threads')}</p>
		{:else}
			<ul aria-label={t('threads')} class="grid gap-0.5">
				{#each threads as thread (thread.id)}
					<li class="item" class:open={current === thread.id}>
						{#if editing === thread.id}
							<form
								class="flex items-center gap-1.5 p-1"
								onsubmit={(event) => {
									event.preventDefault();
									void save(thread);
								}}
							>
								<input
									use:focusOnMount
									bind:value={draft}
									maxlength={80}
									aria-label={t('rename_thread')}
									class="bg-surface border-line h-[var(--ctl)] min-w-0 flex-1 rounded-[var(--r-ctl)] border px-3 text-[15px]"
									onkeydown={(event) => event.key === 'Escape' && (editing = null)}
								/>
								<Button type="submit" variant="secondary">{t('save')}</Button>
							</form>
						{:else}
							<button
								type="button"
								class="pick"
								aria-current={current === thread.id ? 'true' : undefined}
								onclick={() => onopen(thread.id)}
							>
								<span class="title">{thread.title}</span>
								<span class="when">{when(thread.updatedAt)}</span>
							</button>
							<span class="more">
								<Menu label={t('thread_options', { title: thread.title })} items={items(thread)}>
									{#snippet trigger({ attrs })}
										<IconButton
											label={t('thread_options', { title: thread.title })}
											size="sm"
											{...attrs}><Ellipsis /></IconButton
										>
									{/snippet}
								</Menu>
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<nav class="foot" aria-label={t('assistant')}>
		<a href="/settings/memory" class="link"><BookmarkPlus aria-hidden="true" />{t('memory_link')}</a
		>
		{#if canConnect}
			<a href="/settings/connected-apps" class="link"
				><Plug aria-hidden="true" />{t('use_own_agent')}</a
			>
		{/if}
	</nav>
</div>

<Dialog
	open={deleting !== null}
	title={t('delete_title')}
	description={t('delete_hint')}
	onclose={() => (deleting = null)}
>
	{#snippet actions()}
		<Button variant="ghost" data-autofocus onclick={() => (deleting = null)}>{t('cancel')}</Button>
		<Button variant="danger" onclick={() => void confirmDelete()}>{t('thread_delete')}</Button>
	{/snippet}
</Dialog>

<style>
	.threads {
		display: grid;
		grid-template-rows: minmax(0, 1fr) auto;
		gap: 16px;
		min-height: 100%;
	}
	.list {
		display: grid;
		align-content: start;
		gap: 6px;
		min-height: 0;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: var(--ctl);
	}
	.item {
		position: relative;
		display: flex;
		align-items: center;
		border-radius: var(--r-item);
		transition: background-color 150ms ease-out;
	}
	/* The open conversation looks like the shell sidebar's current page. */
	.item.open {
		background: var(--surface);
		box-shadow: var(--shadow-lit);
	}
	@media (hover: hover) {
		.item:not(.open):hover {
			background: color-mix(in oklab, var(--idle) 55%, transparent);
		}
	}
	/* With a mouse, a row's menu shows on hover and focus; on touch it is always there. */
	@media (hover: hover) and (pointer: fine) {
		.item:not(:hover, :focus-within) .more:not(:has([aria-expanded='true'])) {
			opacity: 0;
		}
	}
	.pick {
		display: grid;
		flex: 1;
		min-width: 0;
		gap: 1px;
		min-height: 52px;
		padding: 7px 4px 7px 12px;
		border: 0;
		border-radius: var(--r-item);
		background: none;
		color: var(--ink);
		font: inherit;
		text-align: start;
		cursor: pointer;
		outline: none;
	}
	.pick:focus-visible {
		box-shadow:
			0 0 0 2px var(--wall),
			0 0 0 4px var(--info);
	}
	.title {
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		line-height: 1.3;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.open .title {
		font-weight: 700;
	}
	.when {
		font-size: 13px;
		color: var(--ink-soft);
	}
	.more {
		flex: none;
		padding-inline-end: 4px;
	}
	.foot {
		display: grid;
		gap: 2px;
		padding-top: 12px;
		border-top: 1px solid var(--line);
	}
	.link {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 40px;
		padding: 0 12px;
		border-radius: var(--r-ctl);
		color: var(--ink-soft);
		font-size: 14px;
		font-weight: 600;
		text-decoration: none;
		outline: none;
	}
	.link :global(svg) {
		width: 18px;
		height: 18px;
		flex: none;
	}
	.link:hover {
		background: var(--idle);
		color: var(--ink);
	}
	.link:focus-visible {
		box-shadow:
			0 0 0 2px var(--wall),
			0 0 0 4px var(--info);
	}
	@media (prefers-reduced-motion: reduce) {
		.item {
			transition: none;
		}
	}
</style>
