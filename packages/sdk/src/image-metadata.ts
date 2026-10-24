import { FamosError } from './errors.ts';

/**
 * Removes metadata from photos before they are stored or sent to a model: EXIF (GPS position,
 * camera serial, time), XMP, IPTC and comments. Pure TypeScript segment parsing, no native
 * dependency. Pixels are never decoded or re-encoded, so quality and size stay the same.
 *
 * - JPEG: drops APP1 (EXIF, XMP), APP13 (IPTC), COM and other application segments, keeps JFIF,
 *   the ICC colour profile and the Adobe segment (needed for CMYK). The EXIF orientation is kept
 *   in a minimal new EXIF segment, so photos are not shown sideways. Data after the end of the
 *   image (embedded previews, Motion Photo videos) is dropped.
 * - PNG: drops eXIf, tEXt, zTXt, iTXt (XMP) and tIME chunks.
 * - WebP: drops EXIF and XMP chunks.
 * - GIF: drops comment, plain text and application extensions (XMP lives in one), keeping only
 *   the loop count of an animation, and anything after the trailer.
 *
 * PDF is not handled: its document information and XMP are not removed, so a PDF is stored and
 * sent as it is.
 *
 * Throws on a malformed file instead of returning it unchanged, so metadata never slips through.
 */
export function stripImageMetadata(data: Uint8Array, type: string): Uint8Array {
	if (type === 'image/jpeg') return stripJpeg(data);
	if (type === 'image/png') return stripPng(data);
	if (type === 'image/webp') return stripWebp(data);
	if (type === 'image/gif') return stripGif(data);
	return data;
}

export const STRIPPED_TYPES: ReadonlySet<string> = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif',
]);

/** A bad request, so an upload route that lets it through answers 400 instead of failing. */
export class MalformedImageError extends FamosError {
	constructor(type: string) {
		super('bad_request', `Malformed ${type} file`);
		this.name = 'MalformedImageError';
	}
}

const ascii = (data: Uint8Array, start: number, length: number) =>
	String.fromCharCode(...data.subarray(start, start + length));

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

// --- JPEG -------------------------------------------------------------------------------------

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;
const COM = 0xfe;

function stripJpeg(data: Uint8Array): Uint8Array {
	const fail = () => {
		throw new MalformedImageError('JPEG');
	};
	if (data[0] !== 0xff || data[1] !== SOI) fail();
	const head: Uint8Array[] = [data.subarray(0, 2)];
	const body: Uint8Array[] = [];
	let orientation = 1;
	let pos = 2;
	for (;;) {
		// Markers may be preceded by fill bytes (0xFF).
		if (data[pos] !== 0xff) fail();
		while (data[pos] === 0xff) pos++;
		const marker = data[pos];
		if (marker === undefined) fail();
		pos++;
		if (marker === EOI) {
			body.push(Uint8Array.of(0xff, EOI));
			break;
		}
		if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) {
			body.push(Uint8Array.of(0xff, marker));
			continue;
		}
		if (pos + 2 > data.length) fail();
		const length = ((data[pos] as number) << 8) | (data[pos + 1] as number);
		const end = pos + length;
		if (length < 2 || end > data.length) fail();
		const segment = data.subarray(pos - 2, end);
		const payload = data.subarray(pos + 2, end);
		pos = end;
		if (marker === SOS) {
			// Entropy-coded data runs until the next marker that is not a stuffed 0x00 or a restart.
			let scan = pos;
			while (scan + 1 < data.length) {
				if (data[scan] === 0xff) {
					const next = data[scan + 1] as number;
					if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
				}
				scan++;
			}
			if (scan + 1 >= data.length) fail();
			body.push(segment, data.subarray(pos, scan));
			pos = scan;
			continue;
		}
		if (marker === APP1 && ascii(payload, 0, 6) === 'Exif\0\0') {
			orientation = readOrientation(payload.subarray(6)) ?? orientation;
			continue;
		}
		const isApp = marker !== undefined && marker >= APP0 && marker <= 0xef;
		const keep =
			!isApp ||
			marker === APP0 ||
			(marker === APP2 && ascii(payload, 0, 12) === 'ICC_PROFILE\0') ||
			(marker === APP14 && ascii(payload, 0, 5) === 'Adobe');
		if (marker === COM || !keep) continue;
		(marker === APP0 ? head : body).push(segment);
	}
	if (orientation >= 2 && orientation <= 8) head.push(orientationSegment(orientation));
	return concat([...head, ...body]);
}

/** The orientation tag (0x0112) of IFD0 in a TIFF block, if present and well-formed. */
function readOrientation(tiff: Uint8Array): number | null {
	if (tiff.length < 8) return null;
	const order = ascii(tiff, 0, 2);
	if (order !== 'II' && order !== 'MM') return null;
	const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
	const little = order === 'II';
	const ifd = view.getUint32(4, little);
	if (ifd + 2 > tiff.length) return null;
	const count = view.getUint16(ifd, little);
	for (let i = 0; i < count; i++) {
		const entry = ifd + 2 + i * 12;
		if (entry + 12 > tiff.length) return null;
		if (view.getUint16(entry, little) === 0x0112 && view.getUint16(entry + 2, little) === 3)
			return view.getUint16(entry + 8, little);
	}
	return null;
}

