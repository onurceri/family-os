import { expect, it } from 'vitest';

it('runs in the zone the test setup pins, whatever the machine uses', () => {
	expect(process.env.TZ).toBe('UTC');
	expect(new Date(2026, 6, 1, 12).toISOString()).toBe('2026-07-01T12:00:00.000Z');
	expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
});
