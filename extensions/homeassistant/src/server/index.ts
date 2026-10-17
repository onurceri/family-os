import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import tr from '../messages/tr.json' with { type: 'json' };
import { connectionChanged, homeassistantManage, homeassistantView } from './capabilities.ts';
import { check, checkJob, connect, disconnect, getConnection } from './connection.ts';
import { migrations } from './store.ts';

/**
 * Home Assistant extension: the family's smart home, read-only. It connects with an address and a
 * long-lived access token (sealed, opened only by the check job) and never sends a request that
 * changes anything in Home Assistant.
 */
export default defineExtension({
	manifest: pkg.famos,
	messages: { en, tr },
	migrations,
	actions: [connect, check, disconnect],
	jobs: [checkJob],
	routes: [getConnection],
	events: [connectionChanged],
	capabilities: [homeassistantView, homeassistantManage],
});
