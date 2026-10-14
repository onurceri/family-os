import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import { assistantUse } from './capabilities.ts';
import { migrations } from './store.ts';
import { summarizeJob } from './summary.ts';
import { deleteThread, getThread, listThreads, renameThread, sendMessage } from './threads.ts';
import { assistantDelta, assistantDone, turnJob } from './turn.ts';

/**
 * The family assistant: per-member chat threads. Answers are written by a job that
 * gives the model the tools the asking member may use (read tools, and draft tools whose changes
 * a person approves), and streams the text to that member only.
 */
export default defineExtension({
	manifest: pkg.famos,
	migrations,
	actions: [sendMessage, renameThread, deleteThread],
	routes: [listThreads, getThread],
	events: [assistantDelta, assistantDone],
	capabilities: [assistantUse],
	jobs: [turnJob, summarizeJob],
});
