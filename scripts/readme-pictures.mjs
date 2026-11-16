// The pull-request body for refreshed README pictures (.github/workflows/readme-pictures.yml).
//   node scripts/readme-pictures.mjs body --repo <owner/name> --base <sha> --head <sha>
// Finds the pictures that changed between the two commits and prints a Before | After table for
// each, with images read from raw.githubusercontent.com at each commit.
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const IMAGES = 'docs/images';

/** The address of a file at a commit. */
const rawUrl = (repo, sha, path) => `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;

/**
 * The Markdown body of the pull request. `files` are the changed `docs/images/*.webp` paths, each
 * a string (changed) or `{ path, status }` with status `added`, `deleted` or `modified`: an added
 * picture has nothing before it and a deleted one nothing after it.
 */
export function pictureBody({ repo, base, head, files }) {
	const pictures = files
		.map((file) => (typeof file === 'string' ? { path: file, status: 'modified' } : file))
		.filter(({ path }) => path.startsWith(`${IMAGES}/`) && path.endsWith('.webp'))
		.sort((a, b) => a.path.localeCompare(b.path));
	const lines = [
		'The pictures of the README, made again from the current UI by `pnpm sweep:readme`. Each one that changed is below, before and after.',
	];
	for (const { path, status } of pictures) {
		const before =
			status === 'added' ? 'new' : `<img src="${rawUrl(repo, base, path)}" width="100%">`;
		const after =
			status === 'deleted' ? 'removed' : `<img src="${rawUrl(repo, head, path)}" width="100%">`;
		lines.push(
			'',
			`### ${basename(path, '.webp')}`,
			'',
			'| Before | After |',
			'| --- | --- |',
			`| ${before} | ${after} |`,
		);
	}
	return `${lines.join('\n')}\n`;
}

/** The pictures that differ between two commits, with how each changed. */
export function changedPictures(base, head) {
	const out = execFileSync(
		'git',
		['diff', '--name-status', '--no-renames', base, head, '--', IMAGES],
		{ encoding: 'utf8' },
	);
	const status = { A: 'added', D: 'deleted' };
	return out
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [letter = '', path = ''] = line.split('\t');
			return { path, status: status[letter] ?? 'modified' };
		});
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const [command, ...rest] = process.argv.slice(2);
	const option = (name) => {
		const at = rest.indexOf(`--${name}`);
		return at < 0 ? undefined : rest[at + 1];
	};
	const repo = option('repo');
	const base = option('base');
	const head = option('head');
	if (command !== 'body' || !repo || !base || !head) {
		console.error(
			'Usage: node scripts/readme-pictures.mjs body --repo <owner/name> --base <sha> --head <sha>',
		);
		process.exit(2);
	}
	process.stdout.write(pictureBody({ repo, base, head, files: changedPictures(base, head) }));
}
