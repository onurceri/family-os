import { defineRoute } from '@famos/sdk';
import { DAY_MS, todayIn } from '@famos/time';
import { PhotoOfTheDaySchema } from '../contract/index.ts';
import { ambientPhotos } from './capabilities.ts';
import { shuffle } from './photos.ts';
import { tables } from './store.ts';

/** A small seeded generator (mulberry32): the same seed gives the same shuffle. */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/** Days since 1970-01-01 of a local date (`YYYY-MM-DD`). */
export const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

/**
 * Which photo a day shows. The photos are walked in a shuffled order, one a day, so each one comes
 * once before any comes again, and two days in a row never show the same photo (when there are
 * two or more). Each round has its own order; its first photo is never the last of the round
 * before. `ids` must be in a stable order (sorted).
 */
export function pickForDay<T>(ids: readonly T[], day: number): T | null {
	const n = ids.length;
	if (n === 0) return null;
	if (n <= 2) return ids[((day % n) + n) % n] as T;
	const round = Math.floor(day / n);
	const orderOf = (r: number) => shuffle(ids, seeded(r));
	const order = orderOf(round);
	// With three or more, swapping the first two never moves the last, so a round's last photo
	// is the one its own shuffle put there.
	if (order[0] === orderOf(round - 1)[n - 1]) [order[0], order[1]] = [order[1] as T, order[0] as T];
	return order[day - round * n] as T;
}

/**
 * One photo for today (the family's day, in its time zone) for Today and displays: the same id
 * all day, another one tomorrow. Members hold `ambient.photos` through their role; a display only
 * when it was granted at pairing. The id is served by `ambient.getPhoto`.
 */
export const getPhotoOfTheDay = defineRoute({
	method: 'get',
	path: '/photos/today',
	operationId: 'ambient.getPhotoOfTheDay',
	summary: "Today's photo: one photo id for the family's day and the month it was added",
	requires: ambientPhotos.id,
	response: PhotoOfTheDaySchema,
	async handle(ctx) {
		const rows = await tables(ctx.db)
			.selectFrom('ambient_photos')
			.select(['id', 'created_at'])
			.orderBy('id')
			.execute();
		const { timeZone } = await ctx.family.settings();
		const row = pickForDay(rows, dayNumber(todayIn(timeZone, ctx.clock.now())));
		if (!row) return { photo: null };
		return { photo: { id: row.id, month: todayIn(timeZone, row.created_at).slice(0, 7) } };
	},
});
