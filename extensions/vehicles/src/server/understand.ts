import { pickRecord } from '@famos/ext-records/contract';
import {
	asAppointment,
	defineMentionKind,
	type IndexedMention,
	type MentionContext,
	type Resolution,
	stillToCome,
	withoutAmounts,
} from '@famos/sdk';
import { LOG_KINDS, type LogKind } from '../contract/index.ts';
import { tables } from './store.ts';
import { aiContext } from './vehicles.ts';

const isKind = (value: string | undefined): value is LogKind =>
	(LOG_KINDS as readonly string[]).includes(value ?? '');

const NOTES_MAX = 2000;

/** The calendar's kind for appointments, which work still to come on a car is. */
const EVENT_KIND = 'calendar.event';

async function resolveLog(
	ctx: MentionContext,
	{ index, mention }: IndexedMention,
	vehicles: readonly { id: string; label: string }[],
): Promise<Resolution> {
	const subject = mention.title ?? mention.about ?? null;
	const vehicle = pickRecord(ctx, mention.about, vehicles);
	// A log holds work done: work still to come is a booking, also for a vehicle not listed.
	if (stillToCome(ctx, mention)) {
		const name = 'found' in vehicle ? vehicle.found.label : (mention.about?.trim() ?? null);
		return {
			handOff: {
				kind: EVENT_KIND,
				mention: asAppointment(mention, name, ctx.locale),
				from: [index],
			},
		};
	}
	if ('refuse' in vehicle) return { refuse: { reason: vehicle.refuse, subject, from: [index] } };
	if (!mention.title && !mention.notes)
		return { refuse: { reason: 'incomplete', subject, from: [index] } };
	const day = ctx.day(mention.date, 'past');
	const doneOn = day?.date ?? ctx.today;
	const kind: LogKind = isKind(mention.variant) ? mention.variant : 'service';
	const twice = await tables(ctx.db)
		.selectFrom('vehicles_logs')
		.select('id')
		.where('vehicle_id', '=', vehicle.found.id)
		.where('done_on', '=', doneOn)
		.where('kind', '=', kind)
		.executeTakeFirst();
	if (twice) return { refuse: { reason: 'already', subject, from: [index] } };
	const notes = withoutAmounts([mention.title, mention.notes].filter(Boolean).join('; ')).slice(
		0,
		NOTES_MAX,
	);
	return {
		propose: {
			actionId: 'vehicles.addLog',
			input: {
				vehicleId: vehicle.found.id,
				vehicleName: vehicle.found.label,
				kind,
				doneOn,
				...(mention.place && { place: mention.place }),
				notes,
			},
			subject,
			decided: {
				...(day ? {} : { doneOn: 'defaulted' as const }),
				...(isKind(mention.variant) ? {} : { kind: 'defaulted' as const }),
			},
			uncertain: [
				...(vehicle.certain ? [] : ['vehicleId']),
				...(day?.certain ? [] : ['doneOn']),
				...(isKind(mention.variant) ? [] : ['kind']),
			],
			from: [index],
		},
	};
}

export const logKind = defineMentionKind({
	id: 'vehicles.log',
	describe:
		'Work that was done on a listed vehicle, from an invoice, a service receipt or a message: a service, a repair, new tyres. Only for work already done; a booking still to come (a service next week) is an event, not a log entry.',
	slots: {
		about: 'The vehicle, by its listed name',
		title: 'What was done, in a few words ("Oil change and new brake pads")',
		variant: 'service for regular maintenance, repair for fixing something, other otherwise',
		date: 'The day of the work (the invoice date)',
		place: 'The garage or workshop',
		notes: 'Anything else worth keeping, such as the mileage; no amounts of money',
	},
	variants: LOG_KINDS,
	actions: ['vehicles.addLog'],
	handsOff: [EVENT_KIND],
	knownFrom: [aiContext.id],
	limit: 8,
	examples: [
		{
			text: 'Invoice, City Garage, 1 October 2026: oil change and new brake pads for the family car. Mileage 84,000 km.',
			mentions: [
				{
					kind: 'vehicles.log',
					quote: 'oil change and new brake pads for the family car',
					about: 'Family car',
					title: 'Oil change and new brake pads',
					variant: 'service',
					date: { text: '1 October 2026', day: 1, month: 10, year: 2026 },
					place: 'City Garage',
					notes: 'Mileage 84,000 km',
				},
			],
		},
		{
			text: 'The windscreen of the van was replaced yesterday',
			mentions: [
				{
					kind: 'vehicles.log',
					quote: 'The windscreen of the van was replaced yesterday',
					about: 'Van',
					title: 'Windscreen replaced',
					variant: 'repair',
					date: { text: 'yesterday', inDays: -1 },
				},
			],
		},
	],
	decides: { doneOn: 'defaulted', kind: 'defaulted' },
	async resolve(ctx, mentions) {
		const vehicles = await tables(ctx.db)
			.selectFrom('vehicles_vehicles')
			.select(['id', 'name as label'])
			.where('archived_at', 'is', null)
			.orderBy('created_at')
			.execute();
		const out: Resolution[] = [];
		for (const m of mentions) out.push(await resolveLog(ctx, m, vehicles));
		return out;
	},
});
