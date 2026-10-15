import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { FamosError } from '@famos/sdk';
import * as tar from 'tar';

/** The file name extension of a packed, signed extension package. */
export const ARCHIVE_EXTENSION = '.famext';

/** The most a `.famext` may weigh, unpack to, and hold. */
export const ARCHIVE_LIMITS = {
	compressedBytes: 20 * 1024 * 1024,
	unpackedBytes: 60 * 1024 * 1024,
	files: 2000,
} as const;

/** A package's files by their path inside it (always `/`-separated). */
export type PackageFiles = Map<string, Buffer>;

const refuse = (message: string) => new FamosError('bad_request', message);

/**
 * Whether `path` is a plain relative path that stays inside the package: no absolute path, no
 * `.` or `..` segment, no empty segment, no backslash and no control character. Tar's own
 * extraction strips such parts with a warning; a package is refused instead.
 */
export function isSafePath(path: string): boolean {
	if (path.length === 0 || path.length > 255) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
	if (/[\\\u0000-\u001f\u007f:]/.test(path)) return false;
	return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * Reads a `.famext` into memory, with every limit checked before it is reached: the compressed
 * size, the unpacked size (gunzip stops at it, so a small archive cannot expand without bound),
 * and the number of files. Only regular files are accepted: a link, a device or any other kind
 * of entry refuses the whole archive, as does an unsafe or repeated path. Directory entries are
 * allowed and carry nothing.
 */
export async function readArchive(bytes: Uint8Array): Promise<PackageFiles> {
	if (bytes.byteLength > ARCHIVE_LIMITS.compressedBytes)
		throw refuse(`The package is larger than ${mb(ARCHIVE_LIMITS.compressedBytes)}`);
	let plain: Buffer;
	try {
		// The tar's headers and padding count too, so the files alone always stay below the limit.
		plain = gunzipSync(bytes, { maxOutputLength: ARCHIVE_LIMITS.unpackedBytes });
	} catch (error) {
		if (
			error instanceof RangeError ||
			(error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'
		)
			throw refuse(`The package unpacks to more than ${mb(ARCHIVE_LIMITS.unpackedBytes)}`);
		throw refuse('The file is not an extension package (it is not gzip)');
	}
	const files: PackageFiles = new Map();
	let problem: string | null = null;
	const parser = new tar.Parser({
		strict: true,
		onReadEntry: (entry) => {
			const fail = (message: string) => {
				problem ??= message;
				entry.resume();
			};
			if (problem) return fail(problem);
			if (entry.type === 'Directory') {
				if (!isSafePath(entry.path.replace(/\/$/, '')))
					return fail(`The package holds an unsafe path: ${printable(entry.path)}`);
				return entry.resume();
			}
			if (entry.type !== 'File' && entry.type !== 'OldFile')
				return fail(
					`The package holds a ${entry.type} entry (${printable(entry.path)}): only files are allowed`,
				);
			if (!isSafePath(entry.path))
				return fail(`The package holds an unsafe path: ${printable(entry.path)}`);
			if (files.has(entry.path)) return fail(`The package holds ${printable(entry.path)} twice`);
			if (files.size >= ARCHIVE_LIMITS.files)
				return fail(`The package holds more than ${ARCHIVE_LIMITS.files} files`);
			const chunks: Buffer[] = [];
			entry.on('data', (chunk: Buffer) => chunks.push(chunk));
			entry.on('end', () => {
				if (!problem) files.set(entry.path, Buffer.concat(chunks));
			});
		},
	});
	await new Promise<void>((resolve, reject) => {
		parser.on('error', (error: Error) =>
			reject(refuse(`The package is not a valid archive: ${error.message}`)),
		);
		parser.on('warn', (_code: string, message: string | Error) => {
			problem ??= `The package is not a valid archive: ${message instanceof Error ? message.message : message}`;
		});
		parser.on('end', () => resolve());
		parser.end(plain);
	});
	if (problem) throw refuse(problem);
	return files;
}

/**
 * Reads a package folder as `readArchive` reads an archive, for checking a stored copy again:
 * the same limits, and nothing but regular files and folders (a link refuses the copy).
 */
export async function readPackageFolder(dir: string): Promise<PackageFiles> {
	const files: PackageFiles = new Map();
	let total = 0;
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	for (const entry of entries) {
		const full = join(entry.parentPath, entry.name);
		const path = relative(dir, full).split(sep).join('/');
		if (entry.isDirectory()) continue;
		if (!entry.isFile()) throw refuse(`The stored package holds ${path}, which is not a file`);
		// `readdir` reports what the entry is; `lstat` again, so a link swapped in is caught.
		if (!(await lstat(full)).isFile())
			throw refuse(`The stored package holds ${path}, which is not a file`);
		if (!isSafePath(path)) throw refuse(`The stored package holds an unsafe path: ${path}`);
		if (files.size >= ARCHIVE_LIMITS.files)
			throw refuse(`The stored package holds more than ${ARCHIVE_LIMITS.files} files`);
		const bytes = await readFile(full);
		total += bytes.byteLength;
		if (total > ARCHIVE_LIMITS.unpackedBytes)
			throw refuse(`The stored package is larger than ${mb(ARCHIVE_LIMITS.unpackedBytes)}`);
		files.set(path, bytes);
	}
	return files;
}

const mb = (bytes: number) => `${bytes / 1024 / 1024} MB`;
const printable = (path: string) => JSON.stringify(path.slice(0, 120));
