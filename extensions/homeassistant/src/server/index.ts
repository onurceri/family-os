import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import tr from '../messages/tr.json' with { type: 'json' };
import {
	connectionChanged,
	homeassistantControl,
	homeassistantManage,
	homeassistantPresence,
	homeassistantView,
	itemsChanged,
	peopleChanged,
	switchFailed,
	valuesChanged,
} from './capabilities.ts';
import {
	check,
	checkJob,
	connect,
	disconnect,
	getConnection,
	testConnection,
} from './connection.ts';
import { addItem, listItems, moveItem, removeItem, renameItem, setItemControl } from './items.ts';
import {
	getMySharing,
	getPresence,
	linkPerson,
	listPeople,
	setMySharing,
	unlinkPerson,
} from './people.ts';
import { migrations } from './store.ts';
import { switchItem, switchJob } from './switch.ts';
import { getEntities, getPersons, getValues } from './values.ts';

/**
 * Home Assistant extension: the family's smart home, shown in FamilyOS. It connects with an
 * address and a long-lived access token (sealed) and reads what the family chose to show. It
 * switches only the items the family allowed, for the people allowed to, and only through the
 * services of `CONTROLS`; displays and the AI never switch anything. Who is home is shown only as
 * each person chooses.
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
		setItemControl,
		switchItem,
		linkPerson,
		unlinkPerson,
		setMySharing,
	],
	jobs: [checkJob, switchJob],
	routes: [
		getConnection,
		testConnection,
		listItems,
		getValues,
		getEntities,
		getPersons,
		listPeople,
		getMySharing,
		getPresence,
	],
	events: [connectionChanged, itemsChanged, peopleChanged, valuesChanged, switchFailed],
	capabilities: [
		homeassistantView,
		homeassistantPresence,
		homeassistantControl,
		homeassistantManage,
	],
});
