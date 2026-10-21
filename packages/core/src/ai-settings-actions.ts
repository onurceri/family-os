import {
	type Actor,
	type AiSettingsAdmin,
	defineAction,
	FamosError,
	LimitsSchema,
	PrivacySchema,
	ProviderCreateSchema,
	ProviderEditSchema,
	ProviderRecordSchema,
	personPresent,
	RolesSchema,
	SwitchesSchema,
} from '@famos/sdk';
import { z } from 'zod';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { aiModelsChanged } from './core-events.ts';

/**
 * What an admin chooses about the family's AI: its providers, which model does which job, the
 * monthly limits, what the AI may see and what is switched off. A provider's key is the one
 * thing that stays a route: it is a secret, and an action's answer is kept for replays. Every
 * action here needs the critical capability to manage AI, so the AI never runs nor proposes one,
 * and none takes or returns a key.
 */

const ProviderId = z.string().min(1).max(80);
const providerTarget = (input: { providerId: string }) => ({
	table: 'ai_providers',
	id: input.providerId,
});

export function createAiSettingsActions(deps: { settings: AiSettingsAdmin }) {
	/** A person acting directly: an app, the AI and the system never manage these. */
	const person = (actor: Actor): Actor => {
		if (!personPresent(actor)) throw new FamosError('forbidden', 'Only members can do this');
		return actor;
	};

	const addAiProvider = defineAction({
		id: 'core.addAiProvider',
		title: 'Add an AI provider (its key is set apart)',
		input: ProviderCreateSchema,
		output: ProviderRecordSchema,
		requires: CORE_CAPABILITIES.aiManage.id,
		approval: 'never',
		async run(uow, input) {
			person(uow.actor);
			return deps.settings.in(uow.db).createProvider(input);
		},
	});

	const updateAiProvider = defineAction({
		id: 'core.updateAiProvider',
		title: 'Rename an AI provider or change its address (a new address drops its stored key)',
		input: ProviderEditSchema.extend({ providerId: ProviderId }),
		output: z.object({
			provider: ProviderRecordSchema,
			/** The address moved, so the stored key was dropped and must be entered again. */
			keyDropped: z.boolean(),
		}),
		requires: CORE_CAPABILITIES.aiManage.id,
		approval: 'never',
		target: providerTarget,
		async run(uow, { providerId, ...patch }) {
			person(uow.actor);
			const edited = await deps.settings.in(uow.db).updateProvider(providerId, patch);
			uow.emit(aiModelsChanged, {});
			return edited;
		},
	});

	const deleteAiProvider = defineAction({
		id: 'core.deleteAiProvider',
		title: 'Remove an AI provider; the jobs that used it become unset',
		input: z.object({ providerId: ProviderId }),
		output: z.object({ providerId: z.string() }),
		requires: CORE_CAPABILITIES.aiManage.id,
		approval: 'never',
		target: providerTarget,
		async run(uow, { providerId }) {
			person(uow.actor);
			await deps.settings.in(uow.db).deleteProvider(providerId);
			uow.emit(aiModelsChanged, {});
			return { providerId };
		},
	});

	const setAiRoles = defineAction({
		id: 'core.setAiRoles',
		title: 'Choose the model for each AI job',
		input: RolesSchema,
		output: RolesSchema,
		requires: CORE_CAPABILITIES.aiManage.id,
		approval: 'never',
		async run(uow, input) {
			person(uow.actor);
			const roles = await deps.settings.in(uow.db).setRoles(input);
			// Family search follows the model that embeds.
			uow.emit(aiModelsChanged, {});
			return roles;
		},
	});

	const setAiLimits = defineAction({
		id: 'core.setAiLimits',
		title: 'Set the monthly budget and call limit of the AI',
		input: LimitsSchema,
		output: LimitsSchema,
		requires: CORE_CAPABILITIES.aiManage.id,
		approval: 'never',
		async run(uow, input) {
			person(uow.actor);
			return deps.settings.in(uow.db).setLimits(input);
		},
	});

	const setAiPrivacy = defineAction({
		id: 'core.setAiPrivacy',
		title: 'Set what the AI may see and how providers must treat it',
		input: PrivacySchema,
		output: PrivacySchema,
		requires: CORE_CAPABILITIES.aiManage.id,
		approval: 'never',
		async run(uow, input) {
			person(uow.actor);
			return deps.settings.in(uow.db).setPrivacy(input);
		},
	});

	const setAiSwitches = defineAction({
		id: 'core.setAiSwitches',
		title: 'Turn the AI, or single AI features, on or off',
		input: SwitchesSchema,
		output: SwitchesSchema,
		requires: CORE_CAPABILITIES.aiManage.id,
		approval: 'never',
		async run(uow, input) {
			person(uow.actor);
			return deps.settings.in(uow.db).setSwitches(input);
		},
	});

	return [
		addAiProvider,
		updateAiProvider,
		deleteAiProvider,
		setAiRoles,
		setAiLimits,
		setAiPrivacy,
		setAiSwitches,
	];
}
