import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS script without type declarations
import { pictureBody } from './readme-pictures.mjs';

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
