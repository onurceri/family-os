import { createHash, type KeyObject } from 'node:crypto';

// The names a package and its archive agree on. They live apart from the build so that the
// scripts that only pack, sign and index archives do not load Vite, Svelte and Tailwind.

/** The version of the package format, so a host can refuse one it does not understand. */
export const PACKAGE_FORMAT = 1;

/** The file that describes a built package; every other file is listed in it with its hash. */
export const PACKAGE_FILE = 'famos-package.json';

/** The file in a `.famext` archive that holds the signature of `famos-package.json`. */
export const SIGNATURE_FILE = 'famos-package.sig';

/** The extension of a packed, signed extension package. */
export const ARCHIVE_EXTENSION = '.famext';

/**
 * A key's id: the first 16 hex digits of the SHA-256 of its public key (SPKI, DER). It is
 * derived, so a signature can never name a key it was not made with; the host computes it the
 * same way for its trust roots.
 */
export function keyIdOf(publicKey: KeyObject): string {
	const der = publicKey.export({ format: 'der', type: 'spki' });
	return createHash('sha256').update(der).digest('hex').slice(0, 16);
}
