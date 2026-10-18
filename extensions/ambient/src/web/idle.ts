/**
 * Whether ambient mode covers the screen now: it may take over (`idle`, false on a screen that
 * has pages, where the photos are a page instead), nothing is covering it yet, and nobody has
 * touched the screen for the idle time.
 */
export function shouldCover(input: {
	idle: boolean;
	covering: boolean;
	lastActivity: number;
	now: number;
	idleMinutes: number;
}): boolean {
	return (
		input.idle && !input.covering && input.now - input.lastActivity >= input.idleMinutes * 60_000
	);
}
