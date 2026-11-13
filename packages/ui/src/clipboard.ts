/**
 * Puts text on the clipboard and says whether it worked. `navigator.clipboard` exists only on
 * https and localhost, so on a plain-http home-network address this falls back to selecting a
 * temporary field and `execCommand('copy')`. When both fail the caller tells the person to copy
 * by hand.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Refused (permission, focus): try the older way.
	}
	if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
	const field = document.createElement('textarea');
	field.value = text;
	field.setAttribute('readonly', '');
	field.style.position = 'fixed';
	field.style.top = '0';
	field.style.opacity = '0';
	const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	// Inside an open dialog only its own content can take focus, so the field joins it.
	(active?.closest('dialog, [role="dialog"]') ?? document.body).appendChild(field);
	try {
		field.select();
		field.setSelectionRange(0, text.length);
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		field.remove();
		active?.focus();
	}
}
