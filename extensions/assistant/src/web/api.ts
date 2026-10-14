import { createApiClient } from '@famos/api-client';
import type { paths } from './api.gen.d.ts';

/** This extension's client: the host's routes and its own. */
export const api = createApiClient<paths>();
