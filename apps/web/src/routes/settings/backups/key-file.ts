import type { ApiError } from '@famos/api-client';

/** The name the saved key file gets on the device. */
export const KEY_FILE_NAME = 'familyos-secret';

/** Hands `text` to the browser as a file download. */
export function saveTextFile(text: string, name: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

/** Why saving the key file was refused, in the terms the dialog words. */
export function keyFileFailure(
	error: ApiError,
): 'wrong_password' | 'password_sign_in' | 'locked' | 'other' {
	if (error.code === 'limit_reached') return 'locked';
	if (error.code !== 'forbidden') return 'other';
	const reason = (error.details as { reason?: unknown } | null | undefined)?.reason;
	if (reason === 'wrong_password') return 'wrong_password';
	if (reason === 'full_sign_in') return 'password_sign_in';
	return 'other';
}
