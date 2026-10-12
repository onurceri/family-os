import { createHash, randomBytes } from 'node:crypto';

/**
 * A cheap stand-in for the production password hash (scrypt, which takes tens of milliseconds and
 * a lot of memory per call). Tests sign in many times, so with the real hash a busy machine pushes
 * them past the test timeout; the sign-in logic under test is the same either way.
 */
const digest = (salt: string, password: string) =>
	createHash('sha256').update(`${salt}:${password}`).digest('hex');

export const fastPasswordHasher = {
	hash: async (password: string) => {
		const salt = randomBytes(8).toString('hex');
		return `${salt}:${digest(salt, password)}`;
	},
	verify: async ({ hash, password }: { hash: string; password: string }) => {
		const [salt = '', expected] = hash.split(':');
		return digest(salt, password) === expected;
	},
};
