import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import {
	defineAction,
	defineCapability,
	LlmError,
	systemActor,
	type UploadedFile,
} from '@famos/sdk';
import { createTestKernel, defineTestExtension, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type InboxItem, itemTitle, UPLOAD_LIMITS, UPLOAD_QUOTA } from '../src/contract/index.ts';
import inbox from '../src/server/index.ts';
import {
	EXTRACT_MAX_OUTPUT_TOKENS,
	processItem,
	repairInput,
	tidySummary,
} from '../src/server/process.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let parent: Awaited<ReturnType<TestKernel['member']>>;
let kid: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar, lists, inbox] });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: TZ, locale: 'tr' },
		systemActor('test'),
	);
	k.clock.set(epochOf('2026-10-06', '10:00', TZ)); // Tuesday
	parent = await k.member('admin', 'Ayşe');
	kid = await k.member('supervised', 'Elif');
	await k.runner.invoke(
		'core.updateMember',
		{ memberId: kid.member.id, about: '9 yaşında, 4-B sınıfı' },
		parent.actor,
	);
});
afterEach(() => k.close());

/** A structurally valid PNG with one tEXt chunk (CRCs are not checked by the stripper). */
function pngWith(keyword: string, value: string): Uint8Array {
	const chunk = (type: string, data: Uint8Array) => {
		const head = new Uint8Array(8);
		new DataView(head.buffer).setUint32(0, data.length);
		head.set(new TextEncoder().encode(type), 4);
		return [...head, ...data, 0, 0, 0, 0];
	};
	return Uint8Array.from([
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10,
		...chunk('IHDR', new Uint8Array(13)),
		...chunk('tEXt', new TextEncoder().encode(`${keyword}\0${value}`)),
		...chunk('IEND', new Uint8Array()),
	]);
}

function upload(name: string, type: string, data: string | Uint8Array): UploadedFile {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
	return {
		field: 'files',
		name,
		type,
		size: bytes.length,
		bytes: async () => bytes,
		async *stream() {
			yield bytes;
		},
	};
}

const share = (
	body: Record<string, unknown>,
	files: UploadedFile[] = [],
	actor = parent.actor,
): Promise<InboxItem> =>
	k.route('inbox.createItem').call({ body: { channel: 'share', ...body }, files, actor });
const items = (actor = parent.actor): Promise<InboxItem[]> =>
	k.route('inbox.listItems').call({ query: { limit: 30 }, actor });
const drafts = (actor = parent.actor) =>
	k.route('core.listDrafts').call({ query: { sourceKind: 'inbox', limit: 50 }, actor });

const NOTICE =
	'Sevgili veliler, 4-B sınıfı 17 Ekim Cuma günü hayvanat bahçesine gidecek. Gezi ücreti 150 TL, en geç Perşembe günü ödenmelidir.';

function proposals() {
	return {
		summary: 'Elif’in sınıfı 17 Ekim’de hayvanat bahçesine gidiyor; ücret Perşembe’ye kadar.',
		proposals: [
			{
				action: 'calendar.createEvent',
				input: {
					title: 'Hayvanat bahçesi gezisi',
					allDay: true,
					date: '2026-10-17',
					memberIds: ['member:2'], // handles, mapped back to ids
				},
				dateText: '17 Ekim Cuma',
				confidence: 0.9,
				uncertainFields: [],
			},
			{
				action: 'lists.addTask',
				input: {
					title: 'Gezi ücretini öde (150 TL)',
					dueDate: '2026-10-09',
					assigneeId: 'member:1',
				},
				dateText: 'en geç Perşembe',
				confidence: 0.7,
				uncertainFields: ['assigneeId'],
			},
			// Invalid: it ends before it starts. Dropped, counted as skipped.
			{
				action: 'calendar.createEvent',
				input: {
					title: 'Veli toplantısı',
					allDay: true,
					date: '2026-10-20',
					endDate: '2026-10-19',
				},
				confidence: 0.4,
				uncertainFields: [],
			},
		],
	};
}

describe('what the model is told about notes', () => {
	it('asks for notes that read on their own, never a bare number', async () => {
		k.llm.respond({ summary: 'Swim fee', proposals: [] });
		await share({ text: 'Swim course fee of 45, pay by Friday' });
		await k.worker.drain();
		expect(k.llm.calls[0]?.system).toContain('Never a bare number');
	});
});

describe('the language the model writes in', () => {
	it('names the family language through Intl, not a hand-written list', async () => {
		k.llm.respond({ summary: 'Kermes', proposals: [] });
		await share({ text: 'Pazartesi kermes' });
		await k.worker.drain();
		expect(k.llm.calls[0]?.system).toContain('in Turkish');

		await k.runner.invoke('core.updateFamilySettings', { locale: 'pt-BR' }, systemActor('test'));
		k.llm.respond({ summary: 'Festa', proposals: [] });
		await share({ text: 'Festa na segunda' });
		await k.worker.drain();
		expect(k.llm.calls[1]?.system).toContain('in Brazilian Portuguese');
	});
});

