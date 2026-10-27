// Methods older browsers lack (wall displays run Chrome 106; these arrived in 110). This file is
// the first import of hooks.client.ts, so it runs before any app or extension code. Add a module
// here, never a hand-written copy; scripts/old-browsers.test.ts lists what else is off limits.
import 'core-js/actual/array/to-reversed';
import 'core-js/actual/array/to-sorted';
import 'core-js/actual/array/to-spliced';
import 'core-js/actual/array/with';
