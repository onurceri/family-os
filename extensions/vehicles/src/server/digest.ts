import { type DigestOutput, defineDigest } from '@famos/sdk';
import { RECORD_KIND } from '../contract/index.ts';
import { vehiclesView } from './capabilities.ts';

/** The vehicles' duties (inspection, insurance, service) due in a span; `records` keeps them. */
export const vehiclesDigest = defineDigest({
	id: 'vehicles.digest',
	topic: 'vehicles',
	title: 'What the vehicles need in some days, for an answer',
	description:
		'The duties of the household vehicles due between two days (inspection, insurance, service, tax), with the vehicle each is for, who does it, and what is late when the days include today.',
	requires: vehiclesView.id,
	run: (uow, span) =>
		uow.run<unknown, DigestOutput>('records.dueBetween', { span, recordKinds: [RECORD_KIND] }),
});
