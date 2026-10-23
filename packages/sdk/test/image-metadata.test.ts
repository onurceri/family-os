import { describe, expect, it } from 'vitest';
import { MalformedImageError, stripImageMetadata } from '../src/image-metadata.ts';

const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
/** Where `needle` first occurs in `data`, or -1. */
const indexOf = (data: Uint8Array, needle: ArrayLike<number>) => {
	for (let i = 0; i + needle.length <= data.length; i++)
		if (Array.from(needle).every((b, j) => data[i + j] === b)) return i;
	return -1;
};
const bytes = (...parts: (number[] | Uint8Array)[]) =>
	Uint8Array.from(parts.flatMap((p) => [...p]));
const segment = (marker: number, payload: Uint8Array) =>
	bytes([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff], payload);
const has = (data: Uint8Array, needle: string) => indexOf(data, text(needle)) >= 0;

/** A little-endian TIFF block with orientation 6 and a GPS IFD pointer, plus a "GPS" marker. */
function exif(orientation: number) {
	return bytes(
		text('Exif\0\0II'),
		[0x2a, 0, 8, 0, 0, 0],
		[2, 0],
		[0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0],
		[0x25, 0x88, 4, 0, 1, 0, 0, 0, 0, 0, 0, 0],
		[0, 0, 0, 0],
		text('GPSLatitude 41.0082'),
	);
}

function jpeg() {
	return bytes(
		[0xff, 0xd8],
		segment(0xe0, text('JFIF\0\x01\x02')),
		segment(0xe1, exif(6)),
		segment(0xe1, text('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>secret</x:xmpmeta>')),
		segment(0xe2, text('ICC_PROFILE\0profile')),
		segment(0xed, text('Photoshop 3.0\0IPTC')),
		segment(0xfe, text('a comment')),
		segment(0xdb, text('quant')),
		segment(0xc0, text('frame')),
		segment(0xda, text('scan')),
		// Entropy data with a stuffed 0xFF00 and a restart marker.
		[1, 2, 0xff, 0x00, 3, 0xff, 0xd0, 4],
		[0xff, 0xd9],
		// A trailing embedded preview with its own EXIF.
		text('Exif GPSLatitude trailer'),
	);
}

describe('photo metadata', () => {
	it('strips EXIF, XMP, IPTC and comments from JPEG, keeping orientation, colour and pixels', () => {
		const out = stripImageMetadata(jpeg(), 'image/jpeg');
		for (const secret of ['GPS', 'xmpmeta', 'IPTC', 'a comment', 'trailer'])
			expect(has(out, secret)).toBe(false);
		expect(has(out, 'ICC_PROFILE')).toBe(true);
		expect(has(out, 'JFIF')).toBe(true);
		expect(indexOf(out, [1, 2, 0xff, 0x00, 3, 0xff, 0xd0, 4]) >= 0).toBe(true);
		// SOI, JFIF, then the minimal EXIF with orientation 6 (big-endian).
		const exifAt = indexOf(out, text('Exif\0\0MM'));
		expect(exifAt).toBeGreaterThan(0);
		expect(out[exifAt + 6 + 8 + 2 + 9]).toBe(6);
		expect([...out.subarray(-2)]).toEqual([0xff, 0xd9]);
	});

	it('adds no EXIF when the orientation is normal', () => {
		const plain = bytes(
			[0xff, 0xd8],
			segment(0xe1, exif(1)),
			segment(0xda, text('s')),
			[0xff, 0xd9],
		);
		expect(has(stripImageMetadata(plain, 'image/jpeg'), 'Exif')).toBe(false);
	});

	it('strips text and EXIF chunks from PNG', () => {
		const chunk = (type: string, data: Uint8Array) => {
			const len = data.length;
			return bytes(
				[len >>> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255],
				text(type),
				data,
				[0, 0, 0, 0],
			);
		};
		const png = bytes(
			[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
			chunk('IHDR', new Uint8Array(13)),
			chunk('eXIf', text('GPS')),
			chunk('iTXt', text('XML:com.adobe.xmp\0secret')),
			chunk('tEXt', text('Comment\0hello')),
			chunk('IDAT', text('pixels')),
			chunk('IEND', new Uint8Array()),
		);
		const out = stripImageMetadata(png, 'image/png');
		for (const secret of ['GPS', 'secret', 'hello']) expect(has(out, secret)).toBe(false);
		expect(has(out, 'pixels')).toBe(true);
		expect(has(out, 'IEND')).toBe(true);
	});

	it('strips EXIF and XMP chunks from WebP and clears their flags', () => {
		const chunk = (type: string, data: Uint8Array) =>
			bytes(
				text(type),
				[data.length & 255, (data.length >> 8) & 255, 0, 0],
				data,
				data.length % 2 ? [0] : [],
			);
		const body = bytes(
			text('WEBP'),
			chunk('VP8X', Uint8Array.of(0x0c | 0x10, 0, 0, 0, 1, 0, 0, 1, 0, 0)),
			chunk('VP8L', text('pixels')),
			chunk('EXIF', text('GPS!')),
			chunk('XMP ', text('secret')),
		);
		const webp = bytes(text('RIFF'), [body.length & 255, body.length >> 8, 0, 0], body);
		const out = stripImageMetadata(webp, 'image/webp');
		expect(has(out, 'GPS')).toBe(false);
		expect(has(out, 'secret')).toBe(false);
		expect(has(out, 'pixels')).toBe(true);
		expect(out[20]).toBe(0x10);
		expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
	});

	it('refuses malformed files instead of passing them through', () => {
		expect(() => stripImageMetadata(text('not a jpeg'), 'image/jpeg')).toThrow(MalformedImageError);
		expect(() =>
			stripImageMetadata(bytes([0xff, 0xd8], [0xff, 0xe1, 0x40, 0]), 'image/jpeg'),
		).toThrow(MalformedImageError);
		expect(() => stripImageMetadata(text('nope'), 'image/png')).toThrow(MalformedImageError);
	});
});
