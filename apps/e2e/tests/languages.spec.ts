import { ADMIN, api, expect, test } from '../support/fixtures.ts';
import { SETUP_CODE } from '../support/server.ts';

/** A tiny pack: a handful of keys; everything else falls back to English. */
const GERMAN = {
	manifest: {
		code: 'de',
		name: 'German',
		nativeName: 'Deutsch',
		version: '0.1.0',
		famos: '>=0.1.0',
	},
	catalogs: {
		app: {
			nav_more: 'Mehr',
			my_language: 'Meine Sprache',
			home_greeting_morning: 'Hallo',
			home_greeting_afternoon: 'Hallo',
			home_greeting_evening: 'Hallo',
			languages_title: 'Sprachen',
		},
	},
};

// This test sets the family up itself.
test.describe(() => {
	test.use({ freshFamily: true });

	test('choose Türkçe first, finish setup in Turkish, then add, use and remove a pack', async ({
		page,
	}) => {
		// First run: the language comes first, and the rest of setup continues in it.
		await page.goto(`/setup?code=${SETUP_CODE}`);
		await expect(page.getByRole('heading', { name: 'Choose your language' })).toBeVisible();
		await page.getByRole('radio', { name: /Türkçe/ }).click();
		await expect(page.getByRole('heading', { name: 'Dilini seç' })).toBeVisible();
		await page.getByRole('button', { name: 'Devam' }).click();
		await expect(page.getByRole('heading', { name: "FamilyOS'e hoş geldin" })).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
		await page.getByLabel('Adın').fill(ADMIN.name);
		await page.getByLabel('E-posta').fill(ADMIN.email);
		await page.getByLabel('Şifre').fill(ADMIN.password);
		await page.getByRole('button', { name: 'Hesap oluştur' }).click();
		await page.getByRole('button', { name: 'Atla' }).click();
		await expect(page.getByTestId('day-sentence')).toContainText(
			new RegExp(`^(Günaydın|İyi günler|İyi akşamlar), ${ADMIN.name}`),
		);

		// It is the family's language and the admin's own; the region format is the browser's own
		// (an en-US browser stays en-US whatever language the app speaks).
		const family = await api<{ locale: string; formatLocale: string }>(
			page,
			'GET',
			'/api/v1/core/settings/family',
		);
		expect(family.locale).toBe('tr');
		expect(family.formatLocale).toBe('en-US');

		// Settings → Languages: Turkish is included; add a German pack from a file.
		await page.goto('/settings/languages');
		await expect(page).toHaveURL(/\/settings\/region$/);
		await expect(page.getByRole('heading', { name: 'Dil ve bölge', level: 1 })).toBeVisible();
		await expect(page.getByTestId('language-tr')).toContainText('Birlikte gelir');
		await page.getByRole('button', { name: 'Dil ekle' }).click();
		await page.locator('#pack-file').setInputFiles({
			name: 'de.json',
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(GERMAN)),
		});
		await expect(page.getByText('Deutsch yüklendi')).toBeVisible();
		await expect(page.getByTestId('language-de')).toContainText('Yüklendi');

		// "My language" lists it; choosing it translates what the pack has, English fills the rest.
		await page.goto('/settings/profile');
		await page.getByLabel('Dilim').selectOption('de');
		await expect(page.getByLabel('Meine Sprache')).toBeVisible();
		await expect(page.getByText('Sign out', { exact: true })).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('lang', 'de');
		await page.goto('/');
		await expect(page.getByTestId('day-sentence')).toContainText(`Hallo, ${ADMIN.name}`);

		// Remove it: whoever used it falls back to the family's language.
		await page.goto('/settings/region');
		const german = page.getByTestId('language-de');
		await german.getByRole('button', { name: 'Remove' }).click();
		await german.getByRole('button', { name: 'Tap again to remove' }).click();
		await expect(page.getByTestId('language-de')).toHaveCount(0);
		await page.goto('/more');
		await expect(page.getByRole('heading', { name: 'Daha', level: 1 })).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
		const me = await api<{ locale: string | null }>(page, 'GET', '/api/v1/core/me');
		expect(me.locale).toBeNull();
	});
});
