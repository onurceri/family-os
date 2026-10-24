import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { createSecretBox } from '@famos/adapters/secrets';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { migrate, openRuntime, type Runtime, resealSecrets } from '../src/runtime.ts';
import { SECRET_PURPOSES } from '../src/secret-purposes.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

let runtime: Runtime;
beforeEach(async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-reseal-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: 'http://localhost' });
	runtime = openRuntime(config, {
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
		extensions,
	});
	await migrate(runtime);
});
afterEach(() => runtime.close());

const sealedRow = (table: string, column: string) =>
	(
		runtime.handle.sqlite.prepare(`select ${column} as sealed from ${table} where id = 1`).get() as
			| { sealed: string }
			| undefined
	)?.sealed;

it('seals a Web Push key and a Telegram token written with the shared key under their own keys', async () => {
	const { secret } = runtime.config;
	const shared = createSecretBox(secret, SECRET_PURPOSES.ai);
	runtime.handle.sqlite
		.prepare(
			`insert into webpush_keys (id, public_key, private_key, created_at) values (1, 'pub', ?, 1)`,
		)
		.run(shared.seal('vapid-private'));
	runtime.handle.sqlite
		.prepare(`insert into telegram_settings (id, bot_token, updated_at) values (1, ?, 1)`)
		.run(shared.seal('123:bot-token'));

	await resealSecrets(runtime);

	const push = sealedRow('webpush_keys', 'private_key') as string;
	const bot = sealedRow('telegram_settings', 'bot_token') as string;
	expect(createSecretBox(secret, SECRET_PURPOSES.webPush).open(push)).toBe('vapid-private');
	expect(createSecretBox(secret, SECRET_PURPOSES.telegram).open(bot)).toBe('123:bot-token');
	// Key separation: the AI box no longer opens them, nor does one open the other's.
	expect(shared.open(push)).toBeNull();
	expect(shared.open(bot)).toBeNull();
	expect(createSecretBox(secret, SECRET_PURPOSES.telegram).open(push)).toBeNull();

	// Running it again leaves the rows as they are.
	await resealSecrets(runtime);
	expect(sealedRow('webpush_keys', 'private_key')).toBe(push);
	expect(sealedRow('telegram_settings', 'bot_token')).toBe(bot);
});

it('leaves a value no key opens untouched', async () => {
	const other = createSecretBox('o'.repeat(32), SECRET_PURPOSES.ai).seal('x');
	runtime.handle.sqlite
		.prepare(`insert into telegram_settings (id, bot_token, updated_at) values (1, ?, 1)`)
		.run(other);
	await resealSecrets(runtime);
	expect(sealedRow('telegram_settings', 'bot_token')).toBe(other);
});
