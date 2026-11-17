import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS script without type declarations
import { pictureBody } from './readme-pictures.mjs';
// @ts-expect-error plain JS script without type declarations
import {
	affectsPictures,
	changedShare,
	pictureChanged,
	readPpm,
} from './readme-pictures-compare.mjs';

const raw = 'https://raw.githubusercontent.com/o/r';

describe('the README pictures pull request', () => {
	it('shows each changed picture before and after, from the two commits', () => {
		const body: string = pictureBody({
			repo: 'o/r',
			base: 'aaa',
			head: 'bbb',
			files: ['docs/images/readme-today.webp', 'docs/images/hero-kitchen.webp'],
		});
		expect(body).toContain('### hero-kitchen\n\n| Before | After |\n| --- | --- |');
		expect(body).toContain(
			`| <img src="${raw}/aaa/docs/images/readme-today.webp" width="100%"> | <img src="${raw}/bbb/docs/images/readme-today.webp" width="100%"> |`,
		);
		// In order of name.
		expect(body.indexOf('hero-kitchen')).toBeLessThan(body.indexOf('readme-today'));
	});

	it('says new for a picture that did not exist and removed for one that is gone', () => {
		const body: string = pictureBody({
			repo: 'o/r',
			base: 'aaa',
			head: 'bbb',
			files: [
				{ path: 'docs/images/readme-new.webp', status: 'added' },
				{ path: 'docs/images/readme-old.webp', status: 'deleted' },
			],
		});
		expect(body).toContain(
			`| new | <img src="${raw}/bbb/docs/images/readme-new.webp" width="100%"> |`,
		);
		expect(body).toContain(
			`| <img src="${raw}/aaa/docs/images/readme-old.webp" width="100%"> | removed |`,
		);
	});

	it('leaves out files that are not pictures', () => {
		const body: string = pictureBody({
			repo: 'o/r',
			base: 'a',
			head: 'b',
			files: ['docs/images/notes.txt', 'docs/guide/x.webp'],
		});
		expect(body).not.toContain('###');
	});
});

describe('what counts as a changed picture', () => {
	const picture = (width: number, height: number, fill: (i: number) => number[]) => {
		const pixels = Buffer.alloc(width * height * 3);
		for (let i = 0; i < width * height; i++) pixels.set(fill(i), i * 3);
		return { width, height, pixels };
	};
	const grey = () => [200, 200, 200];
	const blank = picture(100, 100, grey);

	it('is not changed by noise within the tolerance', () => {
		const noisy = picture(100, 100, () => [210, 195, 200]);
		expect(changedShare(blank, noisy)).toBe(0);
		expect(pictureChanged(blank, noisy)).toBe(false);
	});

	it('is not changed by a few stray pixels', () => {
		const moved = picture(100, 100, (i) => (i < 20 ? [0, 0, 0] : grey()));
		expect(changedShare(blank, moved)).toBe(0.002);
		expect(pictureChanged(blank, moved)).toBe(false);
	});

	it('is changed when more than the share of pixels differ beyond the tolerance', () => {
		const edited = picture(100, 100, (i) => (i < 100 ? [0, 0, 0] : grey()));
		expect(changedShare(blank, edited)).toBe(0.01);
		expect(pictureChanged(blank, edited)).toBe(true);
	});

	it('is changed when the size is', () => {
		expect(pictureChanged(blank, picture(100, 99, grey))).toBe(true);
	});

	it('reads the pixels of a binary PPM', () => {
		const ppm = Buffer.concat([Buffer.from('P6\n2 1\n255\n'), Buffer.from([1, 2, 3, 4, 5, 6])]);
		const read = readPpm(ppm);
		expect([read.width, read.height, [...read.pixels]]).toEqual([2, 1, [1, 2, 3, 4, 5, 6]]);
	});
});

describe('which changes can change a picture', () => {
	it.each([
		'apps/web/src/routes/+page.svelte',
		'packages/ui/src/theme.css',
		'themes/coast/tokens.json',
		'languages/tr/app.json',
		'extensions/calendar/src/web/Week.svelte',
		'extensions/calendar/src/messages/en.json',
		'apps/e2e/support/sample-data.ts',
		'apps/e2e/sweep/readme.spec.ts',
		'README.md',
		'.github/workflows/readme-pictures.yml',
	])('%s does', (path) => expect(affectsPictures(['docs/guide/today.md', path])).toBe(true));

	it.each([
		'apps/server/src/main.ts',
		'extensions/calendar/src/actions.ts',
		'docs/guide/today.md',
		'.github/workflows/ci.yml',
		'packages/core/src/index.ts',
	])('%s does not', (path) => expect(affectsPictures([path])).toBe(false));
});
