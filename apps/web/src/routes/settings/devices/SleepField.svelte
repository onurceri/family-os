<script lang="ts">
	import { Card, fieldAria, FieldError, SwitchRow } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { t } from '#lib/i18n.svelte.js';
	import { sleepProblem } from './sleep-field.js';

	/**
	 * The hours a screen or a family device goes dark: a switch and, when it is on, From and Until
	 * (the family's time zone; the window may cross midnight). One component for the pairing
	 * step, the family-device step and the device's panel; the caller saves it.
	 */
	let {
		idPrefix,
		on = $bindable(false),
		from = $bindable(),
		until = $bindable(),
		onchange,
		ontimes,
	}: {
		idPrefix: string;
		on?: boolean;
		from: string;
		until: string;
		/** The switch was flipped. */
		onchange?: (on: boolean) => void;
		/** A time was changed (a panel that applies at once saves here). */
		ontimes?: () => void;
	} = $props();

	const same = $derived(sleepProblem({ on, from, until }));
	const reason = $derived(same ? 'app:devices_sleep_same' : undefined);
</script>

<Card rows>
	<SwitchRow
		id="{idPrefix}-sleep"
		label={t('devices_sleep')}
		hint={t('devices_sleep_hint')}
		bind:checked={on}
		{onchange}
	/>
	{#if on}
		<div class="grid gap-2 px-4 py-3">
			<div class="flex flex-wrap items-center gap-4">
				<label class="flex items-center gap-2 font-semibold">
					{t('devices_sleep_from')}
					<Input
						id="{idPrefix}-sleep-from"
						type="time"
						class="w-auto"
						bind:value={from}
						onchange={ontimes}
					/>
				</label>
				<label class="flex items-center gap-2 font-semibold">
					{t('devices_sleep_until')}
					<Input
						id="{idPrefix}-sleep-until"
						type="time"
						class="w-auto"
						bind:value={until}
						onchange={ontimes}
						{...fieldAria(reason, `${idPrefix}-sleep-until`)}
					/>
				</label>
			</div>
			<FieldError for="{idPrefix}-sleep-until" error={reason} />
		</div>
	{/if}
</Card>
