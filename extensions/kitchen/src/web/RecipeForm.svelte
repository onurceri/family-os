<script lang="ts">
	import { FieldError, type FieldErrors, fieldAria } from '@famos/ui/famos';
	import { Textarea } from '@famos/ui/textarea';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import type { RecipeFormValue } from './form.js';
	import { useKitchen } from './i18n.js';

	/** The recipe form: ingredients and steps are written one per line. */
	let {
		value = $bindable(),
		errors = {},
		idPrefix = 'recipe',
	}: { value: RecipeFormValue; errors?: FieldErrors; idPrefix?: string } = $props();

	const { t } = useKitchen();
	const id = (name: string) => `${idPrefix}-${name}`;
	const area =
		'border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 md:text-sm';
</script>

<div class="@container grid gap-4">
	<div class="grid gap-1.5">
		<Label for={id('title')}>{t('field_title')}</Label>
		<Input
			id={id('title')}
			bind:value={value.title}
			maxlength={160}
			required
			autocomplete="off"
			{...fieldAria(errors.title, id('title'))}
		/>
		<FieldError for={id('title')} error={errors.title} />
	</div>

	<div class="grid gap-4 @lg:grid-cols-2">
		<div class="grid gap-1.5">
			<Label for={id('servings')}>{t('field_servings')}</Label>
			<Input id={id('servings')} bind:value={value.servings} maxlength={30} autocomplete="off" />
			<small class="text-ink-soft text-xs">{t('field_servings_hint')}</small>
		</div>
		<div class="grid gap-1.5">
			<Label for={id('minutes')}>{t('field_minutes')}</Label>
			<Input
				id={id('minutes')}
				bind:value={value.minutes}
				inputmode="numeric"
				maxlength={5}
				autocomplete="off"
			/>
		</div>
	</div>

	<div class="grid gap-1.5">
		<Label for={id('ingredients')}>{t('field_ingredients')}</Label>
		<textarea id={id('ingredients')} bind:value={value.ingredients} rows={6} class={area}
		></textarea>
		<small class="text-ink-soft text-xs">{t('field_ingredients_hint')}</small>
	</div>

	<div class="grid gap-1.5">
		<Label for={id('steps')}>{t('field_steps')}</Label>
		<textarea id={id('steps')} bind:value={value.steps} rows={6} class={area}></textarea>
		<small class="text-ink-soft text-xs">{t('field_steps_hint')}</small>
	</div>

	<div class="grid gap-1.5">
		<Label for={id('notes')}>{t('field_notes')}</Label>
		<Textarea id={id('notes')} bind:value={value.notes} rows={2} maxlength={4000} class={area}
		></Textarea>
	</div>

	<div class="grid gap-4 @lg:grid-cols-2">
		<div class="grid gap-1.5">
			<Label for={id('source')}>{t('field_source')}</Label>
			<Input
				id={id('source')}
				bind:value={value.sourceUrl}
				type="url"
				inputmode="url"
				autocomplete="off"
				{...fieldAria(errors.sourceUrl, id('source'))}
			/>
			<FieldError for={id('source')} error={errors.sourceUrl} />
		</div>
		<div class="grid gap-1.5">
			<Label for={id('tags')}>{t('field_tags')}</Label>
			<Input id={id('tags')} bind:value={value.tags} autocomplete="off" />
			<small class="text-ink-soft text-xs">{t('field_tags_hint')}</small>
		</div>
	</div>
</div>
