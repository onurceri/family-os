import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { SecretBox as ExtensionSecretBox } from '@famos/sdk';

/**
 * Credentials at rest (provider API keys; other purposes get their own derived key): AES-256-GCM with a key derived from FAMOS_SECRET (HKDF), so a
 * copied database or backup alone does not reveal them. Format: `v1.<iv>.<tag>.<ciphertext>`.
 */
export interface SecretBox {
	seal(plain: string): string;
	/** The plain text, or null when it was sealed with another secret or is corrupt. */
	open(sealed: string): string | null;
}

export function createSecretBox(secret: string, purpose = 'ai-provider-keys'): SecretBox {
	const key = Buffer.from(hkdfSync('sha256', secret, 'famos', purpose, 32));
	return {
		seal(plain) {
			const iv = randomBytes(12);
			const cipher = createCipheriv('aes-256-gcm', key, iv);
			const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
			return ['v1', iv, cipher.getAuthTag(), data]
				.map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
				.join('.');
		},
		open(sealed) {
			const [version, iv, tag, data] = sealed.split('.');
			if (version !== 'v1' || !iv || !tag || data === undefined) return null;
			try {
				const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
				decipher.setAuthTag(Buffer.from(tag, 'base64url'));
				return Buffer.concat([
					decipher.update(Buffer.from(data, 'base64url')),
					decipher.final(),
				]).toString('utf8');
			} catch {
				return null;
			}
		},
	};
}

/**
 * The purpose of the one key all extensions shared before each got its own. Values sealed with
 * it (`v1.`) still open, so existing calendar subscriptions keep syncing, and report
 * `needsReseal`, so their owner seals them again with its own key.
 */
const SHARED_EXTENSION_PURPOSE = 'extension-secrets';

/**
 * One box per extension, each with its own key derived from FAMOS_SECRET (`ext:<id>`), so one
 * extension cannot open what another sealed. Format: `v2.<iv>.<tag>.<ciphertext>`; `v1.` values
 * of the earlier shared key open too.
 */
export function createExtensionSecrets(
	secret: string,
): (extensionId: string) => ExtensionSecretBox {
	const shared = createSecretBox(secret, SHARED_EXTENSION_PURPOSE);
	return (extensionId) => {
		const own = createSecretBox(secret, `ext:${extensionId}`);
		return {
			seal: (plain) => `v2${own.seal(plain).slice('v1'.length)}`,
			open(sealed) {
				if (sealed.startsWith('v2.')) return own.open(`v1${sealed.slice('v2'.length)}`);
				if (sealed.startsWith('v1.')) return shared.open(sealed);
				return null;
			},
			needsReseal: (sealed) => sealed.startsWith('v1.') && shared.open(sealed) !== null,
		};
	};
}
