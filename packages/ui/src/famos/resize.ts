const QUALITY = 0.85;

/** The size an image of `width` × `height` is shrunk to (never enlarged). */
export function fitWithin(width: number, height: number, maxSide: number) {
	const scale = Math.min(1, maxSide / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/** The centered square of an image of `width` × `height`: where it starts and how long its side is. */
export function squareCrop(width: number, height: number) {
	const side = Math.max(1, Math.min(width, height));
	return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

/** Draws the `crop` area of `bitmap` at `width` × `height` and returns it as a JPEG. */
async function encodeJpeg(
	bitmap: ImageBitmap,
	crop: { x: number; y: number; width: number; height: number },
	width: number,
	height: number,
): Promise<Blob> {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('No canvas');
	// A transparent PNG would turn black as a JPEG.
	context.fillStyle = '#ffffff';
	context.fillRect(0, 0, width, height);
	context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
	const blob = await new Promise<Blob | null>((resolve) =>
		canvas.toBlob(resolve, 'image/jpeg', QUALITY),
	);
	if (!blob) throw new Error('Could not encode the image');
	return blob;
}

/**
 * Shrinks a picture so its longest side is at most `maxSide` pixels (browser canvas, no library)
 * and returns it as a JPEG, which also drops camera metadata such as the location. With
 * `square`, only the centered square is kept (for a profile photo), `maxSide` wide and tall.
 * Throws when the file is not a readable image.
 */
export async function resizeImage(
	file: Blob,
	maxSide: number,
	options: { square?: boolean } = {},
): Promise<Blob> {
	const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	try {
		if (options.square) {
			const crop = squareCrop(bitmap.width, bitmap.height);
			const out = Math.min(maxSide, crop.side);
			return await encodeJpeg(
				bitmap,
				{ x: crop.x, y: crop.y, width: crop.side, height: crop.side },
				out,
				out,
			);
		}
		const { width, height } = fitWithin(bitmap.width, bitmap.height, maxSide);
		return await encodeJpeg(
			bitmap,
			{ x: 0, y: 0, width: bitmap.width, height: bitmap.height },
			width,
			height,
		);
	} finally {
		bitmap.close();
	}
}
