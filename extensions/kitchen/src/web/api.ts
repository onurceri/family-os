import { createApiClient } from '@famos/api-client';
import type { paths as lists } from '@famos/ext-lists/api';
import type { paths } from './api.gen.d.ts';

/**
 * This extension's client: the host's routes, its own and those of the lists extension, which it
 * reads and declares as a dependency.
 */
export const api = createApiClient<paths & lists>();