describe('what the AI may see', () => {
	it('sends no files when photos are off, and fails a photo-only item clearly', async () => {
		k.llm.privacy.sendFiles = false;
		k.llm.respond({ summary: 'Kermes', proposals: [] });
		await share({ text: 'Pazartesi kermes' }, [upload('a.png', 'image/png', pngWith('a', 'b'))]);
		const photoOnly = await share({}, [upload('b.png', 'image/png', pngWith('a', 'b'))]);
		await k.worker.drain();
		expect(k.llm.calls).toHaveLength(1);
		expect(k.llm.calls[0]?.files).toEqual([]);
		expect(k.llm.calls[0]?.role).toBe('smart');
		expect(k.llm.calls[0]?.prompt).toContain('1 attached file(s) not shared');
		const failed = (await items()).find((i) => i.id === photoOnly.id);
		expect(failed).toMatchObject({ status: 'failed', errorCode: 'files_off' });
	});

	it('keeps items unread while AI is off, and reads them on request', async () => {
		k.llm.privacy.enabled = false;
		const item = await share({ text: NOTICE });
		await k.worker.drain();
		expect(k.llm.calls).toHaveLength(0);
		expect((await items())[0]).toMatchObject({ id: item.id, status: 'held', errorCode: null });

		k.llm.privacy.enabled = true;
		k.llm.respond({ summary: 'x', proposals: [] });
		await k.runner.invoke('inbox.retryItem', { id: item.id }, parent.actor);
		await k.worker.drain();
		expect((await items())[0]).toMatchObject({ status: 'extracted' });
	});

	it('sends no names or "about" texts when people are off', async () => {
		k.llm.privacy.sendPeople = false;
		k.llm.respond({ summary: 'x', proposals: [] });
		await share({ text: NOTICE });
		await k.worker.drain();
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).not.toContain('Elif');
		expect(system).not.toContain('4-B sınıfı');
		expect(system).toContain('not shared: leave every member field empty');
	});

	it('rejects a malformed photo instead of storing it with its metadata', async () => {
		await expect(
			share({}, [upload('bad.jpg', 'image/jpeg', 'not really a jpeg')]),
		).rejects.toMatchObject({ code: 'bad_request' });
	});
});

describe('voice notes', () => {
	const voice = () => upload('voice.ogg', 'audio/ogg', new Uint8Array([79, 103, 103, 83, 1, 2]));
	const SAID = 'Cuma günü saat dörtte Elif’i okuldan al.';

	it('transcribes a voice-only item, then extracts from the transcript', async () => {
		k.llm.respondTranscript(SAID);
		k.llm.respond(proposals());
		const item = await share({}, [voice()]);
		await k.worker.drain();

		expect(k.llm.transcribeCalls).toHaveLength(1);
		expect(k.llm.transcribeCalls[0]).toMatchObject({
			feature: 'inbox.transcribe',
			mediaType: 'audio/ogg',
			filename: 'voice.ogg',
			language: 'tr',
			timeoutMs: 120_000,
			memberId: parent.member.id,
		});
		// The scripted answer has an invalid proposal, so the model is asked once more (no answer
		// is queued for that, and the first answer stands).
		expect(k.llm.calls).toHaveLength(2);
		expect(k.llm.calls[0]?.prompt).toContain(`--- Voice note ---\n${SAID}`);
		expect(k.llm.calls[0]?.files).toEqual([]);
		const [done] = await items();
		expect(done).toMatchObject({
			id: item.id,
			status: 'extracted',
			transcript: SAID,
			files: [{ name: 'voice.ogg', type: 'audio/ogg' }],
		});
	});

	it('does not duplicate text when a retry follows a failed transcription', async () => {
		k.llm.respondTranscript(new LlmError('unavailable', 'HTTP 503'), SAID);
		k.llm.respond({ summary: 'x', proposals: [] });
		await share({ text: 'Not' }, [voice()]);
		await k.worker.drain();
		expect(await items().then((i) => i[0]?.status)).toBe('received'); // waiting for the retry
		k.clock.advance(60_000);
		await k.worker.drain();

		expect(k.llm.transcribeCalls).toHaveLength(2);
		const prompt = k.llm.calls[0]?.prompt ?? '';
		expect(prompt.split('--- Voice note ---')).toHaveLength(2);
		expect(prompt.split(SAID)).toHaveLength(2);
		expect((await items())[0]).toMatchObject({ status: 'extracted', transcript: SAID });
	});

	it('keeps voice notes unread when they are not sent, and says so for a voice-only item', async () => {
		k.llm.privacy.sendVoice = false;
		k.llm.respond({ summary: 'x', proposals: [] });
		const only = await share({}, [voice()]);
		await share({ text: NOTICE }, [voice()]);
		await k.worker.drain();

		expect(k.llm.transcribeCalls).toHaveLength(0);
		const all = await items();
		expect(all.find((i) => i.id === only.id)).toMatchObject({
			status: 'failed',
			errorCode: 'voice_not_read',
			transcript: null,
		});
		// The item with text is read from its text.
		expect(k.llm.calls).toHaveLength(1);
		expect(k.llm.calls[0]?.prompt).toContain('hayvanat');
		expect(k.llm.calls[0]?.prompt).not.toContain('Voice note');
		expect(all.find((i) => i.id !== only.id)).toMatchObject({ status: 'extracted' });
	});

	it('continues without the transcript when no speech-to-text model is set, if there is text', async () => {
		k.llm.respondTranscript(new LlmError('not_configured', 'No model is set for "transcribe"'));
		k.llm.respond({ summary: 'x', proposals: [] });
		await share({ text: NOTICE }, [voice()]);
		await k.worker.drain();
		expect(k.llm.calls).toHaveLength(1);
		expect((await items())[0]).toMatchObject({ status: 'extracted', transcript: null });
	});

	it('fails a voice-only item when no model is set, and reads it again after the fix', async () => {
		k.llm.respondTranscript(new LlmError('not_configured', 'No model is set for "transcribe"'));
		const item = await share({}, [voice()]);
		await k.worker.drain();
		expect((await items())[0]).toMatchObject({ status: 'failed', errorCode: 'voice_not_read' });
		expect(k.llm.calls).toHaveLength(0);

		k.llm.respondTranscript(SAID);
		k.llm.respond({ summary: 'x', proposals: [] });
		await k.runner.invoke('inbox.retryItem', { id: item.id }, parent.actor);
		await k.worker.drain();
		expect((await items())[0]).toMatchObject({ status: 'extracted', transcript: SAID });
		expect(k.llm.calls[0]?.prompt).toContain(SAID);
	});

	it('keeps a voice-only item unread while AI is off, and transcribes it when read later', async () => {
		k.llm.privacy.enabled = false;
		const item = await share({}, [voice()]);
		await k.worker.drain();
		expect(k.llm.transcribeCalls).toHaveLength(0);
		expect((await items())[0]).toMatchObject({ status: 'held' });

		k.llm.privacy.enabled = true;
		k.llm.respondTranscript(SAID);
		k.llm.respond({ summary: 'x', proposals: [] });
		await k.runner.invoke('inbox.retryItem', { id: item.id }, parent.actor);
		await k.worker.drain();
		expect((await items())[0]).toMatchObject({ status: 'extracted', transcript: SAID });
	});

	it('serves audio files for playing in the page', async () => {
		const item = await share({}, [voice()]);
		const file = await k.route('inbox.getItemFile').call({
			params: { itemId: item.id, index: 0 },
			actor: parent.actor,
		});
		expect(file).toMatchObject({ contentType: 'audio/ogg', filename: 'voice.ogg' });
	});
});

