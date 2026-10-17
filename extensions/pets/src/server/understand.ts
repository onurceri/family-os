import { isObligationOf, OBLIGATION_CONTEXT_KIND, pickRecord } from '@famos/ext-records/contract';
import {
	defineMentionKind,
	type IndexedMention,
	type MentionContext,
	type Resolution,
} from '@famos/sdk';
import { compareDates } from '@famos/time';
import { TREATMENT_KINDS, type TreatmentKind } from '../contract/index.ts';
import { aiContext } from './pets.ts';
import { tables } from './store.ts';

const isKind = (value: string | undefined): value is TreatmentKind =>
	(TREATMENT_KINDS as readonly string[]).includes(value ?? '');

async function resolveTreatment(
	ctx: MentionContext,
	{ index, mention }: IndexedMention,
	pets: readonly { id: string; label: string }[],
): Promise<Resolution> {
	const subject = mention.title ?? mention.about ?? null;
	const pet = pickRecord(ctx, mention.about, pets);
	if ('refuse' in pet) return { refuse: { reason: pet.refuse, subject, from: [index] } };
	const given = ctx.day(mention.date, 'past');
	const givenOn = given?.date ?? ctx.today;
	const kind: TreatmentKind = isKind(mention.variant) ? mention.variant : 'other';
	const product = mention.title ?? '';
	const twice = await tables(ctx.db)
		.selectFrom('pets_treatments')
		.select('id')
		.where('pet_id', '=', pet.found.id)
		.where('given_on', '=', givenOn)
		.where('kind', '=', kind)
		.where('product', '=', product)
		.executeTakeFirst();
	if (twice) return { refuse: { reason: 'already', subject, from: [index] } };
	// An open duty of this pet the treatment fulfils ("Rabies" for a rabies vaccine), among those
	// the reading listed; its own words name it, or else what was given does.
	const duties = ctx.records.filter(
		(r) => r.kind === OBLIGATION_CONTEXT_KIND && isObligationOf(r.label, pet.found.label),
	);
	const duty = ctx.target(mention.target ?? mention.title, duties);
	const obligation = 'found' in duty ? duty.found : null;
	const next = obligation ? ctx.day(mention.endDate, 'future') : null;
	const keepsNext = next !== null && compareDates(next.date, givenOn) > 0;
	return {
		propose: {
			actionId: 'pets.addTreatment',
			input: {
				petId: pet.found.id,
				petName: pet.found.label,
				kind,
				givenOn,
				product,
				...(mention.place && { vet: mention.place }),
				...(mention.notes && { notes: mention.notes }),
				...(obligation && { obligationId: obligation.id }),
				...(keepsNext && { nextDueDate: next.date }),
			},
			subject,
			uncertain: [
				...(pet.certain ? [] : ['petId']),
				...(given?.certain ? [] : ['givenOn']),
				...(isKind(mention.variant) ? [] : ['kind']),
				...(obligation && !mention.target ? ['obligationId'] : []),
				...(keepsNext && !next.certain ? ['nextDueDate'] : []),
			],
			from: [index],
		},
	};
}

export const treatmentKind = defineMentionKind({
	id: 'pets.treatment',
	describe:
		'A treatment a listed pet was given, from a vet card, a vet receipt or a message: a vaccination, a parasite treatment, a check-up or a medication. Only for something already given; an appointment still to come is not a treatment.',
	slots: {
		about: 'The pet, by its listed name',
		title: 'What was given, as written ("Nobivac Rabies", "Worm tablet")',
		variant: 'What kind of treatment it was',
		date: 'The day it was given (the date on the card or receipt)',
		endDate: 'When the next one is due, when the message says',
		target: 'The listed duty of that pet it fulfils, by its listed name ("Rabies"), when one fits',
		place: 'The clinic or vet',
		notes: 'Anything else worth keeping, such as the batch or lot number; no amounts of money',
	},
	variants: TREATMENT_KINDS,
	actions: ['pets.addTreatment'],
	knownFrom: [aiContext.id],
	limit: 8,
	examples: [
		{
			text: 'Vaccination card: Luna, Nobivac Rabies, batch A123, 05.10.2026, Riverside Vet. Next due 05.10.2027.',
			mentions: [
				{
					kind: 'pets.treatment',
					about: 'Luna',
					title: 'Nobivac Rabies',
					variant: 'vaccination',
					date: { text: '05.10.2026', numeric: '05.10.2026' },
					endDate: { text: '05.10.2027', numeric: '05.10.2027' },
					target: 'Rabies',
					place: 'Riverside Vet',
					notes: 'Batch A123',
				},
			],
			why: 'a vaccine given that fulfils the listed rabies duty, with the next date',
		},
		{
			text: 'Gave Max his worm tablet this morning',
			mentions: [
				{
					kind: 'pets.treatment',
					about: 'Max',
					title: 'Worm tablet',
					variant: 'parasite_internal',
					date: { text: 'this morning', inDays: 0 },
				},
			],
		},
		{
			text: 'Max has his yearly check-up on Thursday at 10:30',
			mentions: [],
			why: 'an appointment still to come is not a treatment given',
		},
	],
	async resolve(ctx, mentions) {
		const pets = await tables(ctx.db)
			.selectFrom('pets_pets')
			.select(['id', 'name as label'])
			.where('archived_at', 'is', null)
			.orderBy('created_at')
			.execute();
		const out: Resolution[] = [];
		for (const m of mentions) out.push(await resolveTreatment(ctx, m, pets));
		return out;
	},
});
