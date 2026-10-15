// The image's entry point (`dist/famos.mjs`). `serve` runs the server in a process of its own and
// starts it again when it exits asking for that (after installing an extension, for one); every
// other command runs here, in this process, exactly as `main.mjs <command>` does.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { supervise } from './supervisor.ts';

const MAIN = new URL('./main.mjs', import.meta.url);
const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith('-')) ?? 'serve';

if (command === 'serve' && !args.includes('--help')) {
	const code = await supervise({
		start: () =>
			spawn(process.execPath, [...process.execArgv, fileURLToPath(MAIN), ...args], {
				stdio: 'inherit',
			}),
		now: Date.now,
		wait: (ms, until) =>
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, ms);
				void until.then(() => {
					clearTimeout(timer);
					resolve();
				});
			}),
		onSignal(handler) {
			process.on('SIGTERM', () => handler('SIGTERM'));
			process.on('SIGINT', () => handler('SIGINT'));
		},
		log: (message) => console.log(message),
	});
	process.exit(code);
} else {
	await import(MAIN.href);
}
