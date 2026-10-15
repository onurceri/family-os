// The key that signs extension packages and the official index.
//   node scripts/extension-key.mjs generate --out <file.pem>
//     Makes a new ed25519 key pair. The private key goes only to <file.pem> (mode 600, never
//     overwritten, never printed); the public key and its id are printed as a trust root to
//     commit in apps/server/src/packages/trust.ts.
//   node scripts/extension-key.mjs check (--key-env <VAR> | --key-file <pem>)
//     Says whether a private key is one the server trusts (the release workflow checks the
//     secret this way before it signs anything with it).

import { createPublicKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { TRUST_ROOTS } from '../apps/server/src/packages/trust.ts';
import { generateSigningKey, keyIdOf, loadSigningKey } from '../packages/pack/src/famext.ts';

const usage = `Usage:
  node scripts/extension-key.mjs generate --out <file.pem>
  node scripts/extension-key.mjs check (--key-env <VAR> | --key-file <pem>)`;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		out: { type: 'string' },
		'key-env': { type: 'string' },
		'key-file': { type: 'string' },
	},
});

try {
	switch (positionals[0]) {
		case 'generate': {
			if (!values.out) {
				console.error(usage);
				process.exit(2);
			}
			const key = generateSigningKey();
			// `wx`: an existing key is never replaced by accident.
			writeFileSync(values.out, key.privateKey, { flag: 'wx', mode: 0o600 });
			console.log(`Private key written to ${values.out} (keep it secret; it is not shown here).`);
			console.log('Trust root for apps/server/src/packages/trust.ts:\n');
			console.log(
				`\t{\n\t\tkeyId: '${key.keyId}',\n\t\tkind: 'official',\n\t\tpublicKey: '${key.publicKey}',\n\t},`,
			);
			break;
		}
		case 'check': {
			const env = values['key-env'];
			const file = values['key-file'];
			if (Boolean(env) === Boolean(file)) {
				console.error(usage);
				process.exit(2);
			}
			const key = await loadSigningKey(env ? { env } : { file });
			const keyId = keyIdOf(createPublicKey(key));
			const root = TRUST_ROOTS.find((r) => r.keyId === keyId);
			if (!root) {
				console.error(`The key ${keyId} is not among the server's trust roots`);
				process.exit(1);
			}
			console.log(`The key ${keyId} is trusted (${root.kind})`);
			break;
		}
		default:
			console.error(usage);
			process.exit(2);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
