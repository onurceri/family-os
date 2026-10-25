import { systemActor } from '@famos/sdk';
import { createAdmission } from './action-runner/admission.ts';
import { createApproval } from './action-runner/approval.ts';
import { createDeciders } from './action-runner/deciders.ts';
import { createHints } from './action-runner/hints.ts';
import { createInvoke } from './action-runner/invoke.ts';
import { createLabels } from './action-runner/labels.ts';
import { createTargets } from './action-runner/targets.ts';
import type { ActionRunner, ActionRunnerDeps } from './action-runner/types.ts';
import { createUndo } from './action-runner/undo.ts';
import { createUnitOfWork } from './action-runner/unit-of-work.ts';
import { createWaiting } from './action-runner/waiting.ts';

export { GONE, NESTED_NEEDS_APPROVAL, SETTLED } from './action-runner/shared.ts';
export type {
	ActionRunner,
	ActionRunnerDeps,
	DeciderFacts,
	DraftMeta,
	DraftUnavailable,
	ExtensionViews,
	GoneFacts,
	InvokeOptions,
	PassedFacts,
} from './action-runner/types.ts';

export function createActionRunner(deps: ActionRunnerDeps): ActionRunner {
	const admission = createAdmission(deps);
	const units = createUnitOfWork(deps, admission);
	const deciders = createDeciders(deps, admission);
	const targets = createTargets(deps, admission);
	const hints = createHints(deps, admission);
	const labels = createLabels(deps, { ...admission, ...deciders, ...hints });
	const waiting = createWaiting(deps, { ...admission, ...deciders, ...units });
	const parts = {
		...admission,
		...units,
		...deciders,
		...targets,
		...hints,
		...labels,
		...waiting,
	};
	const { invoke } = createInvoke(deps, parts);
	const { editDraft, approveDraft, rejectDraft, replaceDraft } = createApproval(deps, parts);
	const { undoStep, undoDraft, suggestedAgain, suggestAgain } = createUndo(deps, parts);
	const { check, decisionsFor } = admission;
	const { unitOfWork } = units;
	const { mayDecide, isProposer, draftVisibleTo, unavailable } = deciders;
	const { mayExist, alternative, currentValues, subjectOfDraft } = hints;
	const { appBehind } = labels;
	const { waitingFor, visibleDraftIds, passedCheck, goneAmong, expirePassed } = waiting;

	return {
		invoke,
		unit: (extensionId, work) =>
			unitOfWork(systemActor(extensionId), (_core, view) => work(view(extensionId))),
		check,
		decisions: decisionsFor,
		approveDraft,
		rejectDraft,
		undoDraft,
		suggestAgain,
		suggestedAgain,
		appBehind,
		undoStep,
		mayExist,
		alternative,
		currentValues,
		subject: subjectOfDraft,
		replaceDraft,
		mayDecide,
		isProposer,
		waitingFor,
		draftVisibleTo,
		visibleDraftIds,
		unavailable,
		editDraft,
		passedCheck,
		goneAmong,
		expirePassed,
	};
}
