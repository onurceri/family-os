<script lang="ts">
	import Slot from '@famos/ui/slot';
	import type { FileTarget } from '../contract/index.js';
	import { FILE_LABELS, type FileLabel } from '../contract/index.js';
	import type { FileChoice } from './data.js';
	import { useInbox } from './i18n.js';

	/**
	 * Choose a record to file papers on ("Add to …"). The records come from the extensions that
	 * own them (the `inbox.fileTarget` slot); with none installed nothing is shown at all.
	 * Filing is a personal act: the Inbox does not read what is filed.
	 */
	let {
		value = $bindable(),
		openLabel,
		cancelLabel,
	}: { value: FileChoice | null; openLabel?: string; cancelLabel?: string } = $props();

	const { app, t } = useInbox();
	const available = $derived(app.slots('inbox.fileTarget').length > 0);
	let open = $state(false);
	let label = $state<FileLabel>('other');

	const selected = $derived<FileTarget | null>(
		value
			? { recordId: value.recordId, recordKind: value.recordKind, name: value.recordName }
			: null,
	);
	function select(target: FileTarget | null) {
		value = target
			? {
					recordId: target.recordId,
					recordKind: target.recordKind,
					recordName: target.name,
					label,
				}
			: null;
	}
	function setLabel(next: FileLabel) {
		label = next;
		if (value) value = { ...value, label: next };
	}
	function toggle() {
		open = !open;
		if (!open) value = null;
	}
</script>

{#if available}
	<div class="grid gap-2">
		<button
			type="button"
			aria-expanded={open}
			onclick={toggle}
			class="text-ink-soft hover:text-ink min-h-9 justify-self-start text-sm font-semibold underline-offset-4 hover:underline"
			>{open ? (cancelLabel ?? t('file_to_cancel')) : (openLabel ?? t('file_to_open'))}</button
		>
		{#if open}
			<div class="bg-idle grid gap-3 rounded-lg p-3">
				<p class="text-ink-soft text-sm">{t('file_to_hint')}</p>
				<Slot name="inbox.fileTarget" props={{ selected, onselect: select }} />
				<label class="grid gap-1 text-sm font-medium"
					>{t('file_to_label')}
					<select
						value={label}
						onchange={(e) => setLabel(e.currentTarget.value as FileLabel)}
						class="border-input h-11 max-w-60 rounded-md border bg-transparent px-2.5 text-base md:text-sm"
					>
						{#each FILE_LABELS as l (l)}<option value={l}>{t(`file_label_${l}`)}</option>{/each}
					</select>
				</label>
				{#if value}
					<p class="text-sm font-semibold" role="status">
						{t('file_to_chosen', { name: value.recordName })}
					</p>
				{/if}
			</div>
		{/if}
	</div>
{/if}
