import { createHash, createPublicKey, type KeyObject } from 'node:crypto';

/**
 * A key whose signature this server accepts on an extension package. `official` is the
 * FamilyOS project's own release key. Other kinds (a community author, a family's own key) can be
 * added later; each would come with its own consent on the install screen, which is why the kind
 * travels with the key.
 */
export interface TrustRoot {
	/** `keyIdOf(publicKey)`: what a package's `famos-package.sig` names. */
	keyId: string;
	kind: 'official';
	/** ed25519, SPKI DER, base64. */
	publicKey: string;
}

/**
 * The keys packages from a file or the store must be signed with. There are none yet: the
 * project's release key is committed here when the first signed packages are published, so until
 * then a store install is refused with "signed with a key this server does not trust", and only
 * the packages shipped with the app (trusted by where they are) can be installed. Several keys
 * may be listed at once, so a key can be replaced without stranding the packages it signed.
 */
export const TRUST_ROOTS: readonly TrustRoot[] = [];

/** The id of a public key: the first 16 hex digits of the SHA-256 of its SPKI DER. */
export function keyIdOf(publicKey: KeyObject): string {
	const der = publicKey.export({ format: 'der', type: 'spki' });
	return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** A trust root's key, checked: ed25519 and named by its own id. */
export function publicKeyOf(root: TrustRoot): KeyObject {
	const key = createPublicKey({
		key: Buffer.from(root.publicKey, 'base64'),
		format: 'der',
		type: 'spki',
	});
	if (key.asymmetricKeyType !== 'ed25519')
		throw new Error(`Trust root ${root.keyId} is not an ed25519 key`);
	if (keyIdOf(key) !== root.keyId)
		throw new Error(`Trust root ${root.keyId} does not match its key (${keyIdOf(key)})`);
	return key;
}
