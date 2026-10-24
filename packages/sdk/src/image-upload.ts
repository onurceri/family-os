import type { ActionResult } from './context.ts';
import { FamosError } from './errors.ts';
import { stripImageMetadata } from './image-metadata.ts';
import type { FileStore } from './ports.ts';
import type { UploadedFile } from './routes.ts';

/**
 * Room above a file's size for the multipart framing of an upload request, so a photo exactly at
 * its limit is not refused as a request before the route can answer with a clear message.
 */
export const UPLOAD_ENVELOPE_BYTES = 64 * 1024;

/** The `upload.maxBytes` of a route that takes one file of at most `maxBytes`. */
export const uploadRequestLimit = (maxBytes: number): number => maxBytes + UPLOAD_ENVELOPE_BYTES;

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ImageInfo {
	type: ImageType;
	width: number;
	height: number;
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u32be = (b: Uint8Array, i: number) => u16be(b, i) * 65536 + u16be(b, i + 2);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => u16le(b, i) | ((b[i + 2] ?? 0) << 16);
const u32le = (b: Uint8Array, i: number) => u16le(b, i) + u16le(b, i + 2) * 65536;
const text = (b: Uint8Array, from: number, to: number) =>
	String.fromCharCode(...b.subarray(from, to));

function pngSize(b: Uint8Array) {
	if (text(b, 12, 16) !== 'IHDR') return null;
	return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegSize(b: Uint8Array) {
	let i = 2;
	while (i + 9 < b.length) {
		if (b[i] !== 0xff) return null;
		const marker = b[i + 1] ?? 0;
		if (marker === 0xff) {
			i++;
			continue;
		}
		// Start-of-frame markers carry the size (not DHT 0xc4, JPG 0xc8 or DAC 0xcc).
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
			return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			i += 2;
			continue;
		}
		i += 2 + u16be(b, i + 2);
	}
	return null;
}

function webpSize(b: Uint8Array) {
	const chunk = text(b, 12, 16);
	if (chunk === 'VP8 ' && b.length >= 30)
		return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
	if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
		const bits = u32le(b, 21);
		return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
	}
	if (chunk === 'VP8X' && b.length >= 30)
		return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
	return null;
}

/**
 * The image type and size from the first bytes (the client's claim is not trusted); null when
 * the bytes are not a JPEG, PNG or WebP image with a readable size.
 */
export function inspectImage(bytes: Uint8Array): ImageInfo | null {
	let type: ImageType;
	let size: { width: number; height: number } | null;
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		type = 'image/jpeg';
		size = jpegSize(bytes);
	} else if (
		bytes.length >= 24 &&
		text(bytes, 1, 4) === 'PNG' &&
		bytes[0] === 0x89 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a
	) {
		type = 'image/png';
		size = pngSize(bytes);
	} else if (bytes.length >= 16 && text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 12) === 'WEBP') {
		type = 'image/webp';
		size = webpSize(bytes);
	} else return null;
	if (!size || size.width < 1 || size.height < 1) return null;
	return { type, ...size };
}

export interface ImageLimits {
	/** The largest file in bytes. */
	maxBytes: number;
	/** The largest width or height in pixels; unlimited when left out. */
	maxSide?: number;
}

/**
 * The one image of an upload, checked and cleaned: the size by the client's claim and again by
 * the bytes actually read, the type and pixel size from the bytes (never the client's claim),
 * and every kind of camera metadata (location, serial number, time) removed, so no stored photo
 * keeps it however it was sent. Throws `bad_request` with a message fit to show.
 */
export async function readUploadedImage(
	files: readonly UploadedFile[],
	limits: ImageLimits,
): Promise<ImageInfo & { bytes: Uint8Array }> {
	const file = files[0];
	if (!file) throw new FamosError('bad_request', 'Send one image');
	if (file.size > limits.maxBytes) throw new FamosError('bad_request', 'The photo is too large');
	const bytes = await file.bytes();
	if (bytes.byteLength > limits.maxBytes)
		throw new FamosError('bad_request', 'The photo is too large');
	const info = inspectImage(bytes);
	if (!info) throw new FamosError('bad_request', 'The photo must be a JPEG, PNG or WebP image');
	if (limits.maxSide !== undefined && (info.width > limits.maxSide || info.height > limits.maxSide))
		throw new FamosError('bad_request', 'The photo is too large');
	return { ...info, bytes: stripImageMetadata(bytes, info.type) };
}

/**
 * Stores a file, then runs the action that records it. Files cannot join a transaction, so the
 * file is removed again when the action throws or is not applied. Returns the applied output.
 */
export async function storeThenRun<O>(
	store: FileStore,
	file: { key: string; bytes: Uint8Array; type: string },
	run: () => Promise<ActionResult<O>>,
): Promise<O> {
	await store.put(file.key, file.bytes, file.type);
	try {
		const result = await run();
		if (result.status !== 'applied') throw new FamosError('conflict', 'The photo was not saved');
		return result.output;
	} catch (error) {
		await store.delete(file.key);
		throw error;
	}
}
