import { describe, expect, it } from 'vitest';
import { createI18n } from '../src/index.ts';

describe('nested translations', () => {
	it('lets a notice name an action by its key and add what it is about', () => {
		const i18n = createI18n({
			locale: 'en',
			defaultNS: 'app',
			resources: {
				en: {
					app: { named: '$t({{what}}): {{name}}' },
					lists: { remove: 'Remove a shopping item' },
				},
			},
		});
		expect(i18n.t('app:named', { what: 'lists:remove', name: 'Cheddar' })).toBe(
			'Remove a shopping item: Cheddar',
		);
	});
});
