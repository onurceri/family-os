/**
 * Loaded into the server with `node --import` when `FAMOS_E2E_FIXED_NOW` (an ISO instant) is set
 * (see server.ts): `Date` reads that instant as the real moment `FAMOS_E2E_CLOCK_START` and moves
 * on from there, so timers still run and a server started later in the run never goes back in
 * time. The README pictures use it to show one day whatever day they are made on.
 */
const fixed = process.env.FAMOS_E2E_FIXED_NOW;
if (fixed) {
	const Real = Date;
	const start = Number(process.env.FAMOS_E2E_CLOCK_START ?? Real.now());
	const offset = Date.parse(fixed) - start;
	class FixedDate extends Real {
		constructor(...args: unknown[]) {
			// @ts-expect-error: the arguments are passed on as given
			super(...(args.length === 0 ? [Real.now() + offset] : args));
		}
		static override now() {
			return Real.now() + offset;
		}
	}
	globalThis.Date = FixedDate as DateConstructor;
}
