/**
 * UI contribution points. Extensions contribute to slots from their `./web`
 * entry; the web app renders all contributions of a slot. Slot contracts are plain data plus a
 * lazy component loader, so they stay framework-neutral at the edges.
 */
export {
	askedBy,
	type DraftUnavailable,
	draftByline,
	draftHeadline,
	draftKicker,
	memberBehindDraft,
	namedInput,
	proposedByMember,
	unavailableLine,
} from './draft-title.ts';
export {
	type AnyDraftPresenter,
	awaitingText,
	changed,
	changedValue,
	type DraftBefore,
	type DraftEditorProps,
	type DraftField,
	type DraftPresenter,
	draftDate,
	insteadOffer,
	type PresenterContext,
	type PresenterMember,
	removalPresenter,
} from './slots/drafts.ts';
export {
	type NavChild,
	type NavContribution,
	type NavPlacement,
	SETTINGS_SECTIONS,
	type SettingsSection,
} from './slots/nav.ts';
export type {
	SlotContribution,
	SlotName,
	SlotProps,
	TodayBand,
	TodayReport,
} from './slots/slot-props.ts';
export type {
	DayItem,
	MemberCount,
	MemberCountsFacet,
	MemberNote,
	MemberStatusFacet,
	PhotoFacet,
	SetupHintFacet,
	TimelineApp,
	TimelineContribution,
	TimelineItem,
	TodayBlockContribution,
	TodayFacet,
	WeatherFacet,
	WeatherHour,
} from './slots/today.ts';
export {
	type AiFeatureContribution,
	defineWebExtension,
	type PageContribution,
	type PageProps,
	type WebExtension,
	type WebMessages,
} from './slots/web-extension.ts';
