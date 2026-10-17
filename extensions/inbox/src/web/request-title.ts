import type { AppContext } from '@famos/ui/app';
import { draftHeadline, namedInput, type PresenterContext } from '@famos/ui/slots';
import type { Draft } from './data.js';

/** What a request asked for, as its card titles it (the presenter of the action's extension). */
export function requestTitle(app: AppContext, draft: Draft): string {
	const context: PresenterContext = {
		t: app.t,
		members: app.members(),
		formatLocale: app.formatLocale(),
		dateLocale: app.dateLocale(),
		weekStart: app.weekStart(),
		hourCycle: app.hourCycle(),
		timeZone: app.timeZone(),
	};
	const input = namedInput(draft.editedInput ?? draft.input, draft.subject);
	return (
		app.draftPresenter(draft.actionId)?.title(input, context) ??
		draftHeadline({
			summary: draft.summary,
			titleKey: draft.titleKey,
			actionId: draft.actionId,
			input,
			t: app.t,
		})
	);
}
