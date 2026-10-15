import { keyIdOf as packKeyIdOf } from '@famos/pack/famext';
import { describe, expect, it } from 'vitest';
import { keyIdOf, publicKeyOf, TRUST_ROOTS } from '../src/packages/trust.ts';

describe('the trust roots the server ships', () => {
	it('hold the official release key', () => {
		expect(TRUST_ROOTS.find((root) => root.kind === 'official')).toEqual({
			keyId: '3bab2b9c2b26fecd',
			kind: 'official',
			publicKey: 'MCowBQYDK2VwAyEANJRBm3GwhX/MjRYmvHg3M7WyHurnbhFiwlFFUlvpJj4=',
		});
	});

	it('are each an ed25519 key named by its own id, the same id the packer computes', () => {
		for (const root of TRUST_ROOTS) {
			const key = publicKeyOf(root);
			expect(key.asymmetricKeyType).toBe('ed25519');
			expect(keyIdOf(key)).toBe(root.keyId);
			expect(packKeyIdOf(key)).toBe(root.keyId);
		}
		expect(new Set(TRUST_ROOTS.map((root) => root.keyId)).size).toBe(TRUST_ROOTS.length);
	});
});
