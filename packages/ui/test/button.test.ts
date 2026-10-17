import { describe, expect, it } from 'vitest';
import { buttonVariants } from '../src/components/button/button.svelte';

describe('buttonVariants', () => {
	it('knows the v2 variants', () => {
		for (const variant of ['primary', 'secondary', 'outline', 'ghost', 'go', 'danger'] as const) {
			expect(buttonVariants({ variant })).toContain('rounded-[var(--r-ctl)]');
		}
		expect(buttonVariants({ variant: 'danger' })).toContain('text-destructive');
		expect(buttonVariants({})).toBe(buttonVariants({ variant: 'primary' }));
	});

	it('takes its height from --ctl, with small, large and kiosk sizes', () => {
		expect(buttonVariants({})).toContain('h-[var(--ctl)]');
		expect(buttonVariants({ size: 'sm' })).toContain('h-9');
		expect(buttonVariants({ size: 'lg' })).toContain('h-11');
		expect(buttonVariants({ size: 'kiosk' })).toContain('h-13');
		expect(buttonVariants({ size: 'icon' })).toContain('size-[var(--ctl)]');
	});

	it('the go variant is the attention fill and danger arms to a destructive fill', () => {
		expect(buttonVariants({ variant: 'go' })).toContain('bg-attention');
		expect(buttonVariants({ variant: 'danger' })).toContain('data-[armed=true]:bg-destructive');
	});
});
