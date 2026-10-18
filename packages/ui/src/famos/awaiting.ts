import type { AppContext, AwaitedChange } from '../app-context.js';
import { draftHeadline } from '../draft-title.js';
import { awaitingText, type PresenterContext } from '../slots.js';

/** What a presenter needs, from the app. */
export function presenterContext(app: AppContext): PresenterContext {
	return {
		t: app.t,
		members: app.members(),
		formatLocale: app.formatLocale(),
		dateLocale: app.dateLocale(),
		weekStart: app.weekStart(),
		hourCycle: app.hourCycle(),
		timeZone: app.timeZone(),
	};
}

/** The name of who asked for a change, when it was someone else (for whoever may decide it). */
function askerName(app: AppContext, change: AwaitedChange): string | undefined {
	if (!change.by) return undefined;
	return app.members().find((m) => m.id === change.by)?.displayName;
}

/** The mark of a thing a change to it waits on ("Waiting for approval · Title: Piano lesson"). */
export function awaitingMarkText(app: AppContext, change: AwaitedChange): string {
	return awaitingText({
		input: change.input,
		before: change.before,
		presenter: app.draftPresenter(change.actionId),
		context: presenterContext(app),
		by: askerName(app, change),
	});
}

/**
 * A new entry that waits for approval, as a quiet row of a list says it: its title as the
 * presenter of its action writes it, and "Waiting for approval" (or "Suggested by Leo").
 */
export function awaitingRowText(
	app: AppContext,
	change: AwaitedChange,
): { title: string; meta: string } {
	const context = presenterContext(app);
	const presenter = app.draftPresenter(change.actionId);
	let title: string | undefined;
	try {
		title = presenter?.title(change.input, context);
	} catch {
		// An input stored by another version may not fit today's presenter.
	}
	const by = askerName(app, change);
	return {
		title:
			title?.trim() ||
			draftHeadline({
				summary: null,
				titleKey: null,
				actionId: change.actionId,
				input: change.input,
				t: app.t,
			}),
		meta: by ? app.t('app:draft_waiting_by', { name: by }) : app.t('app:draft_waiting'),
	};
}
