import { defineAction, defineRoute } from '@famos/sdk';
import { ChoresSettingsSchema, SetLeftTodayTimesSchema } from '../contract/index.ts';
import { choresEdit, choresView } from './capabilities.ts';
import { scheduleLeftToday } from './left-today.ts';
import { loadLeftTodayTimes, SETTINGS_ROW, tables } from './store.ts';

/** Not offered to the AI (no `ai` hints): when the family is told is theirs to set. */
export const setLeftTodayTimes = defineAction({
	id: 'chores.setLeftTodayTimes',
	title: 'Set the times of the evening count of open chores',
	input: SetLeftTodayTimesSchema,
	output: ChoresSettingsSchema,
	requires: choresEdit.id,
	approval: 'never',
	async run(uow, input) {
		const json = JSON.stringify(input.times);
		const updatedAt = uow.clock.now();
		await tables(uow.db)
			.insertInto('chores_settings')
			.values({ id: SETTINGS_ROW, left_today_times: json, updated_at: updatedAt })
			.onConflict((oc) =>
				oc.column('id').doUpdateSet({ left_today_times: json, updated_at: updatedAt }),
			)
			.execute();
		// The next count follows the new times; one planned for the old times finds nothing to send.
		await scheduleLeftToday(uow);
		return { leftTodayTimes: input.times };
	},
});

export const getSettings = defineRoute({
	method: 'get',
	path: '/settings',
	operationId: 'chores.getSettings',
	summary: 'Chores settings: when the evening count of open chores comes',
	// Everyone who may hear the count may see when it comes; only those who edit chores change it.
	requires: choresView.id,
	response: ChoresSettingsSchema,
	async handle(ctx) {
		return { leftTodayTimes: await loadLeftTodayTimes(ctx.db) };
	},
});
