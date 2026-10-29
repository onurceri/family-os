<script lang="ts">
	import { tick } from 'svelte';
	import { cn } from '../utils.js';

	/**
	 * A text field with a searchable list of suggestions under it (WAI-ARIA combobox pattern),
	 * themed like the rest of the app. It replaces `<datalist>`, whose list the browser draws on
	 * its own, unstyled and away from the field. Typing filters the list; any text is allowed
	 * unless the caller validates it. Arrow keys move, Enter picks, Escape closes.
	 */
	type Option = { value: string; label?: string };
	let {
		id,
		value = $bindable(''),
		options,
		placeholder,
		class: className,
		invalid = false,
		max = 50,
		named = false,
		inputAttributes = {},
		onpick,
		onchange,
		'aria-label': ariaLabel,
		'aria-describedby': describedBy,
	}: {
		id: string;
		value?: string;
		options: readonly Option[];
		placeholder?: string;
		class?: string;
		invalid?: boolean;
		/** Most suggestions shown at once. */
		max?: number;
		/**
		 * While the field is not being edited, it shows the chosen option's name with its code after
		 * it ("Germany  de-DE"), not the code alone. Editing shows the code again.
		 */
		named?: boolean;
		inputAttributes?: Record<string, string | boolean>;
		/** After a suggestion was chosen (not on every keystroke). */
		onpick?: (value: string) => void;
		/** After typed text was committed (the field lost focus with a changed value). */
		onchange?: (value: string) => void;
		'aria-label'?: string;
		'aria-describedby'?: string;
	} = $props();

	let open = $state(false);
	/** Opened by focus or the arrow: list everything. Typing narrows it. */
	let browsing = $state(false);
	let active = $state(-1);
	let input: HTMLInputElement | undefined = $state();
	let focused = $state(false);
	const picked = $derived(
		named && !focused ? options.find((o) => o.value === value && o.label) : undefined,
	);
	let list: HTMLUListElement | undefined = $state();
	const listId = $derived(`${id}-list`);

	// `toLowerCase`, not `toLocaleLowerCase`: matching must not depend on the browser's language
	// (in Turkish, "I" lowers to a dotless "ı" and "INR" would no longer match "inr").
	const fold = (text: string) => text.trim().toLowerCase();
	/** How well an option matches: its code exactly, its code's start, a word's start, anywhere. */
	function rank(o: Option, query: string): number {
		const code = fold(o.value);
		const label = fold(o.label ?? '');
		if (code === query) return 0;
		if (code.startsWith(query)) return 1;
		if (label.startsWith(query)) return 2;
		if (label.split(/[\s(),.-]+/).some((word) => word.startsWith(query))) return 3;
		if (code.includes(query)) return 4;
		if (label.includes(query)) return 5;
		return -1;
	}
	const shown = $derived.by(() => {
		const query = fold(value);
		if (!query || browsing) return options.slice(0, max);
		return options
			.map((o, i) => ({ o, i, r: rank(o, query) }))
			.filter((m) => m.r >= 0)
			.sort((a, b) => a.r - b.r || a.i - b.i)
			.slice(0, max)
			.map((m) => m.o);
	});

	function show() {
		browsing = true;
		open = true;
		active = shown.findIndex((o) => o.value === value);
	}

	async function pick(option: Option) {
		value = option.value;
		open = false;
		active = -1;
		onpick?.(option.value);
		await tick();
		input?.focus();
	}

	async function move(step: number) {
		if (!open) show();
		if (shown.length === 0) return;
		active = (active + step + shown.length) % shown.length;
		await tick();
		list?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			void move(1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			void move(-1);
		} else if (event.key === 'Enter' && open && shown[active]) {
			event.preventDefault();
			void pick(shown[active] as Option);
		} else if (event.key === 'Escape' && open) {
			event.preventDefault();
			open = false;
		}
	}
</script>

<div class={cn('relative', className)}>
	<div class="relative">
		<input
			bind:this={input}
			{id}
			bind:value
			{placeholder}
			role="combobox"
			aria-autocomplete="list"
			aria-expanded={open}
			aria-controls={listId}
			aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
			aria-invalid={invalid ? 'true' : undefined}
			aria-label={ariaLabel}
			aria-describedby={describedBy}
			autocomplete="off"
			spellcheck={false}
			{...inputAttributes}
			class={cn(
				'bg-idle text-ink placeholder:text-ink-soft focus-visible:ring-info aria-invalid:ring-attention h-[var(--ctl)] w-full rounded-[var(--r-ctl)] border-0 pr-10 pl-3 text-[15px] outline-none focus-visible:ring-2 aria-invalid:ring-2',
				picked && 'text-transparent',
			)}
			onfocus={() => {
				focused = true;
				show();
			}}
			oninput={() => {
				browsing = false;
				// A code typed in full stays listed, first and active, so its name shows and Enter
				// takes it.
				open = true;
				active = shown.length > 0 && rank(shown[0] as Option, fold(value)) === 0 ? 0 : -1;
			}}
			onchange={() => onchange?.(value)}
			onblur={() => {
				focused = false;
				// Let a click on an option land first.
				setTimeout(() => (open = false), 120);
			}}
			{onkeydown}
		/>
		{#if picked}
			<span
				aria-hidden="true"
				class="pointer-events-none absolute inset-y-0 right-10 left-3 flex items-center gap-2 overflow-hidden text-[15px] whitespace-nowrap"
				><span class="text-ink truncate">{picked.label}</span><span
					class="text-ink-soft shrink-0 text-[13px]">{picked.value}</span
				></span
			>
		{/if}
		<button
			type="button"
			tabindex="-1"
			aria-hidden="true"
			class="text-ink-soft absolute inset-y-0 right-0 grid w-10 place-items-center"
			onmousedown={(e) => {
				e.preventDefault();
				if (open) open = false;
				else {
					input?.focus();
					show();
				}
			}}
			><svg
				class="size-4"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg
			></button
		>
	</div>
	{#if open && shown.length > 0}
		<ul
			bind:this={list}
			id={listId}
			role="listbox"
			class="bg-surface shadow-lit absolute inset-x-0 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-xl border p-1"
		>
			{#each shown as option, i (option.value)}
				<li
					id="{id}-opt-{i}"
					data-index={i}
					role="option"
					aria-selected={option.value === value}
					class="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm {i ===
					active
						? 'bg-idle'
						: ''} {option.value === value ? 'font-bold' : ''}"
					onmousedown={(e) => {
						e.preventDefault();
						void pick(option);
					}}
				>
					<span class="shrink-0">{option.value}</span>
					{#if option.label}<span class="text-ink-soft truncate">{option.label}</span>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
