<script lang="ts">
	import {
		Card,
		FIELD_REASON,
		fieldAria,
		FieldError,
		focusFirstInvalid,
		SwitchRow,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { t } from '#lib/i18n.svelte.js';

	/**
	 * What a display is told at pairing, and can be changed later: its name, what it may
	 * show, whether it shows names. The caller submits it (the panel's Save, or the step's button)
	 * through the element it binds.
	 */
	type Option = { id: string; label: string };

	let {
		idPrefix,
		options,
		name = $bindable(),
		capabilities = $bindable(),
		showNames = $bindable(),
		error = null,
		onsubmit,
		form = $bindable(),
	}: {
		idPrefix: string;
		options: Option[];
		name: string;
		capabilities: string[];
		showNames: boolean;
		error?: string | null;
		onsubmit: () => void;
		form?: HTMLFormElement | undefined;
	} = $props();

	// The name's reason shows from the first refused submit on, and goes once it is typed.
	let tried = $state(false);
	const nameError = $derived(tried && !name.trim() ? FIELD_REASON.name : undefined);

	function toggle(id: string) {
		capabilities = capabilities.includes(id)
			? capabilities.filter((c) => c !== id)
			: [...capabilities, id];
	}
</script>

<form
	class="grid gap-5"
	bind:this={form}
	novalidate
	onsubmit={(event) => {
		event.preventDefault();
		tried = true;
		if (!name.trim()) {
			void focusFirstInvalid(event.currentTarget);
			return;
		}
		onsubmit();
	}}
>
	<div class="grid gap-1.5">
		<Label for="{idPrefix}-name">{t('devices_display_name')}</Label>
		<Input
			id="{idPrefix}-name"
			bind:value={name}
			required
			maxlength={60}
			placeholder={t('devices_display_name_placeholder')}
			{...fieldAria(nameError, `${idPrefix}-name`)}
		/>
		<FieldError for="{idPrefix}-name" error={nameError} />
	</div>
	<fieldset class="grid gap-2">
		<legend class="text-ink-soft mb-1 text-xs font-bold tracking-[0.06em] uppercase"
			>{t('devices_display_shows')}</legend
		>
		<Card rows>
			{#each options as option (option.id)}
				<label class="flex min-h-12 cursor-pointer items-center gap-3 px-4">
					<input
						type="checkbox"
						class="accent-ink size-5 shrink-0"
						checked={capabilities.includes(option.id)}
						onchange={() => toggle(option.id)}
					/>
					<span class="font-semibold">{option.label}</span>
				</label>
			{/each}
			<SwitchRow
				id="{idPrefix}-names"
				label={t('devices_display_names')}
				hint={t('devices_display_names_hint')}
				bind:checked={showNames}
			/>
		</Card>
	</fieldset>
	{#if error}<p class="text-attention text-sm font-semibold" role="alert">{error}</p>{/if}
</form>
