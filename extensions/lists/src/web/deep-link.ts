import { TaskIdSchema } from '../contract/index.js';

/** The task the address asks to open (`/lists/tasks?task=<id>`), or null when it names none. */
export function taskLink(query: URLSearchParams): string | null {
	const id = TaskIdSchema.safeParse(query.get('task'));
	return id.success ? id.data : null;
}
