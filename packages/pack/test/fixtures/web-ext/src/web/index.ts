// The web entry of the web-build test: a page loaded when opened, and a helper of its own.
import { greeting } from './greeting.js';

export default {
	id: 'garden',
	greeting,
	page: () => import('./GardenPage.svelte'),
};
