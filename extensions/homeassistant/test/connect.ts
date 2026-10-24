import type { Actor } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { ConnectInputSchema, type Connection } from '../src/contract/index.ts';

/** Saves the connection the way the settings page does: through the route that takes the token. */
export const connectHomeAssistant = async (
	k: TestKernel,
	actor: Actor,
	url: string,
	token: string,
): Promise<Connection> =>
	// The HTTP adapter validates the body before the handler runs; so does this.
	k.route('homeassistant.saveConnection').call({
		actor,
		body: ConnectInputSchema.parse({ url, token }),
	});
