import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import tr from '../messages/tr.json' with { type: 'json' };
import {
	connectionChanged,
	homeassistantManage,
	homeassistantPresence,
	homeassistantView,
	itemsChanged,
	peopleChanged,
} from './capabilities.ts';
import { check, checkJob, connect, disconnect, getConnection } from './connection.ts';
import { addItem, listItems, moveItem, removeItem, renameItem } from './items.ts';
import {
	getMySharing,
	getPresence,
	linkPerson,
	listPeople,
	setMySharing,
	unlinkPerson,
} from './people.ts';
import { migrations } from './store.ts';
import { getEntities, getPersons, getValues } from './values.ts';

/**
 * Home Assistant extension: the family's smart home, read-only. It connects with an address and a
 * long-lived access token (sealed, opened only to read) and never sends a request that
 * changes anything in Home Assistant. Who is home is shown only as each person chooses.
 */
export default defineExtension({
	manifest: pkg.famos,
	messages: { en, tr },
	migrations,
	actions: [
		connect,
		check,
		disconnect,
		addItem,
		renameItem,
		removeItem,
		moveItem,
		linkPerson,
		unlinkPerson,
		setMySharing,
	],
	jobs: [checkJob],
	routes: [
		getConnection,
		listItems,
		getValues,
		getEntities,
		getPersons,
		listPeople,
		getMySharing,
		getPresence,
	],
	events: [connectionChanged, itemsChanged, peopleChanged],
	capabilities: [homeassistantView, homeassistantPresence, homeassistantManage],
});
