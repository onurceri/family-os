import {
	type AnyActionDefinition,
	type AnyRouteDefinition,
	type ApiExposure,
	defineAction,
	defineApi,
	defineCapability,
	defineRoute,
	FileResponseSchema,
} from '@famos/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeField } from '../src/api-operations.ts';
import { buildRegistry } from '../src/registry.ts';
import { defineTestExtension } from './harness.ts';

const view = defineCapability({ id: 'garage.view', label: 'garage:cap_view', level: 'view' });
const edit = defineCapability({ id: 'garage.edit', label: 'garage:cap_edit', level: 'edit' });

const read = (api: Partial<ApiExposure> = {}) =>
	defineRoute({
		method: 'get',
		path: '/cars/{carId}',
		operationId: 'garage.getCar',
		summary: 'A car',
		requires: view.id,
		params: z.object({ carId: z.string() }),
		response: z.object({ id: z.string() }),
		expose: defineApi({
			name: 'garage.getCar',
			method: 'get',
			path: '/cars/{carId}',
			summary: 'One car',
			...api,
		}),
		async handle(_ctx, { params }) {
			return { id: params.carId };
		},
	});

const change = (api: Partial<ApiExposure> = {}, extra: { external?: boolean } = {}) =>
	defineAction({
		id: 'garage.renameCar',
		title: 'Rename a car',
		input: z.object({ id: z.string(), name: z.string().optional(), label: z.string() }),
		output: z.object({ id: z.string() }),
		requires: edit.id,
		approval: 'never',
		...extra,
		expose: defineApi({
			name: 'garage.renameCar',
			method: 'patch',
			path: '/cars/{carId}',
			params: { carId: 'id' },
			summary: 'Rename',
			...api,
		}),
		async run(_uow, { id }) {
			return { id };
		},
	});

const build = (
	actions: AnyActionDefinition[] = [change()],
	routes: AnyRouteDefinition[] = [read()],
) =>
	buildRegistry([
		defineTestExtension({ id: 'garage', actions, routes, capabilities: [view, edit] }),
	]);