/** A minimal APP1 EXIF segment holding only the orientation (big-endian TIFF, one IFD entry). */
function orientationSegment(orientation: number): Uint8Array {
	// biome-ignore format: byte layout
	return Uint8Array.of(
		0xff, APP1, 0x00, 34,
		0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
		0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // "MM", 42, IFD0 at 8
		0x00, 0x01, // one entry
		0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // orientation
		0x00, 0x00, 0x00, 0x00, // no next IFD
	);
}

// --- PNG --------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROPPED = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(data: Uint8Array): Uint8Array {
	if (PNG_SIGNATURE.some((b, i) => data[i] !== b)) throw new MalformedImageError('PNG');
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const parts: Uint8Array[] = [data.subarray(0, 8)];
	let pos = 8;
	for (;;) {
		if (pos + 12 > data.length) throw new MalformedImageError('PNG');
		const length = view.getUint32(pos);
		const type = ascii(data, pos + 4, 4);
		const end = pos + 12 + length;
		if (end > data.length) throw new MalformedImageError('PNG');
		if (!PNG_DROPPED.has(type)) parts.push(data.subarray(pos, end));
		pos = end;
		if (type === 'IEND') return concat(parts);
	}
}

// --- WebP -------------------------------------------------------------------------------------

function stripWebp(data: Uint8Array): Uint8Array {
	if (data.length < 12 || ascii(data, 0, 4) !== 'RIFF' || ascii(data, 8, 4) !== 'WEBP')
		throw new MalformedImageError('WebP');
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const size = Math.min(view.getUint32(4, true) + 8, data.length);
	const chunks: Uint8Array[] = [];
	let pos = 12;
	while (pos + 8 <= size) {
		const type = ascii(data, pos, 4);
		const length = view.getUint32(pos + 4, true);
		const end = pos + 8 + length + (length % 2);
		if (pos + 8 + length > size) throw new MalformedImageError('WebP');
		if (type !== 'EXIF' && type !== 'XMP ') {
			const chunk = data.slice(pos, Math.min(end, size));
			// VP8X flags: clear the EXIF (0x08) and XMP (0x04) bits.
			if (type === 'VP8X' && chunk.length > 8) chunk[8] = (chunk[8] as number) & ~0x0c;
			chunks.push(chunk);
		}
		pos = end;
	}
	const body = concat(chunks);
	const header = new Uint8Array(12);
	header.set(data.subarray(0, 12));
	new DataView(header.buffer).setUint32(4, body.length + 4, true);
	return concat([header, body]);
}

// --- GIF --------------------------------------------------------------------------------------

/** The sub-blocks that end at a zero-length block, from `pos`; the position after them. */
function endOfSubBlocks(data: Uint8Array, pos: number): number {
	for (;;) {
		const size = data[pos];
		if (size === undefined) throw new MalformedImageError('GIF');
		pos += 1 + size;
		if (size === 0) return pos;
	}
}

const NETSCAPE_ID = [...'NETSCAPE2.0'].map((c) => c.charCodeAt(0));

function stripGif(data: Uint8Array): Uint8Array {
	const fail = () => {
		throw new MalformedImageError('GIF');
	};
	const signature = ascii(data, 0, 6);
	if (signature !== 'GIF87a' && signature !== 'GIF89a') fail();
	if (data.length < 13) fail();
	const colorTable = (flags: number) => (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
	// Header, logical screen descriptor and the global colour table.
	let pos = 13 + colorTable(data[10] as number);
	if (pos > data.length) fail();
	const parts: Uint8Array[] = [data.subarray(0, pos)];
	for (;;) {
		const introducer = data[pos];
		if (introducer === 0x3b) {
			parts.push(Uint8Array.of(0x3b));
			return concat(parts);
		}
		if (introducer === 0x21) {
			const label = data[pos + 1];
			if (label === undefined) fail();
			const end = endOfSubBlocks(data, pos + 2);
			if (end > data.length) fail();
			if (label === 0xf9) parts.push(data.subarray(pos, end));
			else if (label === 0xff && ascii(data, pos + 3, 11) === 'NETSCAPE2.0') {
				// Only the loop count of an animation stays, written out afresh.
				const loops =
					data[pos + 14] === 3 && data[pos + 15] === 1 ? data.subarray(pos + 16, pos + 18) : null;
				if (loops?.length === 2)
					parts.push(
						Uint8Array.of(
							0x21,
							0xff,
							0x0b,
							...NETSCAPE_ID,
							3,
							1,
							loops[0] as number,
							loops[1] as number,
							0,
						),
					);
			}
			pos = end;
			continue;
		}
		if (introducer === 0x2c) {
			if (pos + 10 > data.length) fail();
			const start = pos;
			pos += 10 + colorTable(data[pos + 9] as number);
			pos = endOfSubBlocks(data, pos + 1);
			if (pos > data.length) fail();
			parts.push(data.subarray(start, pos));
			continue;
		}
		fail();
	}
}
