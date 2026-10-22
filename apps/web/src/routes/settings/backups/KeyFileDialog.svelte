<script lang="ts">
	import { isApiError, unwrap } from '@famos/api-client';
	import { Button } from '@famos/ui/button';
	import { Dialog, Notice } from '@famos/ui/famos';
	import { Input } from '@famos/ui/input';
	import { Label } from '@famos/ui/label';
	import { api } from '#lib/api.js';
	import { t } from '#lib/i18n.svelte.js';
	import { toasts } from '#lib/toast.svelte.js';
	import { KEY_FILE_NAME, keyFileFailure, saveTextFile } from './key-file.js';

	/**
	 * Saves the server's key file to this device. It is the master key of everything the server
	 * keeps sealed, so the password is asked for again each time.
	 */
	let { open, onclose }: { open: boolean; onclose: () => void } = $props();

	let password = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);

	$effect(() => {
		if (open) {
			password = '';
			error = null;
		}
	});

	async function save() {
		if (!password || busy) return;
		busy = true;
		error = null;
		try {
			const text = unwrap(
				await api.POST('/api/v1/backups/key-file', { body: { password }, parseAs: 'text' }),
			);
			saveTextFile(text, KEY_FILE_NAME);
			toasts.show(t('key_file_saved'));
			onclose();
		} catch (e) {
			const failure = isApiError(e) ? keyFileFailure(e) : 'other';
			error =
				failure === 'wrong_password'
					? t('key_file_wrong_password')
					: failure === 'password_sign_in'
						? t('key_file_needs_password_sign_in')
						: failure === 'locked'
							? t('key_file_locked')
							: t('error_generic');
		} finally {
			password = '';
			busy = false;
		}
	}
</script>

<Dialog {open} title={t('key_file_title')} description={t('key_file_explain')} {onclose}>
	<form
		class="grid gap-3"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		{#if error}<Notice tone="alert">{error}</Notice>{/if}
		<div class="grid gap-1.5">
			<Label for="key-file-password">{t('key_file_password')}</Label>
			<Input
				id="key-file-password"
				type="password"
				bind:value={password}
				autocomplete="current-password"
				maxlength={200}
				data-autofocus
			/>
		</div>
		<div class="flex flex-wrap justify-end gap-2">
			<Button variant="ghost" onclick={onclose}>{t('cancel')}</Button>
			<Button type="submit" variant="primary" disabled={!password || busy}
				>{t('key_file_save')}</Button
			>
		</div>
	</form>
</Dialog>
