/**
 * Whether a family device's panel says there are no photos: only once the library has been read
 * and is empty. Before it is read, or with photos, the panel says nothing.
 */
export function showNoPhotosNote(photoCount: number | null): boolean {
	return photoCount === 0;
}
