import { BootGuard } from './boot-failure.js';

export const bootState = $state({ failed: false });
export const bootGuard = new BootGuard((failed) => {
	bootState.failed = failed;
});
