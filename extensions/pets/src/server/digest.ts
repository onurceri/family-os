import { recordDueDigest } from '@famos/ext-records/contract';
import { RECORD_KIND } from '../contract/index.ts';
import { petsView } from './capabilities.ts';

/** The pets' duties (vaccinations, treatments, check-ups) due in a span; `records` keeps them. */
export const petsDigest = recordDueDigest({
	id: 'pets.digest',
	topic: 'pets',
	title: 'What the pets need in some days, for an answer',
	description:
		'The duties of the household pets due between two days (vaccination, treatment, check-up), with the pet each is for, who does it, and what is late when the days include today.',
	requires: petsView.id,
	recordKind: RECORD_KIND,
});
