import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';

/**
 * SHA-256 fingerprints (lowercase hex, no colons) of root certificates the server refuses.
 * eMudhra's emSign intermediate CAs were compromised in October 2026 and Node's bundled store
 * still trusts these four roots: emSign Root CA - G1, emSign ECC Root CA - G3,
 * emSign Root CA - C1 and emSign ECC Root CA - C3. Fingerprints, not names, so nothing else
 * can match. Remove this list once Node ships its own blocklist (nodejs/node#66871) and the
 * image's Node has it.
 */
export const DISTRUSTED_FINGERPRINTS: readonly string[] = [
	'40f6af0346a99aa1cd1d555a4e9cce62c7f9634603ee406615833dc8c8d00367',
	'86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
	'125609aa301da0a249b97a8239cb6a34216f44dcac9f3954b14292f2e8c8608f',
	'bc4d809b15189d78db3e1d8cf4f9726a795da1643ca5f1358e1ddb0edc0d7eb3',
];

function fingerprint(pem: string): string | undefined {
	try {
		return new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();
	} catch {
		return undefined;
	}
}

/** The certificates (PEM) whose SHA-256 fingerprint is not in `fingerprints`. */
export function withoutDistrusted(certs: readonly string[], fingerprints: readonly string[]) {
	const blocked = new Set(fingerprints.map((f) => f.replaceAll(':', '').toLowerCase()));
	return certs.filter((pem) => {
		const print = fingerprint(pem);
		return print === undefined || !blocked.has(print);
	});
}

export type DistrustResult =
	| { status: 'applied'; removed: number }
	| { status: 'unsupported' }
	| { status: 'failed'; error: unknown };

/**
 * Removes the distrusted roots from the default store for every outbound TLS connection of this
 * process. Starts from the default store, so `NODE_EXTRA_CA_CERTS` and a system store still count.
 */
export function distrustCertificates(fingerprints = DISTRUSTED_FINGERPRINTS): DistrustResult {
	if (
		typeof tls.setDefaultCACertificates !== 'function' ||
		typeof tls.getCACertificates !== 'function'
	)
		return { status: 'unsupported' };
	try {
		const current = tls.getCACertificates('default');
		const kept = withoutDistrusted(current, fingerprints);
		if (kept.length !== current.length) tls.setDefaultCACertificates(kept);
		return { status: 'applied', removed: current.length - kept.length };
	} catch (error) {
		return { status: 'failed', error };
	}
}

/** Logs what `distrustCertificates` did: a count at info, a problem as a warning. */
export function logDistrust(
	logger: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void },
	result: DistrustResult,
) {
	if (result.status === 'applied')
		logger.info({ count: result.removed }, `distrusted ${result.removed} CA certificates`);
	else if (result.status === 'unsupported')
		logger.warn(
			{},
			'this Node cannot change its trusted CA certificates; distrusted roots stay trusted',
		);
	else logger.warn({ err: result.error }, 'removing distrusted CA certificates failed');
}
