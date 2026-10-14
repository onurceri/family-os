import {
	type Actor,
	type ConversationProvider,
	defineCapability,
	isFamosError,
	type SharedContent,
	type ShareTarget,
	systemActor,
} from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

// The doors channels outside the app use: they never name the extension behind them.
const postSend = defineCapability({ id: 'post.send', label: 'post:cap', level: 'manage' });
const received: { actor: Actor; share: SharedContent; bytes: Uint8Array[] }[] = [];
const asked: { actor: Actor; question: { text: string; threadId: string | null } }[] = [];

const shareTarget: ShareTarget = {
	requires: postSend.id,
	limits: { maxFiles: 2, maxBytes: 10, accept: ['image/*', 'text/plain'] },
	async receive(_ctx, actor, share) {
		received.push({ actor, share, bytes: await Promise.all(share.files.map((f) => f.bytes())) });
	},
};
const conversation: ConversationProvider = {
	requires: postSend.id,
	async ask(_ctx, actor, question) {
		asked.push({ actor, question });
		return { threadId: 'thread_1', replyId: 'reply_1' };
	},
	async answer(_ctx, memberId, replyId) {
		const by = asked[0]?.actor;
		return replyId === 'reply_1' && by?.kind === 'member' && by.memberId === memberId
			? { status: 'done', text: 'Yes', draftIds: [] }
			: null;
	},
};
const post = defineTestExtension({
	id: 'post',
	capabilities: [postSend],
	shareTarget,
	conversation,
});

const code = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		if (isFamosError(error)) return error.code;
		throw error;
	}
	return 'ok';
};
const text = (t: string) => ({
	name: 'a.txt',
	type: 'text/plain',
	bytes: new TextEncoder().encode(t),
});

let k: TestKernel;
beforeEach(async () => {
	received.length = 0;
	asked.length = 0;
	k = await createTestKernel({ extensions: [post] });
});
afterEach(() => k.close());

describe('the share door', () => {
	it('hands a share to the target as the member, with its files', async () => {
		const admin = await k.member('admin');
		expect(k.shareLimits()).toEqual(shareTarget.limits);
		await k.share(admin.member.id, { channel: 'email', title: 'Hi', files: [text('hello')] });
		expect(received).toHaveLength(1);
		expect(received[0]?.actor).toEqual(admin.actor);
		expect(received[0]?.share).toMatchObject({ channel: 'email', title: 'Hi' });
		expect(received[0]?.share.files.map((f) => [f.name, f.type, f.size])).toEqual([
			['a.txt', 'text/plain', 5],
		]);
		expect(new TextDecoder().decode(received[0]?.bytes[0])).toBe('hello');
	});

	it('checks the member, the capability, the limits and the switch before the target', async () => {
		const admin = await k.member('admin');
		const member = await k.member('member');
		const share = (who: string, files = [text('x')]) => k.share(who, { channel: 'email', files });
		expect(await code(share(member.member.id))).toBe('forbidden');
		expect(await code(share('member_nobody'))).toBe('forbidden');
		expect(await code(share(admin.member.id, [text('x'), text('y'), text('z')]))).toBe(
			'bad_request',
		);
		expect(await code(share(admin.member.id, [text('far more than ten bytes')]))).toBe(
			'bad_request',
		);
		expect(
			await code(
				share(admin.member.id, [
					{ name: 'a.pdf', type: 'application/pdf', bytes: new Uint8Array(1) },
				]),
			),
		).toBe('bad_request');
		await k.runner.invoke(
			'core.setFeatureEnabled',
			{ extensionId: 'post', enabled: false },
			systemActor('test'),
		);
		expect(await code(share(admin.member.id))).toBe('feature_off');
		expect(received).toEqual([]);
	});

	it('is closed when no extension receives shares', async () => {
		const bare = await createTestKernel();
		try {
			const admin = await bare.member('admin');
			expect(bare.shareLimits()).toBeNull();
			expect(await code(bare.share(admin.member.id, { channel: 'email', files: [] }))).toBe(
				'feature_off',
			);
			expect(
				await code(bare.conversation.ask(admin.member.id, { text: 'Hi', threadId: null })),
			).toBe('feature_off');
			expect(await bare.conversation.answer(admin.member.id, 'reply_1')).toBeNull();
		} finally {
			await bare.close();
		}
	});
});

describe('the conversation door', () => {
	it('asks as the member and reads only their answer', async () => {
		const admin = await k.member('admin');
		const other = await k.member('admin');
		const sent = await k.conversation.ask(admin.member.id, { text: 'Milk?', threadId: null });
		expect(sent).toEqual({ threadId: 'thread_1', replyId: 'reply_1' });
		expect(asked).toEqual([{ actor: admin.actor, question: { text: 'Milk?', threadId: null } }]);
		expect(await k.conversation.answer(admin.member.id, 'reply_1')).toEqual({
			status: 'done',
			text: 'Yes',
			draftIds: [],
		});
		expect(await k.conversation.answer(other.member.id, 'reply_1')).toBeNull();
	});

	it('refuses a member without the capability, and everyone while it is off', async () => {
		const admin = await k.member('admin');
		const member = await k.member('member');
		const ask = (who: string) => k.conversation.ask(who, { text: 'Hi', threadId: null });
		expect(await code(ask(member.member.id))).toBe('forbidden');
		await k.runner.invoke(
			'core.setFeatureEnabled',
			{ extensionId: 'post', enabled: false },
			systemActor('test'),
		);
		expect(await code(ask(admin.member.id))).toBe('feature_off');
		expect(await k.conversation.answer(admin.member.id, 'reply_1')).toBeNull();
		expect(asked).toEqual([]);
	});
});
