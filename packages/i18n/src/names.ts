// Names and reading directions of languages, from Intl alone. Kept apart from the i18next
// runtime so code that only needs a name (an extension's server bundle) does not carry it.

/** The language's name in English, as "Answer in Turkish" prompts and lists need it. */
export function languageName(code: string): string {
	try {
		return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
	} catch {
		return code;
	}
}

/** Reading direction of a language, from `Intl.Locale` text info (left to right when unknown). */
export function textDirection(code: string): 'ltr' | 'rtl' {
	try {
		const locale = new Intl.Locale(code) as Intl.Locale & {
			getTextInfo?: () => { direction: string };
			textInfo?: { direction: string };
		};
		const direction = (locale.getTextInfo?.() ?? locale.textInfo)?.direction;
		return direction === 'rtl' ? 'rtl' : 'ltr';
	} catch {
		return 'ltr';
	}
}
