<script lang="ts">
	import { findApp } from '../app-context.js';
	import { FIELD_REASON, fieldErrorId } from './field-errors.js';

	/**
	 * Why a field was refused, under the field: 13/600 in `attention`. `error` is the reason's
	 * translation key (from a form's `FieldErrors`); `for` is the field's input id, which points
	 * at this text with `aria-describedby` (`fieldAria`). Nothing when the field is fine.
	 */
	let { for: inputId, error }: { for: string; error?: string | undefined } = $props();
	const app = findApp();
	// A long text field already says "too long" in its counter; a second line would repeat it.
	const counted = $derived(
		error === FIELD_REASON.tooLong &&
			document.getElementById(inputId)?.hasAttribute('data-counted') === true,
	);
</script>

{#if error && !counted}
	<p
		id={fieldErrorId(inputId)}
		class="text-attention text-[13px] leading-snug font-semibold"
		data-testid="field-error"
	>
		{app ? app.t(error) : error}
	</p>
{/if}
