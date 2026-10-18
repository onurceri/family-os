import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notInstalledPackages } from '../eval/harness.ts';
import assistant from '../src/server/index.ts';
import { loopTurns } from './reading.ts';

type Asker = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let mara: Asker;

beforeEach(async () => {
	// Mara's household after she uninstalled Home: the package is still shipped, so it can come back.
	k = await createTestKernel({
		extensions: [calendar, lists, assistant],
		translate: repoTranslate(),
		extensionPackages: notInstalledPackages(['home']),
	});
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ locale: 'en', timeZone: 'Europe/Ljubljana' },
		systemActor('test'),
	);
	mara = await k.member('admin', 'Mara');
});
afterEach(() => k.close());

async function ask(text: string) {
	const result = await k.runner.invoke<{ threadId: string }>(
		'assistant.sendMessage',
		{ text },
		mara.actor,
	);
	if (result.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
	return k.llm.chatCalls.at(-1)?.system ?? '';
}

describe('areas that are not here', () => {
	it('are named with why, so "where are the flat papers?" gets "Home is not installed here"', async () => {
		// The real answer read empty notes and duties as "no household obligations for the flat".
		loopTurns(k.llm, [{ text: 'Home is not installed here.' }]);
		const system = await ask('Where do we keep the flat papers, and what is due this month?');
		expect(system).toContain(
			'Not here: areas of FamilyOS you cannot look into (worked out by FamilyOS, true):\n- Home (not installed here): The household',
		);
		expect(system).toContain('name that area and say why you cannot see it');
	});

	it('include an area closed to the AI, with its own name', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'calendar', access: 'off' },
			systemActor('test'),
		);
		loopTurns(k.llm, [{ text: 'I cannot see the calendar.' }]);
		const system = await ask("What's on tomorrow?");
		expect(system).toContain('- Calendar (closed to you in the AI settings)');
		expect(system).toContain('- Home (not installed here)');
	});
});
