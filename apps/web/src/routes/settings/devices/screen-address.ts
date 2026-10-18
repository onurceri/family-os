/** Whether a host name or address only reaches the computer it is typed on. */
export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host === '::1' ||
		host === '0.0.0.0' ||
		/^127(\.\d{1,3}){3}$/.test(host)
	);
}

export interface ScreenAddress {
	/** The address a screen should open, or null when none this page knows can be reached from another device. */
	url: string | null;
	/** The admin's own address only works on this computer: say so. */
	loopback: boolean;
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return '';
	}
}

/**
 * The address to show for opening FamilyOS on another device. The admin's own address is used
 * unless it is a loopback one; then the family address the server was told about (when it is not
 * loopback itself) takes its place, and without one no address is offered.
 */
export function screenAddress(origin: string, configured: string | null): ScreenAddress {
	if (!isLoopbackHost(hostOf(origin))) return { url: origin, loopback: false };
	const family = configured && !isLoopbackHost(hostOf(configured)) ? configured : null;
	return { url: family, loopback: true };
}
