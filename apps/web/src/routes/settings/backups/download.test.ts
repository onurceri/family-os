import { describe, expect, it } from 'vitest';
import { backupDownloadUrl } from './download.js';

describe('backupDownloadUrl', () => {
	it('points at the backup by its file name', () => {
		expect(backupDownloadUrl('famos-20261030-101500-manual.tar')).toBe(
			'/api/v1/backups/local/famos-20261030-101500-manual.tar',
		);
	});

	it('keeps an odd name inside one path segment', () => {
		expect(backupDownloadUrl('../x')).toBe('/api/v1/backups/local/..%2Fx');
	});
});
