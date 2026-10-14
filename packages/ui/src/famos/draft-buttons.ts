/**
 * Which of a waiting draft card's decisions gets which button.
 *
 * - `offer`: the change it offers of what is already there ("Move it to … instead"). On a card
 *   decided on its own it is the filled button, since that is what the news means; in a group
 *   decided together the group's "Add selected" is the one filled button, so it is an outline.
 * - `approve`: approving the draft as it is. Beside an offer it is the secondary "Add as new",
 *   and still takes two taps; when it may already be there it takes two taps too.
 */
export interface DraftButtons {
	offer: 'none' | 'primary' | 'outline';
	approve: 'none' | 'primary' | 'primary-confirm' | 'secondary-confirm';
}

export function draftButtons(state: {
	/** It offers a change of what is already there (and the viewer may decide). */
	offered: boolean;
	/** Approving it takes a second tap (it may already be there). */
	warned: boolean;
	/** Decided in a group: a tick instead of its own approve button. */
	picking: boolean;
}): DraftButtons {
	if (state.picking) return { offer: state.offered ? 'outline' : 'none', approve: 'none' };
	if (state.offered) return { offer: 'primary', approve: 'secondary-confirm' };
	return { offer: 'none', approve: state.warned ? 'primary-confirm' : 'primary' };
}
