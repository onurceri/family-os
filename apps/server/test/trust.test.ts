import * as famext from '@famos/pack/famext';
import * as format from '@famos/pack/format';
import { describe, expect, it } from 'vitest';
import { publicKeyOf, TRUST_ROOTS } from '../src/packages/trust.ts';

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
			expect(format.keyIdOf(key)).toBe(root.keyId);
		}
		expect(new Set(TRUST_ROOTS.map((root) => root.keyId)).size).toBe(TRUST_ROOTS.length);
	});

	it("share the signer's package names and key id function", () => {
		expect(famext.keyIdOf).toBe(format.keyIdOf);
		expect(famext.SIGNATURE_FILE).toBe(format.SIGNATURE_FILE);
		expect(famext.ARCHIVE_EXTENSION).toBe(format.ARCHIVE_EXTENSION);
		expect(format.PACKAGE_FILE).toBe('famos-package.json');
		expect(format.SIGNATURE_FILE).toBe('famos-package.sig');
		expect(format.ARCHIVE_EXTENSION).toBe('.famext');
	});
});
