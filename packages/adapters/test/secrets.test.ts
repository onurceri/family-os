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
});

it('opens nothing sealed with the key all extensions once shared, or not sealed at all', () => {
	const old = createSecretBox(SECRET, 'extension-secrets').seal('webcal://example.org/a.ics');
	const calendar = createExtensionSecrets(SECRET)('calendar');
	expect(calendar.open(old)).toBeNull();
	expect(calendar.open('plain')).toBeNull();
});
