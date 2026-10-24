const QUALITY = 0.85;

/** The size an image of `width` × `height` is shrunk to (never enlarged). */
export function fitWithin(width: number, height: number, maxSide: number) {
	const scale = Math.min(1, maxSide / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/**
 * Shrinks a picture so its longest side is at most `maxSide` pixels (browser canvas, no library)
 * and returns it as a JPEG, which also drops camera metadata such as the location. Throws when
 * the file is not a readable image.
 */
export async function resizeImage(file: Blob, maxSide: number): Promise<Blob> {
	const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	try {
		const { width, height } = fitWithin(bitmap.width, bitmap.height, maxSide);
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('No canvas');
		// A transparent PNG would turn black as a JPEG.
		context.fillStyle = '#ffffff';
		context.fillRect(0, 0, width, height);
		context.drawImage(bitmap, 0, 0, width, height);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, 'image/jpeg', QUALITY),
		);
		if (!blob) throw new Error('Could not encode the image');
		return blob;
	} finally {
		bitmap.close();
	}
}
