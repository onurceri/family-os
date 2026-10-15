import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** What `extensions.json` says the app ships: always there, and offered to install. */
const BundledListSchema = z.object({
	always: z.array(z.string()),
	offered: z.array(z.string()),
	default: z.array(z.string()),
});

export type BundledList = z.infer<typeof BundledListSchema>;

/**
 * The extension packages shipped with the app, found only next to the server bundle: in the
 * image `/app/server/main.mjs` → `/app/extensions`, in a checkout `apps/server/dist/main.mjs` →
 * `dist/extensions` (written by `pnpm build`). Their place is what makes them trusted, so no
 * setting moves it.
 */
export function findBundledExtensions(): string | undefined {
	const here = dirname(fileURLToPath(import.meta.url));
	return [resolve(here, '../extensions'), resolve(here, '../../../dist/extensions')].find((dir) =>
		existsSync(join(dir, 'extensions.json')),
	);
}

export function readBundledList(dir: string): BundledList {
	const file = join(dir, 'extensions.json');
	const parsed = BundledListSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
	if (!parsed.success) throw new Error(`${file} is malformed: ${parsed.error.message}`);
	return parsed.data;
}
