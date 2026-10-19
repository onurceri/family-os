import { describe, expect, it } from 'vitest';
import { treatmentLines } from '../src/web/treatment-lines.ts';

const dateOf = (day: string) => `on ${day}`;

describe('treatmentLines', () => {
	it('titles a treatment by its product and lists the kind, day and vet', () => {
		expect(
			treatmentLines(
				{ product: 'Nobivac DHPPi', givenOn: '2026-10-19', vet: 'Dr. Lang' },
				'Vaccination',
				dateOf,
			),
		).toEqual({
			title: 'Nobivac DHPPi',
			parts: ['Vaccination', 'on 2026-10-19', 'Dr. Lang'],
		});
	});

	it('titles it by its kind when there is no product', () => {
		expect(treatmentLines({ givenOn: '2026-10-19' }, 'Vaccination', dateOf)).toEqual({
			title: 'Vaccination',
			parts: ['on 2026-10-19'],
		});
	});

	it('tells two waiting vaccinations apart by their day and product', () => {
		const a = treatmentLines({ givenOn: '2026-10-19', product: 'A' }, 'Vaccination', dateOf);
		const b = treatmentLines({ givenOn: '2026-11-02', product: 'B' }, 'Vaccination', dateOf);
		expect(a).not.toEqual(b);
	});

	it('copes with an input from another version that lacks the day', () => {
		expect(treatmentLines({}, 'Vaccination', dateOf)).toEqual({ title: 'Vaccination', parts: [] });
	});
});
