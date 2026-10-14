import { expect, it } from 'vitest';
import { createExtensionSecrets, createSecretBox } from '../src/secrets/index.ts';

const SECRET = 's'.repeat(32);

it('gives each extension its own key', () => {
	const boxFor = createExtensionSecrets(SECRET);
	const sealed = boxFor('calendar').seal('https://example.org/private.ics');
	expect(sealed.startsWith('v2.')).toBe(true);
	expect(boxFor('calendar').open(sealed)).toBe('https://example.org/private.ics');
	expect(boxFor('ambient').open(sealed)).toBeNull();
	expect(createExtensionSecrets('t'.repeat(32))('calendar').open(sealed)).toBeNull();
	expect(boxFor('calendar').needsReseal(sealed)).toBe(false);
});

it('opens what the shared key sealed before, and asks for it to be sealed again', () => {
	// How a release before per-extension keys sealed a calendar subscription.
	const old = createSecretBox(SECRET, 'extension-secrets').seal('webcal://example.org/a.ics');
	const calendar = createExtensionSecrets(SECRET)('calendar');
	expect(calendar.open(old)).toBe('webcal://example.org/a.ics');
	expect(calendar.needsReseal(old)).toBe(true);
	const again = calendar.seal('webcal://example.org/a.ics');
	expect(calendar.needsReseal(again)).toBe(false);
	expect(calendar.open(again)).toBe('webcal://example.org/a.ics');
	// Another secret, or a value that is not sealed at all, opens nothing and is not resealed.
	const foreign = createSecretBox('x'.repeat(32), 'extension-secrets').seal('x');
	expect(calendar.open(foreign)).toBeNull();
	expect(calendar.needsReseal(foreign)).toBe(false);
	expect(calendar.open('plain')).toBeNull();
});
