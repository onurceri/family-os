import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import tr from '../messages/tr.json' with { type: 'json' };
import { vehiclesEdit, vehiclesView } from './capabilities.ts';
import { vehiclesDigest } from './digest.ts';
import { migrations } from './store.ts';
import { logKind } from './understand.ts';
import {
	addLog,
	addVehicle,
	aiContext,
	archiveVehicle,
	getVehicle,
	listLogs,
	listVehicles,
	removeLog,
	updateVehicle,
	vehicleChanged,
} from './vehicles.ts';

/**
 * Vehicles: the household's cars with a service and repair log. Their duties (insurance,
 * inspection, tax…) and papers are kept by `records`, reached only through its actions.
 * The AI learns which vehicles exist through `vehicles.aiContext`.
 */
export default defineExtension({
	manifest: pkg.famos,
	messages: { en, tr },
	migrations,
	ai: { context: aiContext.id, kinds: [logKind] },
	actions: [
		addVehicle,
		updateVehicle,
		archiveVehicle,
		addLog,
		removeLog,
		aiContext,
		vehiclesDigest,
	],
	routes: [listVehicles, getVehicle, listLogs],
	events: [vehicleChanged],
	capabilities: [vehiclesView, vehiclesEdit],
});
