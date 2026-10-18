import { SpanSchema } from '@famos/sdk';
import { resolveSpan } from '@famos/time';
import { describe, expect, it } from 'vitest';

// The model's span (`@famos/sdk`) is handed to the resolver (`@famos/time`) as it is: the two
// packages do not import each other, so this is where a drift between them shows.
describe('a span read by the model', () => {
	it('is resolved as it is', () => {
		const span = SpanSchema.parse({
			said: 'this week',
			kind: 'week',
			day: { text: 'this week', week: 'this' },
		});
		expect(resolveSpan(span, '2026-10-18', 1)).toMatchObject({
			from: '2026-10-18',
			to: '2026-10-24',
			label: { key: 'coming_days' },
		});
		const until = SpanSchema.parse({ said: 'until Friday', to: { text: 'Friday', weekday: 5 } });
		expect(resolveSpan(until, '2026-10-14', 1)).toMatchObject({
			from: '2026-10-14',
			to: '2026-10-16',
		});
	});
});
