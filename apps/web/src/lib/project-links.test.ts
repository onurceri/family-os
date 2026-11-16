import { describe, expect, it } from 'vitest';
import { REPO, releaseNotesUrl, UPDATE_GUIDE } from './project-links.js';

describe('releaseNotesUrl', () => {
	it('is the release page of the version', () => {
		expect(releaseNotesUrl('0.13.0')).toBe(`${REPO}/releases/tag/v0.13.0`);
	});

	it('is null for anything that is not x.y.z', () => {
		for (const bad of ['', '1.2', '1.2.3-rc.1', '1.2.3/../x', 'v1.2.3', '1.2.3\n']) {
			expect(releaseNotesUrl(bad)).toBeNull();
		}
	});

	it('points the update guide at the Update section', () => {
		expect(UPDATE_GUIDE.endsWith('/docs/guide/install.md#update')).toBe(true);
	});
});
