import { randomInt } from 'node:crypto';
import { type Bot, GrammyError } from 'grammy';

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const CODE_LENGTH = 8;
/** 32 symbols without 0/O/1/I/L lookalikes: every symbol is equally likely. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** The Bot API lets bots download files up to this size. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Same types as the Inbox accepts (UPLOAD_LIMITS.accept); the server checks again. */
const ACCEPTED_TYPES = ['image/*', 'audio/*', 'application/pdf', 'text/plain'];
export const EXTENSION_TYPES: Record<string, string> = {
	pdf: 'application/pdf',
	txt: 'text/plain',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	gif: 'image/gif',
	heic: 'image/heic',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	opus: 'audio/ogg',
	mp3: 'audio/mpeg',
	m4a: 'audio/mp4',
	wav: 'audio/wav',
	aac: 'audio/aac',
};
export const MAX_DRAFT_BUTTONS = 5;
export const CALLBACK_DATA_MAX_BYTES = 64;
export const MAX_TEXT_CHARS = 3_500;
/** Wrong codes one Telegram account may try per window before it is ignored. */
export const MAX_CODE_GUESSES = 10;
export const GUESS_WINDOW_MS = 10 * 60 * 1000;
export const BOT_TOKEN = /^\d{3,}:[A-Za-z0-9_-]{20,}$/;
export const URL_ONLY = /^https?:\/\/\S+$/i;

export const escapeHtml = (text: string) =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** An assistant answer (light Markdown) as Telegram HTML: `**bold**` and `` `code` `` survive. */
export const answerHtml = (text: string) =>
	escapeHtml(text)
		.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
		.replace(/`([^`\n]+)`/g, '<code>$1</code>')
		.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
export const truncate = (text: string, max: number) =>
	[...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text;
export const accepted = (type: string) =>
	ACCEPTED_TYPES.some((a) => (a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : type === a));

/** What is safe to log about a failure: never the payload (it holds message text) or the URL. */
export const errInfo = (error: unknown): { err: string; status?: number } =>
	error instanceof GrammyError
		? { err: 'GrammyError', status: error.error_code }
		: { err: error instanceof Error ? error.name : 'unknown' };

export const newCode = () =>
	Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(
		'',
	);

/** A pending wait that ends early when the signal aborts. */
export const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done);
	});

/**
 * grammY types its abort signals with the `abort-controller` package's polyfill; the native
 * `AbortSignal` it accepts at runtime (it only calls `addEventListener`) does not match structurally.
 */
type GrammySignal = Parameters<Bot['api']['getMe']>[0];
export const grammySignal = (signal: AbortSignal) => signal as unknown as GrammySignal;
