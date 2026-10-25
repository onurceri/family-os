import { CORE_CAPABILITIES, publicPath } from '@famos/core';
import { appOf } from '@famos/sdk';
import { z } from 'zod';
import {
	errorDocs,
	json,
	LIST_DRAFTS_SUMMARY,
	onBehalfHeader,
	PUBLIC_API_BASE,
	type PublicParts,
} from './shared.ts';

/** `GET /`: what this server offers the caller. */
export function mountDiscovery(parts: PublicParts) {
	const { api, kernel, deps, operations } = parts;

	// ───────────── discovery, drafts, changes ─────────────

	const Method = z.enum(['get', 'post', 'put', 'patch', 'delete']);
	const DiscoverySchema = z
		.object({
			api: z.literal('v1'),
			familyOS: z.string().describe('The version of this FamilyOS server'),
			timeZone: z.string().describe('The family time zone'),
			language: z.string().describe('The family language'),
			caller: z.object({
				app: z.object({ id: z.string(), name: z.string(), mode: z.enum(['apply', 'suggest']) }),
				memberId: z
					.string()
					.nullable()
					.describe('The member this request acts for, if it named one'),
			}),
			actsFor: z
				.array(z.object({ memberId: z.string(), name: z.string() }))
				.describe(
					'The active members this app may act for: send one `memberId` in `X-FamilyOS-On-Behalf-Of` to act as that person',
				),
			extensions: z.array(
				z.object({
					id: z.string(),
					version: z.string(),
					enabled: z.boolean().describe('False when it is switched off in Settings'),
				}),
			),
			operations: z
				.array(
					z.object({
						name: z.string().describe('The operation’s `operationId`'),
						method: Method,
						path: z.string().describe('The full path, with `{param}` for the parts that vary'),
						summary: z.string(),
						outcome: z
							.enum(['read', 'apply', 'draft'])
							.describe(
								'What a call does for this caller now: `read`; `apply` the change is made; `draft` it waits for a person to approve it',
							),
					}),
				)
				.describe(
					'Only what this caller may use now: the app’s role, and the member it acts for, decide',
				),
		})
		.meta({ id: 'Discovery' });

	api.openAPIRegistry.registerPath({
		method: 'get',
		path: '/',
		operationId: 'core.discover',
		summary:
			'What this server offers this caller: versions, the family, the extensions and the operations the caller may use now',
		tags: ['core'],
		security: [{ bearer: [] }],
		request: { headers: z.object({ 'x-familyos-on-behalf-of': onBehalfHeader }) },
		responses: {
			200: { description: 'The discovery document', ...json(DiscoverySchema) },
			...errorDocs([401, 403, 429]),
		},
	});
	api.get('/', async (c) => {
		const actor = c.get('actor');
		const caller = c.get('caller');
		const settings = await kernel.ctx.family.settings();
		const active = new Map((await kernel.ctx.family.members()).map((m) => [m.id as string, m]));
		const actsFor = caller.actsFor.flatMap((id) => {
			const member = active.get(id);
			return member ? [{ memberId: member.id as string, name: member.displayName }] : [];
		});
		const decisions = kernel.runner.decisions(actor);
		const usable: z.infer<typeof DiscoverySchema>['operations'] = [];
		for (const op of operations) {
			if (!kernel.features.isOn(op.extension)) continue;
			let outcome: 'read' | 'apply' | 'draft';
			if (op.source.kind === 'route') {
				if (!kernel.access.can(actor, op.source.route.requires)) continue;
				outcome = 'read';
			} else {
				const decision = decisions[op.source.action.id];
				if (!decision || decision.outcome === 'refuse') continue;
				outcome = decision.outcome;
			}
			usable.push({
				name: op.exposure.name,
				method: op.exposure.method,
				path: `${PUBLIC_API_BASE}${publicPath(op.extension, op.exposure.path)}`,
				summary: op.exposure.summary,
				outcome,
			});
		}
		// The suggestions it may read are core's own route, not an extension's, so they are named here.
		if (kernel.access.can(actor, CORE_CAPABILITIES.draftsPropose.id))
			usable.push({
				name: 'core.listDrafts',
				method: 'get',
				path: `${PUBLIC_API_BASE}/drafts`,
				summary: LIST_DRAFTS_SUMMARY,
				outcome: 'read',
			});
		return c.json(
			{
				api: 'v1' as const,
				familyOS: deps.appVersion,
				timeZone: settings.timeZone,
				language: settings.locale,
				caller: {
					app: {
						id: caller.app.id,
						name: caller.app.name,
						mode: appOf(actor)?.mode ?? 'apply',
					},
					memberId: caller.memberId,
				},
				actsFor,
				extensions: kernel.registry.extensions
					.filter((ext) => ext.id !== 'core')
					.map((ext) => ({
						id: ext.id,
						version: ext.manifest.version,
						enabled: kernel.features.isOn(ext.id),
					})),
				operations: usable,
			},
			200,
		);
	});
}
