import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Runs the release scripts in a scratch repository whose history starts at one commit. */
describe('release in a fresh repository', () => {
	let repo: string;
	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_AUTHOR_NAME: 'Test',
		GIT_AUTHOR_EMAIL: 'test@example.com',
		GIT_COMMITTER_NAME: 'Test',
		GIT_COMMITTER_EMAIL: 'test@example.com',
	};
	const git = (...args: string[]) =>
		execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
	const node = (...args: string[]) =>
		execFileSync('node', args, { cwd: repo, env, encoding: 'utf8' });
	const commit = (message: string) => {
		writeFileSync(join(repo, 'change.txt'), message);
		git('add', '.');
		git('commit', '-q', '-m', message);
	};

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), 'famos-release-'));
		for (const dir of ['scripts', 'apps/server', 'apps/web'])
			mkdirSync(join(repo, dir), { recursive: true });
		for (const script of ['release.mjs', 'release-notes.mjs'])
			copyFileSync(join(import.meta.dirname, script), join(repo, 'scripts', script));
		for (const app of ['server', 'web'])
			writeFileSync(
				join(repo, 'apps', app, 'package.json'),
				`{\n\t"name": "${app}",\n\t"version": "0.0.0"\n}\n`,
			);
		git('init', '-q', '-b', 'main');
		git('add', '.');
		git('commit', '-q', '-m', 'Initial commit');
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	it('tags the first release and says so in its notes', () => {
		const out = node('scripts/release.mjs', '0.1.0');
		expect(git('tag', '--list')).toBe('v0.1.0');
		expect(git('log', '--format=%s')).toBe('chore(release): 0.1.0\nInitial commit');
		expect(JSON.parse(readFileSync(join(repo, 'apps/web/package.json'), 'utf8')).version).toBe(
			'0.1.0',
		);
		expect(out).toContain('First release.');
		expect(out).not.toContain('Maintenance only');

		// What the release workflow runs on the tagged commit.
		const notes = node('scripts/release-notes.mjs', '0.1.0');
		expect(notes).toMatch(/^## 0\.1\.0 \(\d{4}-\d{2}-\d{2}\)\n\nFirst release\.\n$/);
	});

	describe('with extensions', () => {
		const manifest = (id: string, version: string) =>
			`{\n\t"name": "@famos/ext-${id}",\n\t"version": "${version}",\n\t"private": true,\n\t"famos": {\n\t\t"id": "${id}",\n\t\t"dependsOn": [\n\t\t\t"records"\n\t\t],\n\t\t"version": "${version}",\n\t\t"sdk": "^0.5.0"\n\t},\n\t"dependencies": {\n\t\t"zod": "4.6.5"\n\t}\n}\n`;
		const read = (id: string) => readFileSync(join(repo, 'extensions', id, 'package.json'), 'utf8');

		beforeEach(() => {
			writeFileSync(
				join(repo, 'extensions.json'),
				JSON.stringify({
					always: ['calendar'],
					offered: ['pets'],
					default: [],
					independent: ['garden'],
				}),
			);
			for (const id of ['calendar', 'pets', 'garden']) {
				mkdirSync(join(repo, 'extensions', id), { recursive: true });
				writeFileSync(join(repo, 'extensions', id, 'package.json'), manifest(id, '0.0.3'));
			}
			git('add', '.');
			git('commit', '-q', '-m', 'chore: extensions');
		});

		it('gives the shipped ones the product version, and leaves an independent one alone', () => {
			node('scripts/release.mjs', '0.2.0');
			// Only the two version lines change; the rest of the file is as it was.
			expect(read('calendar')).toBe(manifest('calendar', '0.2.0'));
			expect(read('pets')).toBe(manifest('pets', '0.2.0'));
			expect(read('garden')).toBe(manifest('garden', '0.0.3'));
			expect(git('status', '--porcelain')).toBe('');
			expect(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
				'apps/server/package.json',
				'apps/web/package.json',
				'extensions/calendar/package.json',
				'extensions/pets/package.json',
			]);
		});

		it('leaves them at their version for a pre-release', () => {
			node('scripts/release.mjs', '1.0.0-rc.1');
			expect(read('calendar')).toBe(manifest('calendar', '0.0.3'));
			expect(JSON.parse(readFileSync(join(repo, 'apps/server/package.json'), 'utf8')).version).toBe(
				'1.0.0-rc.1',
			);
		});
	});

	it('takes the next release from the previous tag', () => {
		node('scripts/release.mjs', '0.1.0');
		commit('feat(lists): shopping categories');
		commit('docs: guide');
		const out = node('scripts/release.mjs', '0.2.0');
		expect(out).toContain('### New\n\n- **lists:** shopping categories\n');
		expect(out).not.toContain('First release.');
		expect(git('tag', '--list')).toBe('v0.1.0\nv0.2.0');
	});
});
