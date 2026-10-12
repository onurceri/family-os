/**
 * Lets only the newest of several overlapping reads count. Start one with `begin()` before the
 * request; when the answer arrives, `current()` says whether it may still be used. An older answer
 * (a slow response overtaken by a newer one, or one for a list the person has left) is ignored,
 * so it cannot put old items over new ones.
 */
export function latestOnly() {
	let newest = 0;
	return {
		begin(): () => boolean {
			const mine = ++newest;
			return () => mine === newest;
		},
	};
}
