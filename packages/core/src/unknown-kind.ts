/**
 * The end of a switch over `Actor['kind']`: `actor` has type `never` while every kind is
 * handled, so adding a kind to the SDK does not compile until each switch names it. At run time
 * a kind nobody knows gets the closed answer given here.
 */
export function unknownKind<T>(_actor: never, closed: T): T {
	return closed;
}