describe('upload quota', () => {
	it("refuses uploads past a member's daily quota, counting what they already stored", async () => {
		const big = (size: number) => ({ ...upload('big.pdf', 'application/pdf', 'x'), size });
		await expect(share({}, [big(UPLOAD_QUOTA.bytes + 1)])).rejects.toMatchObject({
			code: 'limit_reached',
		});
		await share({}, [upload('note.txt', 'text/plain', 'hello')]);
		await expect(share({}, [big(UPLOAD_QUOTA.bytes - 1)])).rejects.toMatchObject({
			code: 'limit_reached',
		});
		// Another member has their own quota.
		await share({}, [big(UPLOAD_QUOTA.bytes - 1)], kid.actor);
	});
});

describe('shares from outside the app', () => {
	it('become items like an upload, through the kernel’s share door', async () => {
		expect(k.shareLimits()).toEqual(UPLOAD_LIMITS);
		const bytes = new TextEncoder().encode('Zoo trip on Friday');
		await k.share(parent.member.id, {
			channel: 'telegram',
			text: 'From the class chat',
			files: [{ name: 'note.txt', type: 'text/plain', bytes }],
		});
		const [item] = await items();
		expect(item).toMatchObject({ channel: 'telegram', text: 'From the class chat' });
		expect(item?.files.map((f) => [f.name, f.type])).toEqual([['note.txt', 'text/plain']]);
		// Only what the app accepts: an unknown channel or a malformed link is refused.
		await expect(
			k.share(parent.member.id, { channel: 'fax', text: 'x', files: [] }),
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			k.share(parent.member.id, { channel: 'email', url: 'not a link', files: [] }),
		).rejects.toMatchObject({ code: 'bad_request' });
		expect(await items()).toHaveLength(1);
	});
});

