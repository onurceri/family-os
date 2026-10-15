import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Reads a line from the terminal without echoing it (a passphrase). Throws when there is no TTY. */
export async function askSecret(question: string): Promise<string> {
	if (!process.stdin.isTTY) throw new Error('No terminal to ask on');
	let muted = false;
	const output = new Writable({
		write(chunk, _encoding, done) {
			if (!muted) process.stderr.write(chunk);
			done();
		},
	});
	const rl = createInterface({ input: process.stdin, output, terminal: true });
	try {
		return await new Promise<string>((resolve) => {
			rl.question(question, (answer) => {
				process.stderr.write('\n');
				resolve(answer);
			});
			muted = true;
		});
	} finally {
		rl.close();
	}
}

/** Reads a line from the terminal (a confirmation). Throws when there is no TTY. */
export async function askLine(question: string): Promise<string> {
	if (!process.stdin.isTTY) throw new Error('No terminal to ask on');
	const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
	try {
		return await new Promise<string>((resolve) => rl.question(question, resolve));
	} finally {
		rl.close();
	}
}
