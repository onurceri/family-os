import type { Clock, DbExecutor, Logger } from '@famos/sdk';
import type { SecretBox } from '../../secrets/index.ts';

/** What a linked member sent to the bot. */
export interface TelegramShare {
	memberId: string;
	text?: string;
	url?: string;
	files: { name: string; type: string; bytes: Uint8Array }[];
}

/**
 * What the adapter needs from the application. The adapter never imports core or extensions:
 * the composition root wires these (Inbox route, draft approval, translations).
 */
export interface TelegramHandlers {
	/** Adds something to the Inbox as the member. Throw a `FamosError` to refuse. */
	onShare(share: TelegramShare): Promise<void>;
	/**
	 * A question typed in the chat, for the assistant. `asked`: the answer comes later
	 * through `sendAnswer` (the adapter remembers `replyId`); `busy`: the last answer is still
	 * being written; `unavailable`: this member cannot use the assistant, so the text is shared
	 * to the Inbox instead.
	 */
	onAsk?(ask: {
		memberId: string;
		text: string;
		threadId: string | null;
	}): Promise<
		{ status: 'asked'; threadId: string; replyId: string } | { status: 'busy' | 'unavailable' }
	>;
	/**
	 * Approves or rejects a draft as the member, or turns it into the change it offers instead
	 * (`replace`; it then waits to be approved). Throw a `FamosError` to refuse.
	 */
	onDecision(decision: {
		memberId: string;
		draftId: string;
		verb: 'approve' | 'reject' | 'replace';
	}): Promise<void>;
	/**
	 * Pending drafts a notification's source points at, that this recipient may see (the adapter
	 * shows at most five). `instead`: what is already there (a line of the message) and the words
	 * of the button that changes it instead of adding a second one.
	 */
	draftButtons(memberId: string, source: { kind: string; id: string }): Promise<DraftButton[]>;
	/** Renders a message key in the member's language (the family's language when `null`). */
	translate(
		memberId: string | null,
		key: string,
		params?: Record<string, unknown>,
	): string | Promise<string>;
	/** The member's display name, or null when they are archived or unknown. */
	memberName(memberId: string): Promise<string | null>;
	/** What the family is called, when it chose a name; the link greeting names it. */
	familyName?(): Promise<string | null>;
}

/** A pending draft as the chat shows it: approve and reject, and maybe a change instead. */
export interface DraftButton {
	id: string;
	label: string;
	instead?: { there: string; action: string };
}

export interface TelegramDeps {
	db: DbExecutor;
	box: SecretBox;
	clock: Clock;
	logger: Logger;
	/** The instance's address; "Open" buttons point into it. */
	baseURL: string;
	/** The Bot API address. Tests inject a stand-in. */
	apiRoot?: string;
	/** Downloads files; defaults to `fetch`. */
	fetch?: typeof fetch;
	/** Seconds Telegram holds a `getUpdates` request open (default 25). */
	pollTimeoutSeconds?: number;
	/** Waiting times of the poller (tests shorten them). */
	timing?: { conflictMs?: number; idleMs?: number; errorBaseMs?: number; errorMaxMs?: number };
	/** Called after the bot or its reported state changed, so open pages can refresh. */
	onStatusChange?: () => void;
	/** Called after a member's link was made or removed (member id only). */
	onLinkChange?: (memberId: string) => void;
	/** The words a key lists in every installed language (command names come from packs). */
	vocabulary?: (key: string) => readonly string[];
}
