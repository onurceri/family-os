import {
	type AnyActionDefinition,
	type AnyRouteDefinition,
	type ApiExposure,
	FileResponseSchema,
	TextResponseSchema,
} from '@famos/sdk';
import { z } from 'zod';

/** One operation of the public API, with the action or route that serves it. */
export type ApiOperation = {
	/** The extension that offers it. */
	readonly extension: string;
	readonly exposure: ApiExposure;
	readonly source:
		| { readonly kind: 'action'; readonly action: AnyActionDefinition }
		| { readonly kind: 'route'; readonly route: AnyRouteDefinition };
};

const NAME = /^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/;
/** `/` is the extension's own root; otherwise segments of lowercase words or `{param}`. */
const PATH = /^(\/|(\/(?:[a-z][a-z0-9-]*|\{[a-zA-Z][a-zA-Z0-9]*\}))+)$/;
const PARAM = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/** The path of an operation below the API's address: `/<extension>` and then its own path. */
export const publicPath = (extension: string, path: string): string =>
	path === '/' ? `/${extension}` : `/${extension}${path}`;

/** The names of the `{param}` parts of a path. */
export const pathParams = (path: string): string[] =>
	[...path.matchAll(PARAM)].map((m) => m[1] as string);

/**
 * Collects the operations the extensions offer on the public API and refuses the ones that break
 * its grammar: a name outside the extension's own, a path or method used twice, a read that is not
 * a `GET`, a change that is, an action that sends data out of the household, a route that is not
 * plain JSON or is open to anyone. `refuse` ends the start with the reason.
 */
export function collectApiOperations(
	extensions: readonly {
		id: string;
		actions: readonly AnyActionDefinition[];
		routes: readonly AnyRouteDefinition[];
	}[],
	refuse: (extension: string, reason: string) => never,
	isCapability: (id: string) => boolean,
): readonly ApiOperation[] {
	const operations: ApiOperation[] = [];
	const names = new Set<string>();
	const places = new Set<string>();

	const check = (extension: string, exposure: ApiExposure, where: string) => {
		if (!NAME.test(exposure.name) || !exposure.name.startsWith(`${extension}.`))
			refuse(
				extension,
				`${where} has the public name "${exposure.name}"; use "${extension}.<verbNoun>"`,
			);
		if (!PATH.test(exposure.path))
			refuse(extension, `${where} has the public path "${exposure.path}"`);
		if (names.has(exposure.name))
			refuse(extension, `Duplicate public operation name "${exposure.name}"`);
		names.add(exposure.name);
		const place = `${exposure.method} ${publicPath(extension, exposure.path).replace(PARAM, '{}')}`;
		if (places.has(place)) refuse(extension, `Two public operations answer ${place}`);
		places.add(place);
	};

	for (const ext of extensions) {
		for (const action of ext.actions) {
			for (const exposure of action.api) {
				const where = `Action "${action.id}"`;
				check(ext.id, exposure, where);
				if (action.expose === 'internal')
					refuse(ext.id, `${where} is internal and cannot be public`);
				if (action.external)
					refuse(ext.id, `${where} sends data out of the household and cannot be public`);
				if (action.readOnly || exposure.method === 'get')
					refuse(ext.id, `${where}: a read is offered as a route (GET), not as an action`);
				if (!(action.input instanceof z.ZodObject))
					refuse(ext.id, `${where} has an input that is not an object, so it cannot be public`);
				const shape = (action.input as z.ZodObject).shape;
				const fields = [
					...pathParams(exposure.path).map((name) => exposure.params?.[name] ?? name),
					...Object.keys(exposure.fixed ?? {}),
					...(exposure.omit ?? []),
					...Object.keys(exposure.describe ?? {}),
				];
				for (const name of fields)
					if (!(name in shape)) refuse(ext.id, `${where}: "${name}" is not a field of its input`);
				for (const name of exposure.omit ?? [])
					if (!shape[name]?.safeParse(undefined).success)
						refuse(
							ext.id,
							`${where}: "${name}" is required, so it cannot be left out of the request`,
						);
				if (exposure.method === 'put' && !action.target)
					refuse(ext.id, `${where}: a replace (PUT) needs a target with a version column`);
				operations.push({ extension: ext.id, exposure, source: { kind: 'action', action } });
			}
		}
		for (const route of ext.routes) {
			const exposure = route.expose;
			if (!exposure) continue;
			const where = `Route "${route.operationId}"`;
			check(ext.id, exposure, where);
			if (exposure.method !== 'get')
				refuse(ext.id, `${where} is a read and can only be offered as GET`);
			if (!isCapability(route.requires))
				refuse(ext.id, `${where} must require a capability to be public`);
			if (
				route.upload ||
				route.response === FileResponseSchema ||
				route.response === TextResponseSchema
			)
				refuse(ext.id, `${where} sends a file or text and cannot be public`);
			if (exposure.fixed) refuse(ext.id, `${where}: a read has no fixed fields`);
			for (const name of pathParams(exposure.path)) {
				const shape = route.params instanceof z.ZodObject ? route.params.shape : {};
				if (!(name in shape)) refuse(ext.id, `${where}: "${name}" is not one of its params`);
			}
			operations.push({ extension: ext.id, exposure, source: { kind: 'route', route } });
		}
	}
	return operations;
}
