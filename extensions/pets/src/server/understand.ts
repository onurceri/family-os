import { isObligationOf, OBLIGATION_CONTEXT_KIND, pickRecord } from '@famos/ext-records/contract';
import {
	asAppointment,
	defineMentionKind,
	type IndexedMention,
	type MentionContext,
	type Resolution,
	stillToCome,
} from '@famos/sdk';
import { compareDates } from '@famos/time';
import { TREATMENT_KINDS, type TreatmentKind } from '../contract/index.ts';
import { aiContext } from './pets.ts';
import { tables } from './store.ts';

const isKind = (value: string | undefined): value is TreatmentKind =>
	(TREATMENT_KINDS as readonly string[]).includes(value ?? '');

/** The calendar's kind for appointments, which a treatment still to come is. */
const EVENT_KIND = 'calendar.event';

async function resolveTreatment(
	ctx: MentionContext,
	{ index, mention }: IndexedMention,
	pets: readonly { id: string; label: string }[],
): Promise<Resolution> {
	const subject = mention.title ?? mention.about ?? null;
	const pet = pickRecord(ctx, mention.about, pets);
	// A treatment is only ever one already given: one still to come is an appointment, also for
	// a pet that is not listed.
	if (stillToCome(ctx, mention)) {
		const name = 'found' in pet ? pet.found.label : (mention.about?.trim() ?? null);
		return {
			handOff: {
				kind: EVENT_KIND,
				mention: asAppointment(mention, name, ctx.locale),
				from: [index],
			},
		};
	}
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
			decided: {
				...(given ? {} : { givenOn: 'defaulted' as const }),
				...(isKind(mention.variant) ? {} : { kind: 'defaulted' as const }),
			},
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
		'A treatment a listed pet was given, from a vet card, a vet receipt or a message: a vaccination, a parasite treatment, a check-up or a medication. Only for something already given; an appointment still to come (a check-up next week) is an event, not a treatment.',
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
	handsOff: [EVENT_KIND],
	knownFrom: [aiContext.id],
	limit: 8,
	examples: [
		{
			text: 'Vaccination card: Luna, Nobivac Rabies, batch A123, 05.10.2026, Riverside Vet. Next due 05.10.2027.',
			mentions: [
				{
					kind: 'pets.treatment',
					quote: 'Nobivac Rabies, batch A123, 05.10.2026',
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
					quote: 'Gave Max his worm tablet this morning',
					about: 'Max',
					title: 'Worm tablet',
					variant: 'parasite_internal',
					date: { text: 'this morning', inDays: 0 },
				},
			],
		},
	],
	decides: { givenOn: 'defaulted', kind: 'defaulted' },
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
