import lists from '@famos/ext-lists/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import assistant from '../src/server/index.ts';

type Asker = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let ellie: Asker;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists, assistant] });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ locale: 'en', timeZone: 'Europe/Amsterdam', formatLocale: 'en-GB' },
		systemActor('test'),
	);
	ellie = await k.member('admin', 'Ellie');
	// Wednesday 14 October 2026, in the evening.
	k.clock.set(Date.parse('2026-10-14T17:00:00Z'));
});
afterEach(() => k.close());

async function ask(text: string) {
	const result = await k.runner.invoke<{ threadId: string }>(
		'assistant.sendMessage',
		{ text },
		ellie.actor,
	);
	if (result.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
	return k.llm.chatCalls.at(-1)?.system ?? '';
}

describe('a weekday that does not fit its date', () => {
	it('is pointed out to the model before it answers', async () => {
		// What the real model said: it answered about the 20th as if it were a Wednesday.
		k.llm.respondChat([{ text: 'There is no swimming on Wednesday 20 October.' }]);
		const system = await ask('Is there swimming on Wednesday 20 October?');
		expect(system).toContain(
			'The person wrote "Wednesday 20 October", but October 20, 2026 (2026-10-20) is a Tuesday, not a Wednesday.',
		);
		expect(system).toContain('Start your answer by telling the person');
	});

	it('is found in the words of another installed language', async () => {
		k.llm.respondChat([{ text: 'Salı.' }]);
		const system = await ask('20 Ekim Çarşamba yüzme var mı?');
		expect(system).toContain('is a Tuesday, not a Wednesday.');
	});

	it('reads all-numeric dates in the family order', async () => {
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ formatLocale: 'en-US' },
			systemActor('test'),
		);
		k.llm.respondChat([{ text: 'No.' }]);
		expect(await ask('Anything on Wednesday 10/20?')).toContain('is a Tuesday, not a Wednesday.');
	});

	it('adds nothing when the weekday fits', async () => {
		k.llm.respondChat([{ text: 'Yes.' }]);
		const system = await ask('Is there swimming on Tuesday 20 October?');
		expect(system).not.toContain('Checked in the person');
	});
});
