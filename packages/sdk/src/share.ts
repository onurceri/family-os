import type { Actor } from './actor.ts';
import type { ExtensionContext } from './context.ts';
import type { UploadedFile, UploadSpec } from './routes.ts';

/**
 * Something a member sends the family from outside the app (a Telegram message, a forwarded
 * email). The host has checked the member, the target's capability and its limits; `channel`
 * names where it came from (`telegram`, `email`).
 */
export interface SharedContent {
	channel: string;
	title?: string;
	text?: string;
	url?: string;
	files: readonly UploadedFile[];
}

/**
 * The one place shared things go. Channels outside the app (Telegram, email) hand what a member
 * sends to the host, and the host hands it here; no channel knows which extension receives it.
 * At most one extension of an installation provides it.
 */
export interface ShareTarget {
	/** The capability a member needs to share; checked by the host before `receive`. */
	readonly requires: string;
	/** What one share may carry; the host refuses more before `receive`, and channels trim to it. */
	readonly limits: UploadSpec;
	/** Stores the share as the member. Throw a `FamosError` to refuse it. */
	receive(ctx: ExtensionContext, actor: Actor, share: SharedContent): Promise<void>;
}
