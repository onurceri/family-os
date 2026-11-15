<script lang="ts">
	import { Button } from '@famos/ui/button';
	import { Avatar, resizeImage } from '@famos/ui/famos';
	import { api } from '#lib/api.js';
	import { family } from '#lib/family.svelte.js';
	import { t } from '#lib/i18n.svelte.js';
	import { type ActionFailure, runAction } from '#lib/run-action.js';
	import { session } from '#lib/session.svelte.js';

	/**
	 * A person's profile photo: choose one, replace it, take it away. The picture is cut to its
	 * centered square and shrunk here before it is sent. A change is saved as it is made (the
	 * server keeps it, not the form around this), so the person sees at once what everyone will.
	 */
	let {
		member,
	}: {
		member: { id: string; displayName: string; color: string; photoUrl: string | null };
	} = $props();

	/** Pixels of the square that is sent; a profile photo is never shown larger than this. */
	const PHOTO_SIDE = 512;
	const ACCEPT = 'image/jpeg,image/png,image/webp';

	let input = $state<HTMLInputElement>();
	let busy = $state(false);
	let error = $state<string | null>(null);

	const showError = (failure: ActionFailure) => (error = failure.message);

	/** Others read the change from the member event; this tab does not wait for it. */
	async function reload() {
		await Promise.all([family.refresh(), session.refresh()]);
	}

	async function choose(event: Event) {
		const field = event.currentTarget as HTMLInputElement;
		const file = field.files?.[0];
		field.value = '';
		if (!file || busy) return;
		busy = true;
		error = null;
		let photo: Blob;
		try {
			photo = await resizeImage(file, PHOTO_SIDE, { square: true });
		} catch {
			error = t('member_photo_unreadable');
			busy = false;
			return;
		}
		await runAction(
			api.POST('/api/v1/core/members/{memberId}/photo', {
				params: { path: { memberId: member.id } },
				body: {},
				bodySerializer: () => {
					const form = new FormData();
					form.append('files', photo, 'photo.jpg');
					return form;
				},
			}),
			{ invalid: t('member_photo_refused'), onError: showError, reload },
		);
		busy = false;
	}

	async function remove() {
		if (busy) return;
		busy = true;
		error = null;
		await runAction(
			api.POST('/api/v1/actions/core.removeMemberPhoto', { body: { memberId: member.id } }),
			{ onError: showError, reload },
		);
		busy = false;
	}
</script>

<div class="grid gap-2" data-testid="member-photo">
	<div class="flex items-center gap-4">
		<Avatar name={member.displayName} color={member.color} photo={member.photoUrl} size={64} />
		<div class="flex flex-wrap items-center gap-2">
			<input
				bind:this={input}
				type="file"
				accept={ACCEPT}
				class="sr-only"
				tabindex="-1"
				aria-hidden="true"
				onchange={choose}
				data-testid="member-photo-input"
			/>
			<Button variant="outline" size="sm" disabled={busy} onclick={() => input?.click()}>
				{member.photoUrl ? t('member_photo_replace') : t('member_photo_choose')}
			</Button>
			{#if member.photoUrl}
				<Button variant="ghost" size="sm" disabled={busy} onclick={remove}>
					{t('member_photo_remove')}
				</Button>
			{/if}
		</div>
	</div>
	<small class="text-ink-soft text-[0.8125rem]">{t('member_photo_hint')}</small>
	{#if error}<p class="text-destructive text-sm font-semibold" role="alert">{error}</p>{/if}
</div>
