import { AI_AREA_ACCESS, defineAction, defineRoute, FamosError } from '@famos/sdk';
import { z } from 'zod';
import { readAiAreas, writeAiAreas } from '../ai-areas.ts';
import { CORE_CAPABILITIES } from '../core-capabilities.ts';
import { aiAreasChanged, featuresChanged } from '../core-events.ts';
import { FamilySettingsSchema, readFamilySettings, writeFamilySettings } from '../family.ts';
import { readDisabled, writeDisabled } from '../features.ts';
import { type createLanguages, familySettingsChanged } from '../languages.ts';
import type { CoreExtensionDeps } from './deps.ts';

/** Family settings, which extensions are on, and how far the AI may use each area. */
export function createSettings(
	deps: CoreExtensionDeps,
	languages: ReturnType<typeof createLanguages>,
) {
	const setFeatureEnabled = defineAction({
		id: 'core.setFeatureEnabled',
		title: 'Turn an extension on or off',
		input: z.object({ extensionId: z.string(), enabled: z.boolean() }),
		output: z.object({ extensionId: z.string(), enabled: z.boolean() }),
		requires: CORE_CAPABILITIES.featuresManage.id,
		approval: 'never',
		async run(uow, input) {
			if (!deps.extensionIds().includes(input.extensionId))
				throw new FamosError('bad_request', `Unknown extension "${input.extensionId}"`);
			if (input.extensionId === 'core')
				throw new FamosError('bad_request', 'Core cannot be turned off');
			const disabled = new Set(await readDisabled(uow.db));
			if (input.enabled) disabled.delete(input.extensionId);
			else disabled.add(input.extensionId);
			await writeDisabled(uow.db, [...disabled], uow.clock.now());
			// Data stays; the cache is refreshed after commit (kernel listener).
			uow.emit(featuresChanged, input);
			return input;
		},
	});

	const setAiAreaAccess = defineAction({
		id: 'core.setAiAreaAccess',
		title: 'Choose how far the AI may use an area',
		input: z.object({
			extensionId: z.string(),
			access: z.enum(AI_AREA_ACCESS),
			/** Required to open a sensitive area to any provider: the data leaves the house. */
			confirmSensitive: z.boolean().optional(),
		}),
		output: z.object({ extensionId: z.string(), access: z.enum(AI_AREA_ACCESS) }),
		requires: CORE_CAPABILITIES.aiManage.id,
		approval: 'never',
		async run(uow, input) {
			const area = deps.extensions().find((e) => e.id === input.extensionId);
			if (!area || input.extensionId === 'core')
				throw new FamosError('bad_request', `"${input.extensionId}" is not an area for the AI`);
			if (area.sensitive && input.access === 'any' && input.confirmSensitive !== true) {
				throw new FamosError(
					'bad_request',
					`"${input.extensionId}" is a sensitive area: opening it to any provider sends its data to that provider, so it needs confirmSensitive: true`,
				);
			}
			const areas = await readAiAreas(uow.db);
			areas[input.extensionId] = input.access;
			await writeAiAreas(uow.db, areas, uow.clock.now());
			// The cache is refreshed after commit (kernel listener).
			uow.emit(aiAreasChanged, { extensionId: input.extensionId, access: input.access });
			return { extensionId: input.extensionId, access: input.access };
		},
	});

	const updateFamilySettings = defineAction({
		id: 'core.updateFamilySettings',
		title: 'Change family settings (time zone, language, region formats)',
		input: FamilySettingsSchema.omit({ name: true }).partial(),
		output: FamilySettingsSchema,
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		async run(uow, input) {
			if (input.locale) languages.assertKnown(input.locale);
			const next = { ...(await readFamilySettings(uow.db)), ...input };
			await writeFamilySettings(uow.db, next, uow.clock.now());
			// Other open screens (language, region formats, time zone) refresh without a reload.
			uow.emit(familySettingsChanged, {});
			return next;
		},
	});

	const setFamilyName = defineAction({
		id: 'core.setFamilyName',
		title: 'Set or clear the family name',
		input: z.object({ name: z.string().trim().max(60) }),
		output: z.object({ name: z.string().nullable() }),
		requires: CORE_CAPABILITIES.settingsManage.id,
		approval: 'never',
		async run(uow, input) {
			const { name: _old, ...rest } = await readFamilySettings(uow.db);
			const name = input.name === '' ? null : input.name;
			await writeFamilySettings(
				uow.db,
				{ ...rest, ...(name !== null && { name }) },
				uow.clock.now(),
			);
			uow.emit(familySettingsChanged, {});
			return { name };
		},
	});

	const listFeatures = defineRoute({
		method: 'get',
		path: '/features',
		operationId: 'core.listFeatures',
		summary: 'Extensions and whether each is turned on',
		requires: CORE_CAPABILITIES.featuresManage.id,
		response: z.array(z.object({ id: z.string(), enabled: z.boolean(), canDisable: z.boolean() })),
		async handle() {
			const features = deps.features();
			return deps.extensionIds().map((id) => ({
				id,
				enabled: features.isOn(id),
				canDisable: id !== 'core',
			}));
		},
	});

	const listAiAreas = defineRoute({
		method: 'get',
		path: '/ai-areas',
		operationId: 'core.listAiAreas',
		summary: 'Areas (extensions) and how far the AI may use each',
		requires: CORE_CAPABILITIES.aiManage.id,
		response: z.array(
			z.object({
				id: z.string(),
				sensitive: z.boolean(),
				/** It offers actions the AI can propose (other areas only matter if sensitive). */
				usesAi: z.boolean(),
				access: z.enum(AI_AREA_ACCESS),
				default: z.enum(AI_AREA_ACCESS),
			}),
		),
		async handle() {
			const areas = deps.aiAreas();
			return deps
				.extensions()
				.filter((e) => e.id !== 'core')
				.map((e) => ({
					id: e.id,
					sensitive: e.sensitive,
					usesAi: e.usesAi,
					access: areas.access(e.id),
					default: areas.defaultFor(e.id),
				}));
		},
	});

	const familyName = defineRoute({
		method: 'get',
		path: '/family-name',
		operationId: 'core.getFamilyName',
		summary: 'What the family is called, for the sign-in page of a family device',
		// A surname identifies the family: only trusted family devices (or signed-in members) get it.
		requires: 'trusted-device',
		response: z.object({ name: z.string().nullable() }),
		async handle(ctx) {
			return { name: (await ctx.family.settings()).name ?? null };
		},
	});

	const familySettings = defineRoute({
		method: 'get',
		path: '/settings/family',
		operationId: 'core.getFamilySettings',
		summary: 'Family time zone, default language and region formats',
		requires: 'signedIn',
		response: FamilySettingsSchema,
		async handle(ctx) {
			return ctx.family.settings();
		},
	});

	return {
		setFeatureEnabled,
		setAiAreaAccess,
		updateFamilySettings,
		setFamilyName,
		listFeatures,
		listAiAreas,
		familyName,
		familySettings,
	};
}
