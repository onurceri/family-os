import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

/** The built files that shrink well. Images and fonts are compressed already. */
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.json', '.svg', '.webmanifest']);
/** Below this a second copy saves nothing worth a request's extra header. */
const MIN_BYTES = 512;

/**
 * Writes `<file>.br` and `<file>.gz` next to every compressible file under `dir`, so the server
 * sends them as they are (`precompressed`) instead of the raw file. A copy is written only when
 * it is smaller than the original. Returns how many files it compressed.
 *
 * @param {string} dir
 * @returns {number}
 */
export function compressDir(dir) {
	let count = 0;
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			count += compressDir(path);
			continue;
		}
		if (!COMPRESSIBLE.has(extname(name))) continue;
		const raw = readFileSync(path);
		if (raw.length < MIN_BYTES) continue;
		const br = brotliCompressSync(raw, {
			params: {
				[constants.BROTLI_PARAM_QUALITY]: 11,
				[constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
			},
		});
		const gz = gzipSync(raw, { level: 9 });
		if (br.length < raw.length) writeFileSync(`${path}.br`, br);
		if (gz.length < raw.length) writeFileSync(`${path}.gz`, gz);
		count++;
	}
	return count;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const dir = process.argv[2] ?? 'build';
	console.log(`compressed ${compressDir(dir)} files in ${dir}`);
}
