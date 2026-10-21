import { isIP } from 'node:net';

/**
 * The key a client address is counted under. One IPv6 subscriber holds a whole /64, so counting
 * full addresses would let one machine take a new key per request; those are counted as their /64.
 * Anything that is not an IPv6 address (a member id, a token id, an IPv4 address) is kept as is.
 */
export function addressKey(key: string): string {
	if (isIP(key) !== 6) return key;
	const [head = '', tail] = key.toLowerCase().split('::');
	const left = head ? head.split(':') : [];
	const right = tail ? tail.split(':') : [];
	// An embedded IPv4 tail sits beyond the first 64 bits, so only the leading groups matter.
	const groups = [
		...left,
		...Array(Math.max(0, 8 - left.length - right.length)).fill('0'),
		...right,
	];
	return `${groups
		.slice(0, 4)
		.map((g) => Number.parseInt(g, 16).toString(16))
		.join(':')}::/64`;
}
