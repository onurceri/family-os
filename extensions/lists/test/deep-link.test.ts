import { describe, expect, it } from 'vitest';
import { SHOPPING_HREF, taskHref } from '../src/contract/index.ts';
import { taskLink } from '../src/web/deep-link.ts';

const ID = 'task_0192a3b4-0000-7000-8000-000000000001';

describe('task links', () => {
	it('reads what taskHref writes', () => {
		expect(taskLink(new URLSearchParams(taskHref(ID).split('?')[1]))).toBe(ID);
	});

	it('ignores a missing, foreign or invented id', () => {
		expect(taskLink(new URLSearchParams(''))).toBeNull();
		expect(
			taskLink(new URLSearchParams('task=cal_event_0192a3b4-0000-7000-8000-000000000001')),
		).toBeNull();
		expect(taskLink(new URLSearchParams('task=1'))).toBeNull();
	});

	it('points shopping at its page', () => {
		expect(SHOPPING_HREF).toBe('/lists/shopping');
	});
});
