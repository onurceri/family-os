/**
 * Where a member's profile photo is served. The one place the app builds these addresses:
 * everything else (extensions included) is handed the address as data. The photo's id is part of
 * it, so a new photo is a new address and a cached old one is never shown.
 */
export const memberPhotoUrl = (
	memberId: string,
	photo: string | null | undefined,
): string | null =>
	photo ? `/api/v1/core/members/${memberId}/photo?v=${encodeURIComponent(photo)}` : null;

/** The same photo as the PIN profile picker reads it (trusted family devices, listed people only). */
export const profilePhotoUrl = (
	memberId: string,
	photo: string | null | undefined,
): string | null =>
	photo ? `/api/v1/core/profiles/${memberId}/photo?v=${encodeURIComponent(photo)}` : null;

/** A member as the API gives it, with the address of their photo. */
export const withPhotoUrl = <M extends { id: string; photo: string | null }>(
	member: M,
): M & { photoUrl: string | null } => ({
	...member,
	photoUrl: memberPhotoUrl(member.id, member.photo),
});
