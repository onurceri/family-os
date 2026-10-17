import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import tr from '../messages/tr.json' with { type: 'json' };
import { homeEdit, homeView } from './capabilities.ts';
import { aiContext, aiContextItems } from './context.ts';
import { addHome, archiveHome, getHome, listHomes, updateHome } from './homes.ts';
import { addItem, archiveItem, getItem, listItems, updateItem } from './items.ts';
import { searchIndex } from './search.ts';
import { addService, archiveService, getService, listServices, updateService } from './services.ts';
import { homeChanged } from './shared.ts';
import { migrations } from './store.ts';
import { itemKind } from './understand.ts';

/**
 * Home: the household's homes, the things in them with their warranties, the utilities and
 * subscriptions they pay for. Duties (insurance, boiler
 * service, a warranty ending…) and papers (receipts, policies) are kept by `records`, reached
 * only through its actions; the AI learns which homes and things exist through
 * `home.aiContext` and `home.aiContextItems`. Services are not shown to it.
 */
export default defineExtension({
	manifest: pkg.famos,
	messages: { en, tr },
	migrations,
	ai: { context: [aiContext.id, aiContextItems.id], index: searchIndex, kinds: [itemKind] },
	actions: [
		addHome,
		updateHome,
		archiveHome,
		addItem,
		updateItem,
		archiveItem,
		addService,
		updateService,
		archiveService,
		aiContext,
		aiContextItems,
	],
	routes: [listHomes, getHome, listItems, getItem, listServices, getService],
	events: [homeChanged],
	capabilities: [homeView, homeEdit],
});
