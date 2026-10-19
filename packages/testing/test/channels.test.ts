import { defineNotificationKind } from '@famos/sdk';
import { afterEach, expect, it } from 'vitest';
import { createFakeExtensionChannel, createTestKernel, defineTestExtension } from '../src/index.ts';

const kind = defineNotificationKind({ id: 'doorbell.rang', label: 'doorbell:kind_rang' });

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

it('lets an extension test register a channel and see what it was sent', async () => {
	const channel = createFakeExtensionChannel('doorbell');
	const k = await createTestKernel({
		extensions: [
			defineTestExtension({ id: 'doorbell', notifications: [kind], channels: [channel] }),
		],
		publicUrl: 'https://home.example',
	});
	close = () => k.close();
	const { member } = await k.member('admin');
	await k.ctx.notify({
		kind: 'doorbell.rang',
		to: { members: [member.id] },
		title: { key: 'doorbell:title' },
		url: '/today',
	});
	await k.worker.drain();
	expect(channel.sent).toHaveLength(1);
	expect(channel.sent[0]?.memberId).toBe(member.id);
	expect(channel.sent[0]?.message.link).toBe('https://home.example/today');
});