describe('inbox pipeline', () => {
	it('turns a shared notice into drafts that point back to the item', async () => {
		k.llm.respond(proposals());
		const item = await share({ text: NOTICE });
		expect(item.status).toBe('received');
		await k.worker.drain();

		const [done] = await items();
		expect(done).toMatchObject({
			id: item.id,
			status: 'extracted',
			proposals: 2,
			skipped: 1,
			errorCode: null,
		});
		expect(done?.summary).toMatch(/hayvanat/);
		const list = await drafts();
		expect(list).toHaveLength(2);
		expect(
			list.every(
				(d: { sourceId: string; status: string }) =>
					d.sourceId === item.id && d.status === 'pending',
			),
		).toBe(true);
		expect(
			list.find((d: { actionId: string }) => d.actionId === 'calendar.createEvent').input.memberIds,
		).toEqual([kid.member.id]);
		expect(list.find((d: { actionId: string }) => d.actionId === 'lists.addTask')).toMatchObject({
			// The model doubted the assignee; the code adds the deadline ("Perşembe" names no day).
			uncertainFields: ['assigneeId', 'dueDate'],
			confidence: 0.7,
		});
	});

	it('gives the model today, the family and the action schemas, and treats the item as data', async () => {
		k.llm.respond({ summary: 'x', proposals: [] });
		await share({ text: NOTICE });
		await k.worker.drain();
		const call = k.llm.calls[0];
		expect(call).toMatchObject({
			role: 'smart',
			feature: 'inbox.extract',
			memberId: parent.member.id,
		});
		expect(call?.system).toContain('Tuesday, 2026-10-06');
		// Names and the household's own description; no assumed parent/child roles.
		expect(call?.system).toContain('- Ayşe (member:1)\n');
		expect(call?.system).toContain('- Elif (member:2): 9 yaşında, 4-B sınıfı');
		expect(call?.system).not.toMatch(/parent|child\)/);
		expect(call?.system).not.toContain(kid.member.id);
		expect(call?.system).toContain('### calendar.createEvent');
		expect(call?.system).toContain('### lists.addShoppingItems');
		expect(call?.system).toContain('notes and the summary in Turkish');
		expect(call?.prompt).toContain('<shared_item channel="share">');
		expect(call?.prompt).toContain(NOTICE);
	});

	it('reads photos with the vision model and keeps files private to their item', async () => {
		k.llm.respond({ summary: 'Bir fotoğraf', proposals: [] });
		const png = pngWith('Location', 'Istanbul');
		const item = await share({}, [
			upload('duyuru.png', 'image/png', png),
			upload('notes.txt', 'text/plain', 'Pazartesi kermes'),
		]);
		await k.worker.drain();
		expect(k.llm.calls[0]).toMatchObject({ role: 'vision', files: [{ mediaType: 'image/png' }] });
		expect(k.llm.calls[0]?.prompt).toContain('Pazartesi kermes');
		const file = await k.route('inbox.getItemFile').call({ params: { itemId: item.id, index: 0 } });
		// Stored (and sent) without its text metadata.
		expect(file).toMatchObject({
			contentType: 'image/png',
			size: png.length - 12 - 'Location\0Istanbul'.length,
			filename: 'duyuru.png',
		});
		expect(Buffer.from(k.llm.calls[0]?.files?.[0]?.data ?? []).includes('Istanbul')).toBe(false);

		// An item cannot claim another item's files.
		await expect(
			k.runner.invoke(
				'inbox.addItem',
				{
					id: 'inbox_item_0192d3c4-0000-7000-8000-000000000001',
					channel: 'upload',
					files: [{ key: `inbox/${item.id}/0`, name: 'x', type: 'image/png', size: 8 }],
				},
				parent.actor,
			),
		).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('fails at once when no model is set, and reads the item again on retry', async () => {
		k.llm.respond(new LlmError('not_configured', 'No model is set for the "smart" role'));
		const item = await share({ text: NOTICE });
		await k.worker.drain();
		expect((await items())[0]).toMatchObject({ status: 'failed', errorCode: 'not_configured' });

		k.llm.respond(proposals());
		await k.runner.invoke('inbox.retryItem', { id: item.id }, parent.actor);
		await k.worker.drain();
		expect((await items())[0]).toMatchObject({ status: 'extracted', proposals: 2 });
		expect(k.llm.calls).toHaveLength(3); // the failure, the answer, its review
	});

	it('tells the model what is wrong once, and takes the fixed answer', async () => {
		const fixed = proposals();
		const third = fixed.proposals[2] as { input: Record<string, unknown> };
		third.input = { title: 'Veli toplantısı', date: '2026-10-20', startTime: '18:00' };
		k.llm.respond(proposals(), fixed);
		await share({ text: `${NOTICE} Veli toplantısı 20 Ekim 18:00.` });
		await k.worker.drain();
		expect(k.llm.calls).toHaveLength(2);
		const review = k.llm.calls[1]?.prompt ?? '';
		expect(review).toContain('<review>');
		expect(review).toMatch(/Proposal 3 \(calendar\.createEvent\) is invalid: .*endDate/);
		expect(review).toContain('The item states 18:00');
		expect((await items())[0]).toMatchObject({ status: 'extracted', proposals: 3 });
	});

	it('does not ask again when the answer is fine', async () => {
		k.llm.respond({ summary: 'Kermes', proposals: [] });
		await share({ text: 'Pazartesi kermes' });
		await k.worker.drain();
		expect(k.llm.calls).toHaveLength(1);
	});

	it('retries outages and does not duplicate drafts when a step runs twice', async () => {
		k.llm.respond(new LlmError('unavailable', 'HTTP 503'), proposals(), proposals());
		const item = await share({ text: NOTICE });
		await k.worker.drain();
		expect((await items())[0]?.status).toBe('normalized'); // waiting for the retry
		k.clock.advance(60_000);
		await k.worker.drain();
		expect((await items())[0]?.status).toBe('extracted');
		expect(await drafts()).toHaveLength(2);

		// A crash after drafting but before saving the status: the job runs again.
		await k.ctx.db
			.updateTable('inbox_items' as never)
			.set({ status: 'normalized' } as never)
			.execute();
		await processItem.handle(
			{ ...k.ctx, llm: k.llm },
			{ itemId: item.id },
			{ id: 'job_x', attempt: 1, maxAttempts: 4 },
		);
		expect(await drafts()).toHaveLength(2);
	});

	it('keeps an event that has a day but no time as an all-day event the person checks', async () => {
		k.llm.respond({
			summary: 'Choir rehearsal',
			proposals: [
				{
					action: 'calendar.createEvent',
					input: { title: 'Choir rehearsal', date: '2026-10-08', location: 'Hall' },
					dateText: 'Thursday',
					confidence: 0.8,
					uncertainFields: [],
				},
			],
		});
		await share({ text: 'Choir rehearsal moved to Thursday, bring your folder' });
		await k.worker.drain();
		// Nothing is wrong with the answer, so the model is not asked again.
		expect(k.llm.calls).toHaveLength(1);
		expect((await items())[0]).toMatchObject({ status: 'extracted', proposals: 1, skipped: 0 });
		const [draft] = await drafts();
		expect(draft.input).toMatchObject({ allDay: true, date: '2026-10-08', location: 'Hall' });
		expect(draft.input.startTime).toBeUndefined();
		expect(draft.uncertainFields).toEqual(expect.arrayContaining(['startTime', 'allDay']));
	});

	it('limits what the model may write, and fails an answer that hit the limit at once', async () => {
		k.llm.respond(new LlmError('output_too_long', 'cut off'), proposals());
		await share({ text: NOTICE });
		await k.worker.drain();
		expect(k.llm.calls).toHaveLength(1); // not tried again
		expect(k.llm.calls[0]?.maxOutputTokens).toBe(EXTRACT_MAX_OUTPUT_TOKENS);
		expect(k.llm.calls[0]?.reasoning).toBeUndefined();
		expect((await items())[0]).toMatchObject({
			status: 'failed',
			errorCode: 'output_too_long',
			attempt: null,
		});
	});

	it('shows which attempt a failed reading waits for, and refuses to retry one that is running', async () => {
		k.llm.respond(new LlmError('timeout', 'slow'), new LlmError('timeout', 'slow'), proposals());
		const item = await share({ text: NOTICE });
		await k.worker.drain();
		expect((await items())[0]).toMatchObject({ status: 'normalized', attempt: 2 });
		await expect(
			k.runner.invoke('inbox.retryItem', { id: item.id }, parent.actor),
		).rejects.toMatchObject({ code: 'conflict' });
		expect((await items())[0]).toMatchObject({ status: 'normalized', attempt: 2 });

		k.clock.advance(60_000);
		await k.worker.drain();
		expect((await items())[0]).toMatchObject({ status: 'normalized', attempt: 3 });
		k.clock.advance(120_000);
		await k.worker.drain();
		expect((await items())[0]).toMatchObject({ status: 'extracted', attempt: null });
	});

	it('lists the existing calendar tags in the prompt, as plain words', async () => {
		k.llm.respond({ summary: 'x', proposals: [] });
		await share({ text: NOTICE });
		await k.worker.drain();
		expect(k.llm.calls[0]?.system).not.toContain('Existing calendar tags');

		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'Swim', allDay: true, date: '2026-10-10', tags: ['swim club', 'School'] },
			parent.actor,
		);
		k.llm.respond({ summary: 'x', proposals: [] });
		await share({ text: 'Swim meet' });
		await k.worker.drain();
		const system = k.llm.calls.at(-1)?.system ?? '';
		expect(system).toContain('Existing calendar tags: School, swim club');
		expect(system).not.toContain('calendar_tag:');
		expect(system).not.toContain('### calendar.aiContext');
		// Tags are words to reuse, never records with handles.
		expect(system).not.toMatch(/- (School|swim club) \(/);
	});

	it('tells the model who shared the item, by handle only when names are off', async () => {
		k.llm.respond({ summary: 'x', proposals: [] });
		await share({ text: NOTICE });
		await k.worker.drain();
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).toContain('This item was shared by Ayşe (member:1).');
		expect(system).toContain('The person who shared the item (member:1)');

		k.llm.privacy.sendPeople = false;
		k.llm.respond({ summary: 'x', proposals: [] });
		await share({ text: NOTICE });
		await k.worker.drain();
		const anonymous = k.llm.calls.at(-1)?.system ?? '';
		expect(anonymous).toContain('This item was shared by member:1.');
		expect(anonymous).not.toContain('Ayşe');
	});

	it('lets supervised members share; someone who may approve decides the drafts', async () => {
		k.llm.respond(proposals());
		const item = await share({ text: NOTICE }, [], kid.actor);
		await k.worker.drain();
		expect((await items())[0]).toMatchObject({
			id: item.id,
			createdBy: kid.member.id,
			proposals: 2,
		});
		const [draft] = await drafts();
		await expect(k.runner.approveDraft(draft.id, kid.actor)).rejects.toMatchObject({
			code: 'forbidden',
		});
		expect((await k.runner.approveDraft(draft.id, parent.actor)).status).toBe('applied');
	});

	it('keeps the item of every waiting suggestion in the list, however many newer items there are', async () => {
		const other = proposals();
		other.proposals = [
			{ ...other.proposals[0], input: { ...other.proposals[0]?.input, title: 'Kermes' } },
		] as typeof other.proposals;
		k.llm.respond(proposals());
		const first = await share({ text: 'Veli toplantısı' }, [], kid.actor);
		await k.worker.drain();
		k.llm.respond(other);
		const second = await share({ text: 'Kermes' }, [], kid.actor);
		await k.worker.drain();
		k.llm.respond({ summary: 'x', proposals: [] });
		const newest = await share({ text: 'Merhaba' }, [], kid.actor);
		await k.worker.drain();
		const asParent = (await k
			.route('inbox.listItems')
			.call({ query: { limit: 1 }, actor: parent.actor })) as InboxItem[];
		const ids = asParent.map((i) => i.id);
		expect(ids).toContain(first.id);
		expect(ids).toContain(second.id);
		expect(ids).not.toContain(newest.id);
	});

	it('shows supervised members only their own items and files', async () => {
		k.llm.respond({ summary: 'x', proposals: [] }, proposals());
		const png = pngWith('a', 'b');
		const parents = await share({ text: 'Veli toplantısı' }, [upload('a.png', 'image/png', png)]);
		const own = await share({ text: 'Kermes' }, [], kid.actor);
		await k.worker.drain();
		const asKid = (await k
			.route('inbox.listItems')
			.call({ query: { limit: 30 }, actor: kid.actor })) as InboxItem[];
		expect(asKid.map((i) => i.id)).toEqual([own.id]);
		const asParent = (await k
			.route('inbox.listItems')
			.call({ query: { limit: 30 }, actor: parent.actor })) as InboxItem[];
		expect(asParent).toHaveLength(2);
		await expect(
			k
				.route('inbox.getItemFile')
				.call({ params: { itemId: parents.id, index: 0 }, actor: kid.actor }),
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(
			k.runner.invoke('inbox.dismissItem', { id: parents.id }, kid.actor),
		).rejects.toMatchObject({ code: 'forbidden' });
		expect((await k.runner.invoke('inbox.dismissItem', { id: own.id }, kid.actor)).status).toBe(
			'applied',
		);
	});

	it('rejects empty items and hides dismissed ones', async () => {
		await expect(share({})).rejects.toMatchObject({ code: 'bad_request' });
		k.llm.respond({ summary: 'x', proposals: [] });
		const item = await share({ text: 'Merhaba' });
		await k.runner.invoke('inbox.dismissItem', { id: item.id }, parent.actor);
		expect(await items()).toEqual([]);
	});

	it('rejects the waiting suggestions of an item that is removed', async () => {
		k.llm.respond(proposals());
		const item = await share({ text: NOTICE });
		await k.worker.drain();
		expect((await drafts()).map((d: { status: string }) => d.status)).toEqual([
			'pending',
			'pending',
		]);
		await k.runner.invoke('inbox.dismissItem', { id: item.id }, parent.actor);
		expect((await drafts()).map((d: { status: string }) => d.status)).toEqual([
			'rejected',
			'rejected',
		]);
	});

	it('repairs model habits: null fields and nested values written as JSON text', async () => {
		expect(
			repairInput({
				a: null,
				b: [{ c: null, d: 1 }],
				e: 'x',
				f: '["m"]',
				g: '{"freq":"weekly"}',
				h: '[not json',
			}),
		).toEqual({
			b: [{ d: 1 }],
			e: 'x',
			f: ['m'],
			g: { freq: 'weekly' },
			h: '[not json',
		});
		k.llm.respond({
			summary: 'Toplantı',
			proposals: [
				{
					action: 'calendar.createEvent',
					input: {
						title: 'Veli toplantısı',
						date: '2026-10-20',
						startTime: '18:00',
						memberIds: '[]',
						recurrence: null,
					},
					confidence: 0.9,
				},
			],
		});
		await share({ text: 'Veli toplantısı 20 Ekim 18:00' });
		await k.worker.drain();
		expect((await items())[0]).toMatchObject({ proposals: 1, skipped: 0 });
	});

	it('marks dates "check this" when their quoted source names no day', async () => {
		const event = (date: string, dateText?: string) => ({
			action: 'calendar.createEvent',
			input: { title: 'Dişçi', date, startTime: '16:30' },
			confidence: 0.9,
			uncertainFields: [],
			...(dateText && { dateText }),
		});
		k.llm.respond({
			summary: 'x',
			proposals: [
				event('2026-10-15', 'next Thursday'),
				event('2026-10-16', '16 Ekim Cuma'),
				event('2026-10-17'),
			],
		});
		const item = await share({ text: 'Dentist next Thursday 4:30pm' });
		await k.worker.drain();
		expect(k.llm.calls[0]?.system).toContain('- Thursday 2026-10-15 (next week)');
		const byDate = Object.fromEntries(
			(await drafts())
				.filter((d: { sourceId: string }) => d.sourceId === item.id)
				.map((d: { input: { date: string }; uncertainFields: string[] }) => [
					d.input.date,
					d.uncertainFields,
				]),
		);
		expect(byDate).toEqual({ '2026-10-15': ['date'], '2026-10-16': [], '2026-10-17': ['date'] });
	});

	it('undoes an approved draft with its inverse action, keeping what was there before', async () => {
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'Süt', category: 'dairy' }] },
			parent.actor,
		);
		k.llm.respond({
			summary: 'x',
			proposals: [
				{
					action: 'calendar.createEvent',
					input: { title: 'Kermes', date: '2026-10-24', startTime: '11:00' },
					dateText: '24 Ekim',
					confidence: 1,
				},
				{
					action: 'lists.addShoppingItems',
					input: { items: [{ title: 'süt' }, { title: 'Ekmek' }] },
					confidence: 1,
				},
			],
		});
		await share({ text: 'Kermes 24 Ekim 11:00; süt ve ekmek al' });
		await k.worker.drain();
		const [event, shopping] = (await drafts()).reverse();
		expect(event.undoable).toBe(false); // pending
		await k.runner.approveDraft(event.id, parent.actor);
		await k.runner.approveDraft(shopping.id, parent.actor);
		const day = () =>
			k.route('calendar.listOccurrences').call({ query: { from: '2026-10-24', to: '2026-10-24' } });
		const shoppingTitles = async () => {
			const [list] = await k.route('lists.listShoppingLists').call();
			return (await k.route('lists.listShoppingItems').call({ params: { listId: list.id } })).map(
				(i: { title: string }) => i.title,
			);
		};
		expect(await day()).toHaveLength(1);
		expect(await shoppingTitles()).toEqual(['Süt', 'Ekmek']);
		expect((await drafts()).every((d: { undoable: boolean }) => d.undoable)).toBe(true);

		// Addressed to the person who shared it: nobody else even learns it exists.
		await expect(k.runner.undoDraft(event.id, kid.actor)).rejects.toMatchObject({
			code: 'not_found',
		});
		expect((await k.runner.undoDraft(event.id, parent.actor)).status).toBe('undone');
		expect((await k.runner.undoDraft(event.id, parent.actor)).status).toBe('undone'); // idempotent
		await k.runner.undoDraft(shopping.id, parent.actor);
		expect(await day()).toEqual([]);
		expect(await shoppingTitles()).toEqual(['Süt']); // milk was already on the list
		expect(
			(await drafts()).map((d: { status: string; undoable: boolean }) => [d.status, d.undoable]),
		).toEqual([
			['undone', false],
			['undone', false],
		]);
	});
});

