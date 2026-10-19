import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeDav } from '../support/fake-dav.ts';
import {
	ADMIN,
	api,
	expect,
	setUpAndSignIn,
	signInWithPassword,
	test,
} from '../support/fixtures.ts';

const today = () =>
	new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

const dayAfterTomorrow = () =>
	new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(
		new Date(Date.now() + 2 * 86_400_000),
	);

type Page = Parameters<typeof api>[0];

async function eventTitles(page: Page): Promise<string[]> {
	const res = await api<{ title: string }[] | { occurrences: { title: string }[] }>(
		page,
		'GET',
		`/api/v1/calendar/occurrences?from=${today()}&to=${dayAfterTomorrow()}`,
	);
	const list = Array.isArray(res) ? res : res.occurrences;
	return list.map((o) => o.title);
}

async function addEvent(page: Page, title: string) {
	await api(page, 'POST', '/api/v1/actions/calendar.createEvent', {
		title,
		allDay: true,
		date: today(),
	});
}

test('an encrypted backup restores with its passphrase; a wrong passphrase or a damaged file fails and leaves the data alone', async ({
	page,
	family,
}) => {
	// The upload runs as a background job; under a loaded machine it can take a while.
	test.setTimeout(150_000);
	const dav = await startFakeDav();
	const passphrase = 'purple elephant sunrise';
	try {
		await setUpAndSignIn(page);
		await addEvent(page, 'Parents evening');

		await page.goto('/settings/backups');
		// Lock the copies in three steps: why, choose a passphrase, done.
		await page.getByTestId('encryption-row').click();
		const steps = page.getByTestId('encryption-steps');
		await steps.getByRole('button', { name: 'Next' }).click();
		await steps.getByLabel('Passphrase', { exact: true }).fill(passphrase);
		await steps.getByLabel('Type it again').fill(passphrase);
		await steps.getByLabel('I have written the passphrase down').check();
		await steps.getByRole('button', { name: 'Save passphrase' }).click();
		await expect(steps.getByText('To bring a backup back you need:')).toBeVisible();
		await steps.getByRole('button', { name: 'Close' }).click();
		await expect(
			page.getByText('Copies are locked with a passphrase before they leave.'),
		).toBeVisible();
		await page.getByRole('button', { name: 'Add a copy' }).click();
		await page.getByLabel('Name', { exact: true }).fill('Home Nextcloud');
		await page.getByLabel('Folder address').fill(dav.url);
		await page.getByLabel('User name').fill('anna');
		await page.getByLabel('App password').fill('app-password-123');
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		const target = page.getByTestId('backup-target');
		await expect(target.getByText('Home Nextcloud')).toBeVisible();
		await page.getByRole('button', { name: 'Back up now' }).click();
		await expect(target.getByText(/^Last copy /)).toBeVisible({ timeout: 100_000 });
		const [name] = [...dav.files.keys()];
		const bytes = dav.files.get(name ?? '') ?? Buffer.alloc(0);
		expect(bytes.length).toBeGreaterThan(200);

		const dir = await mkdtemp(join(tmpdir(), 'famos-e2e-restore-'));
		const encrypted = join(dir, name ?? 'backup.tar.age');
		await writeFile(encrypted, bytes);
		const damaged = join(dir, 'damaged.tar.age');
		await writeFile(damaged, bytes.subarray(0, 200));
		const notABackup = join(dir, 'garbage.tar');
		await writeFile(notABackup, 'this is not a backup');

		await addEvent(page, 'Added after the backup');
		await family.stop();
		const before = (await readdir(family.dataDir)).sort();

		// Failures: a message, a failing exit code, and nothing restored or set aside.
		const wrong = await family.cli(['restore', encrypted], {
			FAMOS_BACKUP_PASSPHRASE: 'not the passphrase',
		});
		expect(wrong.code).not.toBe(0);
		expect(wrong.output.length).toBeGreaterThan(0);
		const cut = await family.cli(['restore', damaged], { FAMOS_BACKUP_PASSPHRASE: passphrase });
		expect(cut.code).not.toBe(0);
		const garbage = await family.cli(['restore', notABackup]);
		expect(garbage.code).not.toBe(0);
		const missing = await family.cli(['restore', encrypted], { FAMOS_BACKUP_PASSPHRASE: '' });
		expect(missing.code).not.toBe(0);
		expect(missing.output).toContain('encrypted');
		const after = (await readdir(family.dataDir)).sort();
		expect(after.filter((n) => n.includes('pre-restore'))).toEqual([]);
		expect(after).toEqual(before);

		// The data is untouched.
		await family.start();
		await page.goto('/');
		expect(await eventTitles(page)).toEqual(
			expect.arrayContaining(['Parents evening', 'Added after the backup']),
		);

		// The right passphrase brings the backup back.
		await family.stop();
		const ok = await family.cli(['restore', encrypted], { FAMOS_BACKUP_PASSPHRASE: passphrase });
		expect(ok.code, ok.output).toBe(0);
		// The temporary decrypted copy is cleaned up.
		expect((await readdir(family.dataDir)).filter((n) => n.startsWith('.restore-'))).toEqual([]);
		await family.start();
		// A restore signs everyone out: the browser's old session is gone, so Deniz signs in again.
		await page.goto('/');
		expect((await page.request.get(`${new URL(page.url()).origin}/api/v1/core/me`)).status()).toBe(
			401,
		);
		await signInWithPassword(page, ADMIN.email, ADMIN.password);
		await expect(page.getByTestId('day-sentence')).toBeVisible();
		const titles = await eventTitles(page);
		expect(titles).toContain('Parents evening');
		expect(titles).not.toContain('Added after the backup');
	} finally {
		await dav.close();
	}
});
