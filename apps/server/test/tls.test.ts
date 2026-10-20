import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { DISTRUSTED_FINGERPRINTS, distrustCertificates, withoutDistrusted } from '../src/tls.ts';

const print = (pem: string) =>
	new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();

describe('withoutDistrusted', () => {
	const [a, b, c] = tls.rootCertificates;
	it('drops only the listed fingerprints, in either case and with colons', () => {
		const listed = [print(b as string).toUpperCase()];
		expect(withoutDistrusted([a as string, b as string, c as string], listed)).toEqual([a, c]);
		const colons = print(b as string).replace(/(..)(?!$)/g, '$1:');
		expect(withoutDistrusted([a as string, b as string], [colons])).toEqual([a]);
	});
	it('keeps everything for an empty list and keeps what it cannot parse', () => {
		expect(withoutDistrusted([a as string], [])).toEqual([a]);
		expect(withoutDistrusted(['not a certificate'], DISTRUSTED_FINGERPRINTS)).toEqual([
			'not a certificate',
		]);
	});
});

describe('the pinned list', () => {
	it('is exactly the four emSign roots Node bundles', () => {
		const emsign = tls.rootCertificates.filter((pem) =>
			new X509Certificate(pem).subject.includes('emSign'),
		);
		expect(emsign.map(print).sort()).toEqual([...DISTRUSTED_FINGERPRINTS].sort());
	});
});

describe('distrustCertificates', () => {
	const before = tls.getCACertificates('default');
	afterEach(() => tls.setDefaultCACertificates(before));
	it('leaves none of them in the default store and keeps the rest', () => {
		const result = distrustCertificates();
		expect(result.status).toBe('applied');
		const after = tls.getCACertificates('default').map(print);
		for (const f of DISTRUSTED_FINGERPRINTS) expect(after).not.toContain(f);
		expect(after.length).toBe(before.length - DISTRUSTED_FINGERPRINTS.length);
	});
});