/** A sensitive area whose action the AI may propose. */
const stashEdit = defineCapability({ id: 'stash.edit', label: 'stash:cap_edit', level: 'edit' });
const stashView = defineCapability({ id: 'stash.view', label: 'stash:cap_view', level: 'view' });
const stash = defineTestExtension({
	id: 'stash',
	sensitive: true,
	capabilities: [stashView, stashEdit],
	actions: [
		defineAction({
			id: 'stash.listRecords',
			title: 'List the records',
			input: z.object({}),
			output: z.object({ records: z.array(z.string()) }),
			readOnly: true,
			requires: stashView.id,
			async run() {
				return { records: ['account 4455-SECRET'] };
			},
		}),
		defineAction({
			id: 'stash.addRecord',
			title: 'Add a record',
			input: z.object({ title: z.string() }),
			output: z.object({}),
			approval: { unless: stashEdit.id },
			ai: { description: 'Adds a stash record.' },
			async run() {
				return {};
			},
		}),
	],
});

describe('AI areas in the inbox', () => {
	let admin: Awaited<ReturnType<TestKernel['member']>>;
	beforeEach(async () => {
		await k.close();
		k = await createTestKernel({ extensions: [calendar, lists, stash, inbox] });
		admin = await k.member('admin', 'Ayşe');
		k.llm.respond({ summary: 'x', proposals: [] });
	});
	const setArea = (extensionId: string, access: 'off' | 'local' | 'any') =>
		k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId, access, confirmSensitive: true },
			admin.actor,
		);
	const read = async () => {
		await share({ text: NOTICE }, [], admin.actor);
		await k.worker.drain();
		return (await items(admin.actor))[0];
	};

	it('keeps a sensitive area out of the prompt and the areas of the call by default', async () => {
		expect(await read()).toMatchObject({ status: 'extracted' });
		const call = k.llm.calls[0];
		expect(call?.system).toContain('calendar.createEvent');
		expect(call?.system).not.toContain('stash.addRecord');
		expect(call?.areas).toEqual(expect.arrayContaining(['inbox', 'calendar', 'lists']));
		expect(call?.areas).not.toContain('stash');
	});

	it('sends nothing of a sensitive area that is off: no data, no action names, no area', async () => {
		await read();
		const seenByModel = JSON.stringify(
			k.llm.calls.map(({ system, prompt, areas, jsonSchema }) => ({
				system,
				prompt,
				areas,
				jsonSchema,
			})),
		);
		expect(k.llm.calls).toHaveLength(1);
		expect(seenByModel).not.toMatch(/stash|SECRET/i);
		// Reading it as the AI is refused too, so no prompt builder could pull it in.
		await expect(
			k.runner.invoke('stash.listRecords', {}, { kind: 'ai', mode: 'share', source: 'inbox' }),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(k.runner.invoke('stash.listRecords', {}, admin.actor)).resolves.toMatchObject({
			status: 'applied',
		});
	});

	it('offers a local-only area only to a local model', async () => {
		await setArea('stash', 'local');
		expect(await read()).toMatchObject({ status: 'extracted' });
		expect(k.llm.calls[0]?.system).not.toContain('stash.addRecord');
		expect(k.llm.calls[0]?.areas).not.toContain('stash');

		k.llm.privacy.local = true;
		k.llm.respond({ summary: 'x', proposals: [] });
		await share({ text: `${NOTICE} Yine.` }, [], admin.actor);
		await k.worker.drain();
		expect(k.llm.calls[1]?.system).toContain('stash.addRecord');
		expect(k.llm.calls[1]?.areas).toContain('stash');
	});

	it('offers a sensitive area to any provider once the family chose so', async () => {
		await setArea('stash', 'any');
		await read();
		expect(k.llm.calls[0]?.system).toContain('stash.addRecord');
		expect(k.llm.calls[0]?.areas).toContain('stash');
	});

	it('leaves areas that are off out of the catalog', async () => {
		await setArea('calendar', 'off');
		await read();
		expect(k.llm.calls[0]?.system).not.toContain('calendar.createEvent');
		expect(k.llm.calls[0]?.areas).not.toContain('calendar');
		expect(k.llm.calls[0]?.areas).toContain('lists');
	});

	it('holds items while the inbox itself is off for the AI', async () => {
		await setArea('inbox', 'off');
		expect(await read()).toMatchObject({ status: 'held', errorCode: null });
	});

	it('fails with ai_local_required when the inbox is local-only and no local model is set', async () => {
		await setArea('inbox', 'local');
		expect(await read()).toMatchObject({ status: 'failed', errorCode: 'ai_local_required' });
		// A local model fixes it.
		k.llm.privacy.local = true;
		await k.runner.invoke(
			'inbox.retryItem',
			{ id: (await items(admin.actor))[0]?.id },
			admin.actor,
		);
		await k.worker.drain();
		expect((await items(admin.actor))[0]).toMatchObject({ status: 'extracted' });
	});

	it('names the inbox as the area of voice notes', async () => {
		k.llm.respondTranscript('Okul gezisi cuma günü.');
		await share({}, [upload('v.ogg', 'audio/ogg', new Uint8Array([1, 2, 3]))], admin.actor);
		await k.worker.drain();
		expect(k.llm.transcribeCalls[0]?.areas).toEqual(['inbox']);
	});
});