describe('what extensions offer on the public API', () => {
	it('collects the marked actions and routes with their full paths', () => {
		const registry = build();
		expect(
			registry.apiOperations.map((o) => [o.exposure.name, o.exposure.method, o.exposure.path]),
		).toEqual([
			['garage.renameCar', 'patch', '/cars/{carId}'],
			['garage.getCar', 'get', '/cars/{carId}'],
		]);
		expect(registry.actions.get('garage.renameCar')?.expose).toBe('app');
	});

	it('offers nothing that is not marked', () => {
		const plain = defineAction({
			id: 'garage.sellCar',
			title: 'Sell',
			input: z.object({ id: z.string() }),
			output: z.object({ ok: z.boolean() }),
			requires: edit.id,
			approval: 'never',
			async run() {
				return { ok: true };
			},
		});
		expect(build([plain], []).apiOperations).toEqual([]);
	});

	it('takes several operations from one action', () => {
		const both = defineAction({
			id: 'garage.park',
			title: 'Park',
			input: z.object({ id: z.string(), parked: z.boolean() }),
			output: z.object({ id: z.string() }),
			requires: edit.id,
			approval: 'never',
			expose: [
				defineApi({
					name: 'garage.parkCar',
					method: 'post',
					path: '/cars/{id}/park',
					fixed: { parked: true },
					summary: 'Park',
				}),
				defineApi({
					name: 'garage.unparkCar',
					method: 'post',
					path: '/cars/{id}/unpark',
					fixed: { parked: false },
					summary: 'Take out',
				}),
			],
			async run(_uow, { id }) {
				return { id };
			},
		});
		expect(build([both], []).apiOperations.map((o) => o.exposure.name)).toEqual([
			'garage.parkCar',
			'garage.unparkCar',
		]);
	});

	it.each([
		[
			'a description of a field that is not there',
			() => build([change({ describe: { 'name.first': 'x' } })]),
			/"name\.first" is not a field/,
		],
		[
			'a description of a nested field that is not there',
			() => build([change({ describe: { 'nope.first': 'x' } })]),
			/"nope\.first" is not a field/,
		],
	])('refuses %s', (_name, make, message) => {
		expect(make).toThrow(message);
	});

	it('describes a field inside another, in objects, arrays and optionals, and keeps the checks', () => {
		const schema = z.object({
			items: z.array(z.object({ quantity: z.string().max(3).nullable().optional() })).min(1),
		});
		const described = describeField(schema, ['items', 'quantity'], 'How much') as z.ZodObject;
		const quantity = (described.shape.items as z.ZodArray).element as z.ZodObject;
		expect(z.toJSONSchema(described).properties).toMatchObject({
			items: { items: { properties: { quantity: { description: 'How much' } } } },
		});
		expect(quantity.shape.quantity).toBeDefined();
		expect(described.safeParse({ items: [{ quantity: 'abcd' }] }).success).toBe(false);
		expect(described.safeParse({ items: [] }).success).toBe(false);
		expect(described.safeParse({ items: [{}] }).success).toBe(true);
		// The schema it started from is untouched.
		expect(JSON.stringify(z.toJSONSchema(schema))).not.toContain('How much');
		expect(describeField(schema, ['items', 'nope'], 'x')).toBeNull();
	});

	it.each([
		['a name outside the extension', () => build([change({ name: 'cars.renameCar' })]), /garage\./],
		['a name that is not verb and noun', () => build([change({ name: 'garage' })]), /garage\./],
		['a path with a capital', () => build([change({ path: '/Cars/{carId}' })]), /public path/],
		['a path without a leading slash', () => build([change({ path: 'cars' })]), /public path/],
		[
			'a path part that is not an input field',
			() => build([change({ path: '/cars/{carId}', params: { carId: 'nope' } })]),
			/"nope" is not a field/,
		],
		[
			'a fixed field that is not an input field',
			() => build([change({ fixed: { nope: 1 } })]),
			/"nope" is not a field/,
		],
		[
			'a required field left out of the request',
			() => build([change({ omit: ['id'] })]),
			/"id" is required/,
		],
		['a change served as GET', () => build([change({ method: 'get' })]), /offered as a route/],
		[
			'a PUT with no target to compare versions on',
			() => build([change({ method: 'put' })]),
			/needs a target with a version column/,
		],
		[
			'two operations with one name',
			() => build([change(), change({ path: '/vehicles/{carId}' })]),
			/Duplicate/,
		],
		[
			'two operations on one method and path',
			() => build([change({ name: 'garage.renameCarAgain' }), change()]),
			/Duplicate|answer/,
		],
		[
			'an action that sends data out of the household',
			() => build([change({}, { external: true })]),
			/out of the household/,
		],
		[
			'a route that is not a GET',
			() => build([], [read({ method: 'post' })]),
			/can only be offered as GET/,
		],
		[
			'a route open to anyone',
			() =>
				build(
					[],
					[
						defineRoute({
							method: 'get',
							path: '/open',
							operationId: 'garage.open',
							summary: 'Open',
							requires: 'public',
							response: z.object({}),
							expose: defineApi({
								name: 'garage.open',
								method: 'get',
								path: '/open',
								summary: 'Open',
							}),
							async handle() {
								return {};
							},
						}),
					],
				),
			/must require a capability/,
		],
		[
			'a route that sends a file',
			() =>
				build(
					[],
					[
						defineRoute({
							method: 'get',
							path: '/photo',
							operationId: 'garage.photo',
							summary: 'Photo',
							requires: view.id,
							response: FileResponseSchema,
							expose: defineApi({
								name: 'garage.photo',
								method: 'get',
								path: '/photo',
								summary: 'Photo',
							}),
							async handle() {
								throw new Error('unused');
							},
						}),
					],
				),
			/sends a file or text/,
		],
	])('refuses %s', (_what, make, reason) => {
		expect(make).toThrow(reason);
	});

	it('refuses an action whose input is not an object', () => {
		const odd = defineAction({
			id: 'garage.odd',
			title: 'Odd',
			input: z.union([z.object({ id: z.string() }), z.object({ name: z.string() })]),
			output: z.object({}),
			requires: edit.id,
			approval: 'never',
			expose: defineApi({ name: 'garage.odd', method: 'post', path: '/odd', summary: 'Odd' }),
			async run() {
				return {};
			},
		});
		expect(() => build([odd], [])).toThrow(/not an object/);
	});

	it('lets the root of an extension be a collection', () => {
		const list = read({ name: 'garage.listCars', path: '/', params: undefined });
		const ops = buildRegistry([
			defineTestExtension({
				id: 'garage',
				routes: [
					defineRoute({
						method: 'get',
						path: '/cars',
						operationId: 'garage.listCars',
						summary: 'Cars',
						requires: view.id,
						response: z.array(z.object({ id: z.string() })),
						expose: list.expose,
						async handle() {
							return [];
						},
					}),
				],
				capabilities: [view, edit],
			}),
		]).apiOperations;
		expect(ops).toHaveLength(1);
	});
});
