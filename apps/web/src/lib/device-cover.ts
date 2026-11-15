/**
 * Whether the app offers a cover for when nobody is using it (`device.ambient`): only in a session
 * on a trusted family device whose slideshow is on. A personal phone or laptop, and a browser the
 * server does not know as a family device, never get one; what covers it and when is up to the
 * contribution.
 */
export function offersDeviceCover(
	me: { device: { slideshow: boolean } | null } | null | undefined,
): boolean {
	return me?.device?.slideshow === true;
}