describe('auto-approval', () => {
	const approveTasks = () =>
		k.runner.invoke(
			'core.setAutoApproval',
			{
				actionId: 'lists.addTask',
				setting: { proposerCapability: 'lists.tasks.edit' },
			},
			parent.actor,
		);
	const taskTitles = async () =>
		(await k.route('lists.listTasks').call()).map((t: { title: string }) => t.title);

	it('approves the tasks of items shared by someone who may edit tasks, nothing else', async () => {
		await approveTasks();
		k.llm.respond(proposals());
		await share({ text: NOTICE });
		await k.worker.drain();
		expect(await taskTitles()).toEqual(['Gezi ücretini öde (150 TL)']);
		const list = await drafts();
		expect(
			list.map((d: { actionId: string; status: string }) => `${d.actionId}:${d.status}`).sort(),
		).toEqual(['calendar.createEvent:pending', 'lists.addTask:applied']);
		expect(
			list.find((d: { actionId: string }) => d.actionId === 'lists.addTask')?.autoApproved,
		).toBe(true);
	});

	it('leaves everything the AI read from shared items when no setting exists', async () => {
		k.llm.respond(proposals());
		await share({ text: NOTICE });
		await k.worker.drain();
		expect(await taskTitles()).toEqual([]);
	});

	it('leaves the drafts of items a supervised member shared', async () => {
		await approveTasks();
		k.llm.respond(proposals());
		await share({ text: NOTICE }, [], kid.actor);
		await k.worker.drain();
		expect(await taskTitles()).toEqual([]);
	});
});

