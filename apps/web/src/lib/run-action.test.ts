import { beforeEach, describe, expect, it, vi } from 'vitest';

const shown: string[] = [];
vi.mock('./toast.svelte.js', () => ({ toasts: { show: (m: string) => shown.push(m) } }));
vi.mock('./i18n.svelte.js', () => ({
	t: (key: string) => key,
	tDynamic: (key: string) => key,
}));

const { runAction } = await import('./run-action.js');

const answer = <T>(status: number, body: { data?: T; error?: unknown }) => ({
	...body,
	response: new Response(null, { status, statusText: 'x' }),
});

beforeEach(() => {
	shown.length = 0;
});

describe('runAction', () => {
	it('returns the data, says it was saved and reloads', async () => {
		const reload = vi.fn();
		const result = await runAction(Promise.resolve(answer(200, { data: { id: 'a' } })), {
			saved: 'Saved',
			reload,
		});
		expect(result).toEqual({ ok: true, data: { id: 'a' } });
		expect(shown).toEqual(['Saved']);
		expect(reload).toHaveBeenCalledOnce();
	});

	it('says nothing on success unless asked, and not on failure', async () => {
		await runAction(Promise.resolve(answer(200, { data: 1 })));
		await runAction(Promise.resolve(answer(500, { error: {} })), { saved: 'Saved' });
		expect(shown).toEqual(['error_generic']);
	});

	it('explains a refusal by its reason and does not reload', async () => {
		const reload = vi.fn();
		const result = await runAction(
			Promise.resolve(
				answer(403, { error: { error: { code: 'forbidden', message: 'no', reason: 'approval' } } }),
			),
			{ reload },
		);
		expect(result).toMatchObject({ ok: false, reason: 'refused', message: 'app:refused_approval' });
		expect(shown).toEqual(['app:refused_approval']);
		expect(reload).not.toHaveBeenCalled();
	});

	it('uses the words for a bad request when given, the generic ones otherwise', async () => {
		const bad = () => answer(400, { error: { error: { code: 'bad_request', message: 'x' } } });
		const withWords = await runAction(Promise.resolve(bad()), { invalid: 'Check it' });
		expect(withWords).toMatchObject({ ok: false, reason: 'bad_request', message: 'Check it' });
		const without = await runAction(Promise.resolve(bad()));
		expect(without).toMatchObject({ ok: false, message: 'error_generic' });
	});

	it('hands the failure to onError instead of a notice', async () => {
		const onError = vi.fn();
		await runAction(Promise.resolve(answer(500, { error: {} })), { onError });
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ reason: 'unknown', message: 'error_generic' }),
		);
		expect(shown).toEqual([]);
	});

	it('reports a network failure as unreachable and never throws', async () => {
		const result = await runAction(Promise.reject(new TypeError('Failed to fetch')));
		expect(result).toMatchObject({ ok: false, reason: 'unreachable', message: 'error_generic' });
		expect(shown).toEqual(['error_generic']);
	});
});
