const ascii = (s: string) => new TextEncoder().encode(s);

const join = (...parts: (number[] | Uint8Array)[]) =>
	Uint8Array.from(parts.flatMap((part) => [...part]));

/** The text planted in a photo's location data; a stored photo must never contain it. */
export const GPS_MARKER = 'GPSLatitude 41.0082';

function u32be(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function jpeg(width: number, height: number, gps: boolean): Uint8Array {
	const segment = (marker: number, payload: Uint8Array | number[]) =>
		join([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff], payload);
	return join(
		[0xff, 0xd8],
		segment(0xe0, ascii('JFIF\0\x01\x02')),
		gps
			? segment(0xe1, join(ascii('Exif\0\0II'), [0x2a, 0, 8, 0, 0, 0], [0, 0], ascii(GPS_MARKER)))
			: [],
		segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]),
		segment(0xda, [1, 1, 0]),
		[1, 2, 3],
		[0xff, 0xd9],
	);
}

function png(width: number, height: number, gps: boolean): Uint8Array {
	const chunk = (type: string, data: Uint8Array | number[]) =>
		join(u32be(data.length), ascii(type), data, [0, 0, 0, 0]);
	return join(
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
		chunk('IHDR', join(u32be(width), u32be(height), [8, 2, 0, 0, 0])),
		gps ? chunk('tEXt', ascii(`Comment\0${GPS_MARKER}`)) : [],
		chunk('IEND', []),
	);
}

function webp(width: number, height: number, gps: boolean): Uint8Array {
	const chunk = (type: string, data: Uint8Array | number[]) =>
		join(
			ascii(type),
			[data.length & 0xff, (data.length >> 8) & 0xff, 0, 0],
			data,
			data.length % 2 ? [0] : [],
		);
	const dimension = (n: number) => [(n - 1) & 0xff, ((n - 1) >> 8) & 0xff, 0];
	const body = join(
		ascii('WEBP'),
		chunk('VP8X', join([gps ? 0x08 : 0, 0, 0, 0], dimension(width), dimension(height))),
		gps ? chunk('EXIF', ascii(GPS_MARKER)) : [],
	);
	return join(ascii('RIFF'), [body.length & 0xff, (body.length >> 8) & 0xff, 0, 0], body);
}

/**
 * A small but structurally valid photo, for upload tests: the strip accepts it and the size
 * can be read back. With `gps` it carries a location block (EXIF, a text chunk) holding
 * {@link GPS_MARKER}.
 */
export function samplePhoto(
	type: 'image/jpeg' | 'image/png' | 'image/webp',
	options: { width?: number; height?: number; gps?: boolean } = {},
): Uint8Array {
	const { width = 8, height = 6, gps = false } = options;
	if (type === 'image/jpeg') return jpeg(width, height, gps);
	if (type === 'image/png') return png(width, height, gps);
	return webp(width, height, gps);
}