describe('what the model made of an item', () => {
	it('stores a question as a question, with no proposals, and answers nothing', async () => {
		k.llm.respond({ summary: 'Soru', kind: 'question', proposals: [] });
		await share({ text: 'nereye gidiyor?' });
		await k.worker.drain();
		const [item] = await items();
		expect(item).toMatchObject({ status: 'extracted', kind: 'question', proposals: 0 });
		expect(k.llm.calls[0]?.system).toContain('never answer it');
	});

	it('stores the other kinds and treats a missing kind as actionable', async () => {
		k.llm.respond({ summary: 'Hava durumu', kind: 'nothing', proposals: [] });
		await share({ text: 'Hava çok güzel' });
		k.llm.respond({ summary: 'Kermes', proposals: [] });
		await share({ text: 'Pazartesi kermes' });
		await k.worker.drain();
		expect((await items()).map((i) => i.kind).sort()).toEqual(['actionable', 'nothing']);
	});

	it('keeps the label short: one line, cut at a word, never a failure', async () => {
		const long = `Okul gezisi bildirimi ${'çok uzun bir açıklama '.repeat(20)}`;
		k.llm.respond({ summary: `  ${long}\n`, kind: 'nothing', proposals: [] });
		await share({ text: NOTICE });
		await k.worker.drain();
		const [item] = await items();
		expect(item?.status).toBe('extracted');
		expect(item?.summary?.length).toBeLessThanOrEqual(80);
		expect(item?.summary).toMatch(/…$/);
		expect(item?.summary).toMatch(/^Okul gezisi bildirimi/);
	});

	it('tidies the label', () => {
		expect(tidySummary('  School   trip\nnotice ')).toBe('School trip notice');
		expect(tidySummary('   ')).toBeNull();
		expect(tidySummary('Where is it going?')).toBe('Where is it going');
		expect(tidySummary('Dentist reminder.')).toBe('Dentist reminder');
		expect(tidySummary('?')).toBeNull();
	});
});

