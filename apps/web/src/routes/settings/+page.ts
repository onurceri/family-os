import { redirect } from '@sveltejs/kit';

/**
 * Settings has no page of its own. Wide windows open its first page (Profile & sign-in), which
 * is open to everyone whatever their role; narrower ones get More, where the settings are grouped.
 */
export const load = () => {
	const wide = typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;
	redirect(307, wide ? '/settings/profile' : '/more');
};
