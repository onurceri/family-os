import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { LoadedWeb } from '../extensions/web.ts';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';

const LoadedExtensionsSchema = z.object({
	fingerprint: z.string().openapi({
		description: 'Changes whenever an extension, its version or its build changes',
	}),
	extensions: z.array(z.object({ id: z.string(), version: z.string() })),
});

/**
 * Which extensions this server runs. Public, like the shell that names them: the app's dev server
 * compiles only these, and an open app compares the fingerprint to see that the server changed.
 */
export function mountExtensionRoutes(app: OpenAPIHono<AppEnv>, loaded: LoadedWeb): void {
	const body = LoadedExtensionsSchema.parse({
		fingerprint: loaded.fingerprint,
		extensions: loaded.extensions,
	});
	app.openapi(
		createRoute({
			method: 'get',
			path: '/api/v1/core/extensions/loaded',
			operationId: 'core.loadedExtensions',
			summary: 'The extensions this server runs',
			tags: ['core'],
			responses: {
				200: {
					description: 'The running extensions',
					content: { 'application/json': { schema: LoadedExtensionsSchema } },
				},
				...errorResponses,
			},
		}),
		(c) => c.json(body, 200),
	);
}
