import { describe, expect, it } from 'vitest';
import { greetingKey, hourIn, SUGGESTIONS, usedAgo } from '../src/web/greeting.ts';
import { segments as segmentsOf } from '../src/web/render.ts';
import { reduceStream, settleStream } from '../src/web/stream.ts';

/** The pages this test app has. */
const ROUTES = new Set(['/calendar', '/lists/shopping', '/x']);
const segments = (text: string) => segmentsOf(text, (path) => ROUTES.has(path));

describe('answer text', () => {
	it('links in-app paths and leaves the rest as text', () => {
		expect(segments('Open /calendar or (see /lists/shopping).')).toEqual([
			{ kind: 'text', text: 'Open ' },
			{ kind: 'link', text: '/calendar', href: '/calendar' },
			{ kind: 'text', text: ' or (see ' },
			{ kind: 'link', text: '/lists/shopping', href: '/lists/shopping' },
			{ kind: 'text', text: ').' },
		]);
	});

	it('keeps the full stop of a sentence out of the link', () => {
		expect(segments('Go to /calendar.')).toEqual([
			{ kind: 'text', text: 'Go to ' },
			{ kind: 'link', text: '/calendar', href: '/calendar' },
			{ kind: 'text', text: '.' },
		]);
	});

	it('never links external addresses or protocol-relative ones', () => {
		for (const text of [
			'See https://example.com/calendar now',
			'See //evil.example/calendar now',
			'Mail me at a@b.co/x',
			'and/or maybe',
			'javascript:alert(1)',
		])
			expect(
				segments(text).every((s) => s.kind === 'text'),
				text,
			).toBe(true);
	});

	it('does not interpret HTML or markdown: it is all text', () => {
		const html = '<img src=x onerror=alert(1)> ![x](https://e.com/a.png) <a href="/x">/x</a>';
		const parts = segments(html);
		expect(parts.map((s) => s.text).join('')).toBe(html);
		// The only link is a path that starts a word; its text is the path, nothing else.
		for (const part of parts) if (part.kind === 'link') expect(part.href).toMatch(/^\/[a-z]/);
	});

	it('links only paths that are pages of the app', () => {
		expect(segments('Tea and /or coffee; open /calendar, not /nowhere')).toEqual([
			{ kind: 'text', text: 'Tea and /or coffee; open ' },
			{ kind: 'link', text: '/calendar', href: '/calendar' },
			{ kind: 'text', text: ', not /nowhere' },
		]);
	});

	it('keeps line breaks and returns nothing for empty text', () => {
		expect(segments('a\nb')).toEqual([{ kind: 'text', text: 'a\nb' }]);
		expect(segments('')).toEqual([]);
	});
});

describe('answer stream', () => {
	it('appends deltas per message', () => {
		let state = reduceStream({}, { kind: 'delta', messageId: 'm1', text: 'Hel' });
		state = reduceStream(state, { kind: 'delta', messageId: 'm1', text: 'lo' });
		state = reduceStream(state, { kind: 'delta', messageId: 'm2', text: 'x' });
		expect(state).toEqual({ m1: 'Hello', m2: 'x' });
	});

	it('starts over on a reset', () => {
		const state = reduceStream(
			{ m1: 'old text' },
			{ kind: 'delta', messageId: 'm1', text: '', reset: true },
		);
		expect(state).toEqual({ m1: '' });
	});

	it('forgets a message when it is done, without touching others', () => {
		expect(reduceStream({ m1: 'a', m2: 'b' }, { kind: 'done', messageId: 'm1' })).toEqual({
			m2: 'b',
		});
	});

	it('keeps text only for answers that are still open after a reload', () => {
		const state = { m1: 'a', m2: 'b' };
		expect(settleStream(state, new Set(['m2']))).toEqual({ m2: 'b' });
		expect(settleStream(state, new Set(['m1', 'm2']))).toBe(state);
	});
});

describe('a new conversation', () => {
	it('greets by the time of day', () => {
		expect([4, 5, 11, 12, 17, 18, 23, 0].map(greetingKey)).toEqual([
			'greeting_evening',
			'greeting_morning',
			'greeting_morning',
			'greeting_afternoon',
			'greeting_afternoon',
			'greeting_evening',
			'greeting_evening',
			'greeting_evening',
		]);
	});

	it("reads the hour in the family's time zone", () => {
		const noonUtc = Date.UTC(2026, 0, 15, 12, 0);
		expect(hourIn('UTC', noonUtc)).toBe(12);
		expect(hourIn('Asia/Tokyo', noonUtc)).toBe(21);
		expect(hourIn('America/New_York', noonUtc)).toBe(7);
		expect(hourIn('UTC', Date.UTC(2026, 0, 15, 0, 30))).toBe(0);
	});

	it('suggests one question per area, each with its own title', () => {
		expect(SUGGESTIONS.map((s) => s.area)).toEqual(['calendar', 'shopping', 'tasks', 'list']);
		expect(new Set(SUGGESTIONS.map((s) => s.title)).size).toBe(4);
		expect(SUGGESTIONS[0]).toEqual({
			area: 'calendar',
			title: 'suggest_calendar',
			question: 'example_calendar',
		});
	});

	it('says how long ago a conversation was used, then the date', () => {
		const now = Date.UTC(2026, 9, 10, 12, 0);
		const ago = (ms: number) =>
			usedAgo(now - ms, {
				now,
				language: 'en',
				dateLocale: 'en-US',
				timeZone: 'UTC',
				justNow: 'Just now',
			});
		expect(ago(10_000)).toBe('Just now');
		expect(ago(5 * 60_000)).toBe('5 minutes ago');
		expect(ago(3 * 3_600_000)).toBe('3 hours ago');
		expect(ago(86_400_000)).toBe('yesterday');
		expect(ago(30 * 86_400_000)).toBe('Sep 10, 2026');
	});
});
