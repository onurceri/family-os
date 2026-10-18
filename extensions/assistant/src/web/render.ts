/**
 * Answers are plain text: the text is never parsed as HTML or markdown.
 * The only thing made clickable is an in-app path such as `/calendar` or `/lists/shopping`
 * that the app actually has (`isAppPath`); "and /or" stays text. Web addresses stay text, so
 * nothing external is ever opened or loaded by accident.
 */
export type Segment = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

/** A path that starts a word: after the start, whitespace or an opening bracket or quote. */
const PATH = /(^|[\s("'“‘])(\/[a-z][a-z0-9-]*(?:\/[A-Za-z0-9._~-]+)*)/g;

export function segments(text: string, isAppPath: (path: string) => boolean): Segment[] {
	const out: Segment[] = [];
	let last = 0;
	for (const match of text.matchAll(PATH)) {
		const start = match.index + (match[1]?.length ?? 0);
		// A trailing full stop or hyphen belongs to the sentence, not to the path.
		const path = (match[2] ?? '').replace(/[.\-_~]+$/, '');
		if (!path || !isAppPath(path)) continue;
		if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
		out.push({ kind: 'link', text: path, href: path });
		last = start + path.length;
	}
	if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
	return out;
}

/**
 * An answer's words with its answer card as plain lines under them, for a page that does not
 * draw the card itself.
 */
export function answerWords(message: {
	content: string;
	card: { text: readonly string[] } | null;
}): string {
	return [message.content, (message.card?.text ?? []).join('\n')]
		.filter((part) => part !== '')
		.join('\n\n');
}
