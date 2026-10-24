import { describe, expect, it } from 'vitest';
import type { ActionResult } from '../src/context.ts';
import { FamosError } from '../src/errors.ts';
import {
	inspectImage,
	readUploadedImage,
	storeThenRun,
	UPLOAD_ENVELOPE_BYTES,
	uploadRequestLimit,
} from '../src/image-upload.ts';
import type { FileStore } from '../src/ports.ts';
import type { UploadedFile } from '../src/routes.ts';

const png = (width = 8, height = 6) => {
	const b = new Uint8Array(45);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(b.buffer).setUint32(16, width);
	new DataView(b.buffer).setUint32(20, height);
	b.set([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44], 33);
	return b;
};
const jpeg = (width = 40, height = 30) => {
	const b = new Uint8Array(27);
	b.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8]);
	b.set([0xff, 0xda, 0, 2, 0xff, 0xd9], 21);
	new DataView(b.buffer).setUint16(13, height);
	new DataView(b.buffer).setUint16(15, width);
	return b;
};
const webp = (kind: 'VP8 ' | 'VP8L' | 'VP8X', width = 16, height = 12) => {
	const b = new Uint8Array(40);
	const text = (at: number, s: string) => {
		for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i);
	};
	text(0, 'RIFF');
	new DataView(b.buffer).setUint32(4, b.length - 8, true);
	new DataView(b.buffer).setUint32(16, b.length - 20, true);
	text(8, 'WEBP');
	text(12, kind);
	const view = new DataView(b.buffer);
	if (kind === 'VP8 ') {
		view.setUint16(26, width, true);
		view.setUint16(28, height, true);
	} else if (kind === 'VP8L') {
		b[20] = 0x2f;
		view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
	} else {
		view.setUint16(24, width - 1, true);
		view.setUint16(27, height - 1, true);
	}
	return b;
};

const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const contains = (data: Uint8Array, s: string) => String.fromCharCode(...data).includes(s);

const upload = (bytes: Uint8Array, size = bytes.length): UploadedFile => ({
	field: 'files',
	name: 'p.jpg',
	type: 'image/jpeg',
	size,
	stream: async function* () {
		yield bytes;
	},
	bytes: async () => bytes,
});

describe('inspectImage', () => {
	it('reads the type and size of a JPEG, PNG and WebP from the bytes', () => {
		expect(inspectImage(jpeg(40, 30))).toEqual({ type: 'image/jpeg', width: 40, height: 30 });
		expect(inspectImage(png(8, 6))).toEqual({ type: 'image/png', width: 8, height: 6 });
		expect(inspectImage(webp('VP8 ', 16, 12))).toEqual({
			type: 'image/webp',
			width: 16,
			height: 12,
		});
		expect(inspectImage(webp('VP8L', 20, 10))).toMatchObject({ width: 20, height: 10 });
		expect(inspectImage(webp('VP8X', 30, 25))).toMatchObject({ width: 30, height: 25 });
	});

	it('refuses garbage, other formats and truncated files', () => {
		expect(inspectImage(text('<html>not an image at all</html>'))).toBeNull();
		expect(inspectImage(text('GIF89a......................'))).toBeNull();
		// HEIC (an ISO box) is not accepted.
		expect(inspectImage(Uint8Array.from([0, 0, 0, 24, ...text('ftypheic')]))).toBe(null);
		expect(inspectImage(new Uint8Array())).toBeNull();
		expect(inspectImage(png().subarray(0, 12))).toBeNull();
		expect(inspectImage(jpeg().subarray(0, 6))).toBeNull();
		expect(inspectImage(webp('VP8 ').subarray(0, 14))).toBeNull();
		expect(inspectImage(png(0, 5))).toBeNull();
	});
});

describe('upload envelope', () => {
	it('adds room for the multipart framing to a limit', () => {
		expect(uploadRequestLimit(5)).toBe(5 + UPLOAD_ENVELOPE_BYTES);
	});
});

describe('readUploadedImage', () => {
	const refused = (promise: Promise<unknown>) =>
		expect(promise).rejects.toMatchObject({ code: 'bad_request' });

	it('returns the image checked and cleaned', async () => {
		const photo = await readUploadedImage([upload(png())], { maxBytes: 1000 });
		expect(photo).toMatchObject({ type: 'image/png', width: 8, height: 6 });
		expect(photo.bytes.length).toBeGreaterThan(0);
	});

	it('removes location data from the stored bytes', async () => {
		const exif = text('Exif\0\0II*\0\x08\0\0\0\0\0GPSLatitude 41.0');
		const dirty = Uint8Array.from([
			0xff,
			0xd8,
			0xff,
			0xe1,
			(exif.length + 2) >> 8,
			(exif.length + 2) & 0xff,
			...exif,
			...jpeg().subarray(2),
		]);
		expect(contains(dirty, 'GPSLatitude')).toBe(true);
		const photo = await readUploadedImage([upload(dirty)], { maxBytes: 1000 });
		expect(photo.type).toBe('image/jpeg');
		expect(contains(photo.bytes, 'GPS')).toBe(false);
	});

	it('refuses no file, a file over the limit by claim or by bytes, a non-image and a huge picture', async () => {
		await refused(readUploadedImage([], { maxBytes: 1000 }));
		await refused(readUploadedImage([upload(png(), 1001)], { maxBytes: 1000 }));
		// The claimed size is only a claim: the bytes read are checked again.
		const big = new Uint8Array(1001);
		big.set(png());
		await refused(readUploadedImage([upload(big, 10)], { maxBytes: 1000 }));
		await refused(readUploadedImage([upload(text('hello'))], { maxBytes: 1000 }));
		await refused(readUploadedImage([upload(png(9000, 10))], { maxBytes: 1000, maxSide: 8192 }));
		await expect(
			readUploadedImage([upload(png(9000, 10))], { maxBytes: 1000 }),
		).resolves.toMatchObject({ width: 9000 });
	});
});

describe('storeThenRun', () => {
	const fakeStore = () => {
		const kept = new Map<string, Uint8Array>();
		const store = {
			put: async (key: string, data: Uint8Array) => {
				kept.set(key, data);
			},
			delete: async (key: string) => {
				kept.delete(key);
			},
		} as unknown as FileStore;
		return { store, kept };
	};
	const file = { key: 'x/1', bytes: Uint8Array.of(1), type: 'image/png' };

	it('keeps the file when the action is applied and returns its output', async () => {
		const { store, kept } = fakeStore();
		const out = await storeThenRun(store, file, async () => ({ status: 'applied', output: 7 }));
		expect(out).toBe(7);
		expect(kept.has('x/1')).toBe(true);
	});

	it('removes the file when the action throws or is not applied', async () => {
		const { store, kept } = fakeStore();
		await expect(
			storeThenRun(store, file, async () => {
				throw new FamosError('forbidden', 'no');
			}),
		).rejects.toMatchObject({ code: 'forbidden' });
		expect(kept.size).toBe(0);
		const draft = { status: 'drafted' } as unknown as ActionResult<number>;
		await expect(storeThenRun(store, file, async () => draft)).rejects.toMatchObject({
			code: 'conflict',
		});
		expect(kept.size).toBe(0);
	});
});
