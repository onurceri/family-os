<script lang="ts">
	import { Textarea } from '@famos/ui/textarea';
	import { orderedWeekdays, weekdayNames } from '@famos/time';
	import {
		Avatar,
		fieldAria,
		FieldError,
		type FieldErrors,
		MemberChips,
		RepeatPicker,
	} from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { ArrowDown, ArrowUp } from '@lucide/svelte';
	import { ROTATIONS } from '../contract/index.js';
	import type { ChoreFormValue } from './form.js';
	import { useChores } from './i18n.js';

	/**
	 * The chore form: what, when, how often, who takes turns (in order) and how the turn moves on.
	 */
	let {
		value = $bindable(),
		errors = {},
		idPrefix = 'chore',
	}: {
		value: ChoreFormValue;
		errors?: FieldErrors;
		idPrefix?: string;
	} = $props();

	const { app, t } = useChores();
	const days = $derived.by(() => {
		const names = weekdayNames(app.dateLocale());
		return orderedWeekdays(app.weekStart()).map((code) => ({ code, label: names[code] }));
	});
	const repeatLabels = $derived({
		none: t('repeat_none'),
		daily: t('repeat_daily'),
		weekly: t('repeat_weekly'),
		monthly: t('repeat_monthly'),
		custom: t('repeat_custom'),
		until: t('field_until'),
	});
	const id = (name: string) => `${idPrefix}-${name}`;
	const ordered = $derived(
		value.assigneeIds.flatMap((m) => {
			const found = app.members().find((x) => x.id === m);
			return found ? [found] : [];
		}),
	);

	function move(index: number, by: -1 | 1) {
		const next = [...value.assigneeIds];
		const target = index + by;
		if (target < 0 || target >= next.length) return;
		[next[index], next[target]] = [next[target] as string, next[index] as string];
		value.assigneeIds = next;
	}
	const field =
		'border-input focus-visible:border-ring focus-visible:ring-ring/50 h-11 rounded-md border bg-transparent px-2.5 text-base outline-none focus-visible:ring-3 md:text-sm';
</script>

<div class="@container">
	<div class="grid gap-5 @2xl:grid-cols-2 @2xl:gap-x-3">
		<div class="grid gap-1.5">
			<Label for={id('title')}>{t('field_title')}</Label>
			<Input
				id={id('title')}
				bind:value={value.title}
				maxlength={120}
				required
				{...fieldAria(errors.title, id('title'))}
				autocomplete="off"
			/>
			<FieldError for={id('title')} error={errors.title} />
		</div>

		<div class="grid gap-1.5">
			<Label for={id('start')}>{t('field_start')}</Label>
			<Input
				id={id('start')}
				type="date"
				bind:value={value.startDate}
				required
				{...fieldAria(errors.startDate, id('start'))}
				class="max-w-52"
			/>
			<FieldError for={id('start')} error={errors.startDate} />
		</div>

		<fieldset class="grid gap-2 @2xl:col-span-2">
			<legend class="mb-1.5 text-sm font-medium">{t('field_repeat')}</legend>
			<RepeatPicker
				bind:preset={value.repeat}
				bind:byDay={value.byDay}
				bind:until={value.until}
				{days}
				labels={repeatLabels}
				min={value.startDate || undefined}
				{idPrefix}
				error={errors.recurrence}
				untilError={errors.until}
			/>
		</fieldset>

		<fieldset class="grid gap-2 @2xl:col-span-2">
			<legend class="mb-1.5 text-sm font-medium">{t('field_people')}</legend>
			<MemberChips members={app.members()} bind:selected={value.assigneeIds} multiple />
			<small class="text-ink-soft text-xs"
				>{value.assigneeIds.length === 0 ? t('people_hint_anyone') : t('people_hint_order')}</small
			>
			{#if ordered.length > 1}
				<ol class="grid gap-1.5" aria-label={t('field_order')}>
					{#each ordered as member, index (member.id)}
						<li class="bg-idle flex min-h-11 items-center gap-2 rounded-lg pr-1 pl-3">
							<span class="text-ink-soft w-4 text-sm font-bold">{index + 1}</span>
							<Avatar name={member.displayName} color={member.color} size={26} />
							<span class="flex-1 truncate font-semibold">{member.displayName}</span>
							<button
								type="button"
								onclick={() => move(index, -1)}
								disabled={index === 0}
								aria-label={t('move_up', { name: member.displayName })}
								class="text-ink-soft hover:text-ink grid size-11 place-items-center rounded-full disabled:opacity-30"
							>
								<ArrowUp class="size-4" aria-hidden="true" />
							</button>
							<button
								type="button"
								onclick={() => move(index, 1)}
								disabled={index === ordered.length - 1}
								aria-label={t('move_down', { name: member.displayName })}
								class="text-ink-soft hover:text-ink grid size-11 place-items-center rounded-full disabled:opacity-30"
							>
								<ArrowDown class="size-4" aria-hidden="true" />
							</button>
						</li>
					{/each}
				</ol>
			{/if}
		</fieldset>

		{#if value.assigneeIds.length > 1}
			<div class="grid gap-1.5">
				<Label for={id('rotation')}>{t('field_rotation')}</Label>
				<select id={id('rotation')} bind:value={value.rotation} class={field}>
					{#each ROTATIONS as r (r)}<option value={r}>{t(`rotation_${r}`)}</option>{/each}
				</select>
				<small class="text-ink-soft text-xs">{t(`rotation_${value.rotation}_hint`)}</small>
			</div>
		{/if}

		<div class="grid gap-1.5 @2xl:col-span-2">
			<Label for={id('notes')}>{t('field_notes')}</Label>
			<Textarea
				id={id('notes')}
				bind:value={value.notes}
				maxlength={1000}
				rows={2}
				class="border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 md:text-sm"
			></Textarea>
		</div>
	</div>
</div>
