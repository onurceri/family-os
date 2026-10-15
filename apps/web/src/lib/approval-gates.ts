/**
 * The app context's two gates for changes guarded by a capability (an action's
 * `approval: { unless }`), from the viewer's capabilities. One place, so a control and its form
 * never disagree.
 */
export function approvalGates(can: (capability: string) => boolean) {
	const proposes = () => can('core.drafts.propose');
	return {
		/** Show the control at all: they hold the capability, or may suggest the change. */
		mayChange: (capability: string) => can(capability) || proposes(),
		/** Their change waits for approval: they may suggest it but lack the capability. */
		needsApproval: (capability: string) => !can(capability) && proposes(),
	};
}
