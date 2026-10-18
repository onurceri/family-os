import { type DigestOutput, defineDigest } from '@famos/sdk';
import { HOME_KIND, ITEM_KIND } from '../contract/index.ts';
import { homeView } from './capabilities.ts';

/**
 * The duties of the homes and the things in them (a boiler service, insurance, a warranty that
 * ends) due in a span; `records` keeps them. Services stay out, as they do of everything the AI
 * reads about the home.
 */
export const homeDigest = defineDigest({
	id: 'home.digest',
	topic: 'home',
	title: 'What the home needs in some days, for an answer',
	description:
		'The duties of the homes and the things in them due between two days (a boiler service, insurance, a warranty that ends), with what each is for, who does it, and what is late when the days include today.',
	requires: homeView.id,
	run: (uow, span) =>
		uow.run<unknown, DigestOutput>('records.dueBetween', {
			span,
			recordKinds: [HOME_KIND, ITEM_KIND],
		}),
});
