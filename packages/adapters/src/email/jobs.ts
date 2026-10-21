import { type AnyJobDefinition, defineJob, EMAIL_POLL_JOB } from '@famos/sdk';
import { z } from 'zod';
import type { Email } from './service.ts';

export const POLL_JOB = EMAIL_POLL_JOB;

/**
 * The mailbox check, registered with `KernelOptions.infrastructureJobs`. The service
 * records failures in the settings, so the job never throws: a retry would only repeat what the
 * next scheduled check does anyway.
 */
export function createEmailJobs(email: Email): AnyJobDefinition[] {
	return [
		defineJob({
			name: POLL_JOB,
			payload: z.object({}),
			timeoutMs: 10 * 60 * 1000,
			lane: 'long',
			maxAttempts: 1,
			async handle() {
				await email.poll();
			},
		}),
	];
}
