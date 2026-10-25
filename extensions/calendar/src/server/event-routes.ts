import { defineRoute, FamosError } from '@famos/sdk';
import { daysBetween } from '@famos/time';
import { z } from 'zod';
import {
	EventDetailSchema,
	EventIdSchema,
	OccurrenceSchema,
	RangeQuerySchema,
} from '../contract/index.ts';
import { calendarView } from './capabilities.ts';
import { MAX_RANGE_DAYS } from './find-events.ts';
import { api } from './public.ts';
import { events, occurrencesBetween, sortOccurrences, toDetail } from './store.ts';
import { externalOccurrencesBetween } from './subscriptions.ts';

export const listOccurrences = defineRoute({
	method: 'get',
	path: '/occurrences',
	operationId: 'calendar.listOccurrences',
	expose: api.listOccurrences,
	summary:
		'Event occurrences between two dates (inclusive), recurring events expanded; subscriptions included',
	requires: calendarView.id,
	query: RangeQuerySchema,
	response: z.array(OccurrenceSchema),
	async handle(ctx, { query }) {
		if (daysBetween(query.from, query.to) > MAX_RANGE_DAYS) {
			throw new FamosError('bad_request', `The range may span at most ${MAX_RANGE_DAYS} days`);
		}
		const { timeZone } = await ctx.family.settings();
		const [own, external] = await Promise.all([
			occurrencesBetween(ctx.db, query.from, query.to, timeZone),
			externalOccurrencesBetween(ctx.db, query.from, query.to, timeZone),
		]);
		return sortOccurrences([...own, ...external], timeZone);
	},
});

export const getEvent = defineRoute({
	method: 'get',
	path: '/events/{eventId}',
	operationId: 'calendar.getEvent',
	expose: api.getEvent,
	summary: 'An event as an editable form',
	requires: calendarView.id,
	params: z.object({ eventId: EventIdSchema }),
	response: EventDetailSchema,
	async handle(ctx, { params }) {
		const row = await events(ctx.db)
			.selectFrom('calendar_events')
			.selectAll()
			.where('id', '=', params.eventId)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Event not found');
		return toDetail(row);
	},
});
