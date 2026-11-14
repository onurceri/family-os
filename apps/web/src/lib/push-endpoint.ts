/** The same SHA-256 hex digest the server lists for a registered browser address. */
export async function endpointId(endpoint: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** This browser's address is registered for the signed-in member. */
export function isRegistered(devices: readonly { endpointId: string }[], id: string): boolean {
	return devices.some((d) => d.endpointId === id);
}
