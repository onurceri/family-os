import type { EventInput, EventReplace } from '../src/contract/index.ts';
import { formFrom, replaceFrom } from '../src/web/form.ts';

/** The whole event, as the event form sends it back to replace one. */
export const wholeEvent = (event: EventInput): EventReplace => replaceFrom(formFrom(event));
