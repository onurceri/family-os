import { unwrap } from '@famos/api-client';
import { sharedRead } from '@famos/ui/famos';
import { api } from './api.js';

/**
 * Whether the AI can read what is added (null: not known, as when the answer failed). One read
 * for the note under the box and every capture that says it was not read.
 */
export async function loadAiReading(): Promise<boolean | null> {
	try {
		return (
			await sharedRead('/api/v1/ai/available', async () =>
				unwrap(await api.GET('/api/v1/ai/available')),
			)
		).reading;
	} catch {
		return null;
	}
}
