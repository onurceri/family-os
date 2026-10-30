import type { paths } from '@famos/api-client';

const DOWNLOAD_PATH = '/api/v1/backups/local/{name}' satisfies keyof paths;

/**
 * Where the browser saves a local backup from. A link, not a fetch: a backup holds photos and
 * papers, so the browser streams it straight to disk instead of into memory.
 */
export const backupDownloadUrl = (name: string): string =>
	DOWNLOAD_PATH.replace('{name}', encodeURIComponent(name));
