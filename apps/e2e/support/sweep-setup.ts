import { prepareFamily } from './global-setup.ts';

/** The sweep pictures every page, so its family has every offered extension. */
export default async function sweepSetup() {
	await prepareFamily([]);
}
