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

/**
 * Why a package is refused, as a stable code a page translates, with the values its sentence
 * names (a path, a key id, a version). The message beside it is for the log; the group says what
 * the person can do about it:
 * - `too_large`: `too_large`, `unpacks_too_large` (`limitMb`), `too_many_files` (`limit`);
 * - `unsigned`: `not_signed`, `bad_signature_file`, `untrusted_key` (`keyId`),
 *   `signature_mismatch`;
 * - `incompatible`: `sdk` (`needs`, `has`), `platform` (`built`, `has`);
 * - `invalid`: everything else (`not_gzip`, `not_archive`, `unsafe_path`, `not_a_file`,
 *   `duplicate_path`, `file_missing`, `file_mismatch`, `unlisted_file` with `path`;
 *   `no_description`, `bad_description`, `bad_manifest`, `reserved_name` with `id`, `bad_entry`).
 */
const GROUPS = {
	too_large: ['too_large', 'unpacks_too_large', 'too_many_files'],
	unsigned: ['not_signed', 'bad_signature_file', 'untrusted_key', 'signature_mismatch'],
	incompatible: ['sdk', 'platform'],
	invalid: [
		'not_gzip',
		'not_archive',
		'unsafe_path',
		'not_a_file',
		'duplicate_path',
		'file_missing',
		'file_mismatch',
		'unlisted_file',
		'no_description',
		'bad_description',
		'bad_manifest',
		'reserved_name',
		'bad_entry',
	],
} as const;
export type RefusalReason = keyof typeof GROUPS;
export type PackageProblem = (typeof GROUPS)[RefusalReason][number];

const groupOf = (code: PackageProblem): RefusalReason =>
	(Object.keys(GROUPS) as RefusalReason[]).find((group) =>
		(GROUPS[group] as readonly string[]).includes(code),
	) ?? 'invalid';

/** A refusal: the message for the log, and `details` `{ reason, code, ...params }` for a page. */
export const refusePackage = (
	message: string,
	code: PackageProblem,
	params: Record<string, string> = {},
) => new FamosError('bad_request', message, { reason: groupOf(code), code, ...params });
const refuse = refusePackage;

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
	const limitMb = (limit: number) => ({ limitMb: String(limit / 1024 / 1024) });
	if (bytes.byteLength > ARCHIVE_LIMITS.compressedBytes)
		throw refuse(
			`The package is larger than ${mb(ARCHIVE_LIMITS.compressedBytes)}`,
			'too_large',
			limitMb(ARCHIVE_LIMITS.compressedBytes),
		);
	let plain: Buffer;
	try {
		// The tar's headers and padding count too, so the files alone always stay below the limit.
		plain = gunzipSync(bytes, { maxOutputLength: ARCHIVE_LIMITS.unpackedBytes });
	} catch (error) {
		if (
			error instanceof RangeError ||
			(error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'
		)
			throw refuse(
				`The package unpacks to more than ${mb(ARCHIVE_LIMITS.unpackedBytes)}`,
				'unpacks_too_large',
				limitMb(ARCHIVE_LIMITS.unpackedBytes),
			);
		throw refuse('The file is not an extension package (it is not gzip)', 'not_gzip');
	}
	const files: PackageFiles = new Map();
	let problem: { message: string; code: PackageProblem; params?: Record<string, string> } | null =
		null;
	const parser = new tar.Parser({
		strict: true,
		onReadEntry: (entry) => {
			const fail = (message: string, code: PackageProblem, params?: Record<string, string>) => {
				problem ??= { message, code, ...(params && { params }) };
				entry.resume();
			};
			const path = { path: entry.path.slice(0, 120) };
			if (problem) return entry.resume();
			if (entry.type === 'Directory') {
				if (!isSafePath(entry.path.replace(/\/$/, '')))
					return fail(
						`The package holds an unsafe path: ${printable(entry.path)}`,
						'unsafe_path',
						path,
					);
				return entry.resume();
			}
			if (entry.type !== 'File' && entry.type !== 'OldFile')
				return fail(
					`The package holds a ${entry.type} entry (${printable(entry.path)}): only files are allowed`,
					'not_a_file',
					path,
				);
			if (!isSafePath(entry.path))
				return fail(
					`The package holds an unsafe path: ${printable(entry.path)}`,
					'unsafe_path',
					path,
				);
			if (files.has(entry.path))
				return fail(`The package holds ${printable(entry.path)} twice`, 'duplicate_path', path);
			if (files.size >= ARCHIVE_LIMITS.files)
				return fail(`The package holds more than ${ARCHIVE_LIMITS.files} files`, 'too_many_files', {
					limit: String(ARCHIVE_LIMITS.files),
				});
			const chunks: Buffer[] = [];
			entry.on('data', (chunk: Buffer) => chunks.push(chunk));
			entry.on('end', () => {
				if (!problem) files.set(entry.path, Buffer.concat(chunks));
			});
		},
	});
	await new Promise<void>((resolve, reject) => {
		parser.on('error', (error: Error) =>
			reject(refuse(`The package is not a valid archive: ${error.message}`, 'not_archive')),
		);
		parser.on('warn', (_code: string, message: string | Error) => {
			problem ??= {
				message: `The package is not a valid archive: ${message instanceof Error ? message.message : message}`,
				code: 'not_archive',
			};
		});
		parser.on('end', () => resolve());
		parser.end(plain);
	});
	const found = problem as {
		message: string;
		code: PackageProblem;
		params?: Record<string, string>;
	} | null;
	if (found) throw refuse(found.message, found.code, found.params);
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
		const notAFile = () =>
			refuse(`The stored package holds ${path}, which is not a file`, 'not_a_file', { path });
		if (!entry.isFile()) throw notAFile();
		// `readdir` reports what the entry is; `lstat` again, so a link swapped in is caught.
		if (!(await lstat(full)).isFile()) throw notAFile();
		if (!isSafePath(path))
			throw refuse(`The stored package holds an unsafe path: ${path}`, 'unsafe_path', { path });
		if (files.size >= ARCHIVE_LIMITS.files)
			throw refuse(
				`The stored package holds more than ${ARCHIVE_LIMITS.files} files`,
				'too_many_files',
				{
					limit: String(ARCHIVE_LIMITS.files),
				},
			);
		const bytes = await readFile(full);
		total += bytes.byteLength;
		if (total > ARCHIVE_LIMITS.unpackedBytes)
			throw refuse(
				`The stored package is larger than ${mb(ARCHIVE_LIMITS.unpackedBytes)}`,
				'unpacks_too_large',
				{
					limitMb: String(ARCHIVE_LIMITS.unpackedBytes / 1024 / 1024),
				},
			);
		files.set(path, bytes);
	}
	return files;
}

const mb = (bytes: number) => `${bytes / 1024 / 1024} MB`;
const printable = (path: string) => JSON.stringify(path.slice(0, 120));
