<script lang="ts">
	import { unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import { Input } from '@famos/ui/input';
	import { Card, Section } from '@famos/ui/famos';
	import { Search } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { contributions, isAppPath } from '#lib/extensions.js';
	import { t, tDynamic } from '#lib/i18n.svelte.js';
	import { searchStatus } from '#lib/search-status.svelte.js';
	import { session } from '#lib/session.svelte.js';

	/**
	 * Search by meaning across what the family keeps. Shown only when an embedding model
	 * is set. Results are what this person may see; each links to the page of the entity.
	 */
	type Result = {
		id: string;
		kind: string;
		extension: string;
		title: string;
		snippet: string;
		href: string | null;
	};

	/** `floating`: results open in a panel below the field instead of pushing the page down. */
	let { floating = false }: { floating?: boolean } = $props();

	const configured = $derived(searchStatus.configured);
	let input = $state<HTMLInputElement | null>(null);
	let query = $state('');
	let results = $state<Result[] | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		void searchStatus.refresh();
	});

	// "/" jumps to the field when no input has focus (and the field is on screen).
	function onkeydown(e: KeyboardEvent) {
		if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
		const el = document.activeElement as HTMLElement | null;
		if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
		// Not when the field is hidden, or part of a picture (a style preview is inert).
		if (!input || input.offsetParent === null || input.closest('[inert]')) return;
		e.preventDefault();
		input.focus();
	}

	const label = (extension: string) => {
		const key = contributions.extension(extension)?.labelKey;
		return key ? tDynamic(key) : extension;
	};
	const linkOf = (result: Result) =>
		result.href && isAppPath(result.href.split('?')[0] ?? '', session.disabledExtensions)
			? result.href
			: null;

	async function run(event: SubmitEvent) {
		event.preventDefault();
		const q = query.trim();
		if (q.length < 2 || busy) return;
		busy = true;
		error = null;
		try {
			results = unwrap(
				await api.GET('/api/v1/core/search', { params: { query: { q, limit: 8 } } }),
			).results;
		} catch {
			results = null;
			error = t('search_failed');
		} finally {
			busy = false;
		}
	}
</script>

<svelte:window {onkeydown} />

{#if configured}
	<section
		class={floating ? 'relative grid gap-3' : 'grid gap-3'}
		aria-label={t('search_title')}
		data-testid="search"
	>
		<form class="flex gap-2" onsubmit={run} role="search">
			<Input
				type="search"
				bind:ref={input}
				bind:value={query}
				placeholder={t('search_placeholder')}
				aria-label={t('search_title')}
				autocomplete="off"
				maxlength={300}
			/>
			<Button type="submit" disabled={busy || query.trim().length < 2}>
				<Search class="size-4" aria-hidden="true" />
				<span class="sr-only md:not-sr-only">{t('search_button')}</span>
			</Button>
		</form>
		{#if error}<p class="text-attention font-semibold" role="alert">{error}</p>{/if}
		{#if results}
			<div
				class={floating
					? 'bg-surface shadow-lit absolute inset-x-0 top-full z-20 mt-2 max-h-96 overflow-y-auto rounded-xl border'
					: 'contents'}
			>
				{#if results.length === 0}
					<p class="text-ink-soft text-sm" data-testid="search-none">{t('search_none')}</p>
				{:else}
					<Section label={t('search_title')}>
						<Card rows>
							{#each results as result (`${result.kind}:${result.id}`)}
								{@const href = linkOf(result)}
								<svelte:element
									this={href ? 'a' : 'div'}
									{...href ? { href } : {}}
									class="grid min-h-13 gap-0.5 px-4 py-3"
									data-testid="search-result"
								>
									<span class="font-semibold">{result.title}</span>
									<span class="text-ink-soft text-xs">{label(result.extension)}</span>
									{#if result.snippet}
										<span class="text-ink-soft line-clamp-2 text-sm">{result.snippet}</span>
									{/if}
								</svelte:element>
							{/each}
						</Card>
					</Section>
				{/if}
			</div>
		{/if}
	</section>
{/if}
