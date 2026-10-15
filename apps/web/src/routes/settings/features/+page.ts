import { redirect } from '@sveltejs/kit';

/** Features became Extensions: the switches are there, beside installing. */
export const load = ({ url }) => {
	redirect(307, `/settings/extensions${url.search}`);
};
