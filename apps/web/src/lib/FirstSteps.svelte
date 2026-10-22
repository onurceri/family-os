<script lang="ts">
	import { ArrowRight, Check, X } from '@lucide/svelte';
	import { t } from '#lib/i18n.svelte.js';
	import { session } from '#lib/session.svelte.js';

	export interface Step {
		id: string;
		title: string;
		text: string;
		done: boolean;
		/** Where the step's action leads; omitted for the step that is always done. */
		href?: string;
		action?: string;
	}

	/**
	 * The first steps of a new family: one lit card with a row per step, each with its own link.
	 * Done steps get a check; the card goes away when all are done or the person hides it.
	 */
	let { steps, onhide }: { steps: readonly Step[]; onhide: () => void } = $props();
</script>

<section
	class="bg-surface shadow-lit relative grid gap-5 rounded-2xl p-5 sm:p-6"
	aria-labelledby="first-steps-title"
	data-testid="first-steps"
>
	<button
		type="button"
		onclick={onhide}
		aria-label={t('home_steps_hide')}
		title={t('home_steps_hide')}
		class="text-ink-soft hover:bg-idle focus-visible:ring-ring absolute top-2 right-2 grid size-11 place-items-center rounded-full focus-visible:ring-2 focus-visible:outline-none"
	>
		<X class="size-5" aria-hidden="true" />
	</button>
	<div class="grid max-w-prose gap-1.5 pr-8">
		<h2 id="first-steps-title" class="text-[22px] leading-tight font-extrabold tracking-tight">
			{t('home_steps_title')}
		</h2>
		<p class="text-ink-soft">{t('home_steps_text')}</p>
	</div>
	<ol class="grid gap-1">
		{#each steps as step, i (step.id)}
			<li class="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
				<span
					class="grid size-9 shrink-0 place-items-center rounded-full text-sm font-extrabold {step.done
						? 'bg-now text-on-color'
						: 'border-line text-ink-soft border-2'}"
					aria-hidden="true"
				>
					{#if step.done}<Check class="size-5" strokeWidth={3} />{:else}{i + 1}{/if}
				</span>
				<div class="grid min-w-0 flex-1 basis-56 gap-0.5">
					<b class="text-[15px] leading-snug font-bold">{step.title}</b>
					<span class="text-ink-soft text-[13px] leading-snug"
						>{step.done && !step.href ? t('home_step_done') : step.text}</span
					>
				</div>
				{#if step.href && step.action && !step.done}
					<a
						href={step.href}
						class="text-info focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg px-1 text-[15px] font-bold hover:underline focus-visible:ring-2 focus-visible:outline-none"
						>{step.action}<ArrowRight class="size-4" aria-hidden="true" /></a
					>
				{/if}
			</li>
		{/each}
	</ol>
	{#if session.can('core.settings.manage')}
		<a
			href="/settings/setup-status"
			class="text-info focus-visible:ring-ring inline-flex min-h-11 w-fit items-center gap-1.5 rounded-lg px-1 text-[15px] font-bold hover:underline focus-visible:ring-2 focus-visible:outline-none"
			>{t('setup_status_see_all')}<ArrowRight class="size-4" aria-hidden="true" /></a
		>
	{/if}
</section>