describe('how an item is named', () => {
	const base = {
		title: null,
		text: null,
		url: null,
		transcript: null,
		summary: null,
		files: [],
	};
	it('uses the typed words of a short plain text, not the model label', () => {
		const item = { ...base, text: 'nereye gidiyor?', summary: 'Soru' };
		expect(itemTitle(item)).toBe('nereye gidiyor?');
	});
	it('prefers an explicit title', () => {
		expect(itemTitle({ ...base, title: 'Dentist', text: 'Call them', summary: 'x' })).toBe(
			'Dentist',
		);
	});
	it('uses the label for long text, several paragraphs, files or voice', () => {
		const label = 'School trip notice';
		expect(itemTitle({ ...base, text: 'x'.repeat(121), summary: label })).toBe(label);
		expect(itemTitle({ ...base, text: 'One\n\nTwo', summary: label })).toBe(label);
		expect(itemTitle({ ...base, text: 'Look', summary: label, files: [{ name: 'a.png' }] })).toBe(
			label,
		);
		expect(itemTitle({ ...base, text: 'Look', summary: label, transcript: 'Look' })).toBe(label);
	});
	it('falls back to the first line, then the file name', () => {
		expect(itemTitle({ ...base, text: `${'a'.repeat(130)}\nb` })).toBe('a'.repeat(120));
		expect(itemTitle({ ...base, files: [{ name: 'bill.pdf' }] })).toBe('bill.pdf');
	});
});

describe('ownership', () => {
	let other: Awaited<ReturnType<TestKernel['member']>>;
	beforeEach(async () => {
		other = await k.member('member', 'Can');
	});
	const readyNotices = () =>
		k.ctx.db
			.withTables<{
				core_notifications: { kind: string; member_id: string; title: string; source_id: string };
			}>()
			.selectFrom('core_notifications')
			.selectAll()
			.where('kind', '=', 'inbox.itemReady')
			.execute();
	const waitingNotices = async () => {
		k.clock.advance(60_000);
		await k.worker.drain();
		return k.ctx.db
			.withTables<{ core_notifications: { kind: string; member_id: string } }>()
			.selectFrom('core_notifications')
			.select('member_id')
			.where('kind', '=', 'core.draftWaiting')
			.execute();
	};

	it('shows an adult’s capture to nobody else, and tells no other adult', async () => {
		k.llm.respond(proposals());
		const png = pngWith('a', 'b');
		const mine = await share({ text: NOTICE }, [upload('a.png', 'image/png', png)]);
		await k.worker.drain();
		expect(await items(parent.actor)).toHaveLength(1);
		expect(await items(other.actor)).toEqual([]);
		expect(await items(kid.actor)).toEqual([]);
		await expect(
			k
				.route('inbox.getItemFile')
				.call({ params: { itemId: mine.id, index: 0 }, actor: other.actor }),
		).rejects.toMatchObject({ code: 'not_found' });
		// Nor can they act on it: not dismiss, retry or file.
		await expect(
			k.runner.invoke('inbox.dismissItem', { id: mine.id }, other.actor),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			k.runner.invoke('inbox.retryItem', { id: mine.id }, other.actor),
		).rejects.toMatchObject({ code: 'forbidden' });
		// The suggestions are the sharer's alone.
		expect(await drafts(other.actor)).toEqual([]);
		expect(await drafts(parent.actor)).toHaveLength(2);
		expect(await waitingNotices()).toEqual([]);
	});

	it('shows a supervised member’s capture to the approvers, who are told', async () => {
		k.llm.respond(proposals());
		const png = pngWith('a', 'b');
		const theirs = await share({ text: NOTICE }, [upload('a.png', 'image/png', png)], kid.actor);
		await k.worker.drain();
		for (const approver of [parent, other]) {
			expect((await items(approver.actor)).map((i) => i.id)).toEqual([theirs.id]);
			const file = await k
				.route('inbox.getItemFile')
				.call({ params: { itemId: theirs.id, index: 0 }, actor: approver.actor });
			expect(file.contentType).toBe('image/png');
			// Seeing it is not owning it.
			await expect(
				k.runner.invoke('inbox.dismissItem', { id: theirs.id }, approver.actor),
			).rejects.toMatchObject({ code: 'forbidden' });
		}
		expect((await waitingNotices()).map((n) => n.member_id).sort()).toEqual(
			[parent.member.id, other.member.id].sort(),
		);
		// Once decided, it leaves their view.
		for (const d of await drafts(parent.actor)) await k.runner.rejectDraft(d.id, parent.actor);
		expect(await items(other.actor)).toEqual([]);
		expect(await items(kid.actor)).toHaveLength(1);
	});

	it('tells the sharer, and only them, when an item from outside the app is ready', async () => {
		k.llm.respond(proposals());
		const item = await share({ channel: 'telegram', text: NOTICE });
		await k.worker.drain();
		const notices = await readyNotices();
		expect(notices.map((n) => [n.member_id, n.source_id])).toEqual([[parent.member.id, item.id]]);
		expect(await waitingNotices()).toEqual([]);
	});

	it('sends nothing for items from the app, or with nothing to add', async () => {
		k.llm.respond(proposals(), { summary: 'Nothing', kind: 'nothing', proposals: [] });
		await share({ channel: 'upload', text: NOTICE });
		await share({ channel: 'email', text: 'Newsletter' });
		await k.worker.drain();
		expect(await readyNotices()).toEqual([]);
	});
});
