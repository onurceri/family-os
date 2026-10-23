/**
 * The address to hand to another device or program: the one the server was told the family uses
 * (`FAMOS_BASE_URL`) when there is one, else the address this browser is on.
 */
export function familyAddress(configured: string | null, origin: string): string {
	return (configured ?? origin).replace(/\/+$/, '');
}
