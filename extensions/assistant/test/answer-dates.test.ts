import lists from '@famos/ext-lists/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, repoTranslate, repoVocabulary, type TestKernel } from '@famos/testing';
import { dateWords } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answerWithRealWeekdays, answerWithWordDates } from '../src/server/answer-dates.ts';
import assistant from '../src/server/index.ts';
import { loopTurns } from './reading.ts';

type Asker = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let leo: Asker;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists, assistant], translate: repoTranslate() });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ locale: 'en', timeZone: 'Europe/Amsterdam', formatLocale: 'en-GB' },
		systemActor('test'),
	);
	leo = await k.member('supervised', 'Leo');
	// Saturday 17 October 2026, in the morning.
	k.clock.set(Date.parse('2026-10-17T08:00:00Z'));
});
afterEach(() => k.close());

async function ask(text: string) {
	const sent = await k.runner.invoke<{ threadId: string; replyId: string }>(
		'assistant.sendMessage',
		{ text },
		leo.actor,
	);
	if (sent.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
	const detail = await k
		.route('assistant.getThread')
		.call({ params: { threadId: sent.output.threadId }, actor: leo.actor });
	return (detail.messages.at(-1) as { content: string }).content;
}

describe('weekdays in an answer', () => {
	it('are given to the model with each date, and corrected when it still names another', async () => {
		await k.runner.invoke(
			'lists.addTask',
			{ title: 'Take out the bins', dueDate: '2026-10-20' },
			systemActor('test'),
		);
		loopTurns(k.llm, [
			{ tool: 'lists_openTasks', input: {} },
			// What the real model told a child: 20 October 2026 is a Tuesday.
			{
				text: "No, the bins are not going out tonight. The task 'Take out the bins' is due on Monday 20 October.",
			},
		]);
		const content = await ask('are the bins going out tonight?');
		expect(k.llm.chatTrace[0]?.result).toContain('Weekday":"Tuesday"');
		expect(content).toBe(
			"No, the bins are not going out tonight. The task 'Take out the bins' is due on Tuesday 20 October.",
		);
	});

	it('keep a mismatch the person wrote, which the answer quotes back', async () => {
		loopTurns(k.llm, [
			{
				text: 'You wrote Wednesday 20 October, but 20 October is a Tuesday. Which day do you mean?',
			},
		]);
		expect(await ask('Is there swimming on Wednesday 20 October?')).toBe(
			'You wrote Wednesday 20 October, but 20 October is a Tuesday. Which day do you mean?',
		);
	});
});

describe('answerWithRealWeekdays', () => {
	const translate = repoTranslate();
	const words = dateWords(repoVocabulary());
	const fix = (text: string, locales: string[]) =>
		answerWithRealWeekdays(text, {
			today: '2026-10-17',
			words,
			order: 'DMY',
			asked: '',
			locales,
			translate,
		});

	it('uses the language of the wrong word, full or short', () => {
		expect(fix('Pazartesi 20 Ekim çöp günü.', ['tr', 'en'])).toBe('Salı 20 Ekim çöp günü.');
		// A Turkish family whose member asked in English gets English words.
		expect(fix('Bins on Mon 20 Oct.', ['tr', 'en'])).toBe('Bins on Tue 20 Oct.');
	});

	it('leaves a weekday that fits', () => {
		expect(fix('Bins on Tuesday 20 October.', ['en'])).toBe('Bins on Tuesday 20 October.');
	});
});

describe('answerWithWordDates', () => {
	const words = dateWords(repoVocabulary());
	const write = (text: string, asked = '', locale = 'en-GB') =>
		answerWithWordDates(text, {
			today: '2026-10-17',
			asked,
			dateLocale: locale,
			weekdays: [...words.weekdays.flat(), ...words.weekdaysShort.flat()],
		});

	it('writes ISO dates as words, without doubling the weekday (real model answers)', () => {
		// Leo's round-5 answer.
		expect(write('Practise reading is due on Tuesday 2026-10-20.')).toBe(
			'Practise reading is due on Tuesday 20 October.',
		);
		// Ellie's, with non-breaking hyphens.
		expect(write('Pack my swim bag for Tuesday 2026‑10‑06.')).toBe(
			'Pack my swim bag for Tuesday 6 October.',
		);
		expect(write('The service is on 2027-01-12.')).toBe(
			'The service is on Tuesday, 12 January 2027.',
		);
		expect(write('Salı 2026-10-20 çöp günü.', '', 'tr-TR')).toBe('20 Ekim Salı çöp günü.');
	});

	it('keeps a date the person wrote that way, and what is no date', () => {
		expect(write('Nothing on 2026-10-20.', 'what is on 2026-10-20?')).toBe(
			'Nothing on 2026-10-20.',
		);
		expect(write('Order 2026-13-45 and id x2026-10-20.')).toBe(
			'Order 2026-13-45 and id x2026-10-20.',
		);
	});
});
