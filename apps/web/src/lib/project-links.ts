/** Where the project's documents live; links to it open in a new tab and nothing is fetched from them. */
export const REPO = 'https://github.com/onurceri/family-os';

/** How to update FamilyOS, in the install guide. */
export const UPDATE_GUIDE = `${REPO}/blob/main/docs/guide/install.md#update`;

/** The release's page, or null for anything that is not x.y.z, so no link is built from other text. */
export function releaseNotesUrl(version: string): string | null {
	return /^\d+\.\d+\.\d+$/.test(version) ? `${REPO}/releases/tag/v${version}` : null;
}
