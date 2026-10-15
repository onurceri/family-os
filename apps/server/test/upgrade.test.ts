import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { createSecretBox } from '@famos/adapters/secrets';
import { runMigrations } from '@famos/db';
import { createFakeHttp } from '@famos/testing';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

/**
 * A family that used the release before extensions were kept apart upgrades: the papers the
 * Inbox filed on a record still open from records, and a calendar subscription sealed with the
 * key all extensions shared still syncs, and is sealed again with the calendar's own key.
 */
let runtime: Runtime | undefined;
afterEach(async () => {
	await runtime?.close();
	runtime = undefined;
});

/** The migrations that release had: everything but what this change adds. */
const NEW_MIGRATIONS = new Set(['core/0004_file_grants']);

const FEED = 'https://school.example/cal/private.ics?key=SECRET';
const ICS = [
	'BEGIN:VCALENDAR',
	'VERSION:2.0',
	'BEGIN:VEVENT',
	'UID:open-day@school.example',
	'DTSTAMP:20261001T000000Z',
	'DTSTART;VALUE=DATE:20261120',
	'DTEND;VALUE=DATE:20261121',
	'SUMMARY:Open day',
	'END:VEVENT',
	'END:VCALENDAR',
	'',
].join('\r\n');

it('keeps filed papers and calendar subscriptions working after the upgrade', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-upgrade-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: 'http://localhost' });
	const http = createFakeHttp();
	http.serve(FEED, { text: ICS, contentType: 'text/calendar' });
	runtime = openRuntime(config, { extensions, logger: silentLogger, quiet: true, http });
	const { handle, kernel } = runtime;

	// The database as the previous release left it.
	const previous = kernel.migrationScopes.map(({ scope, migrations }) => ({
		scope,
		migrations: Object.fromEntries(
			Object.entries(migrations).filter(([name]) => !NEW_MIGRATIONS.has(`${scope}/${name}`)),
		),
	}));
	await runMigrations(handle.db, previous);
	const key = 'inbox/inbox_item_00000000-0000-7000-8000-000000000001/0';
	await mkdir(join(config.filesDir, 'inbox/inbox_item_00000000-0000-7000-8000-000000000001'), {
		recursive: true,
	});
	await writeFile(join(config.filesDir, key), 'policy');
	handle.sqlite
		.prepare(
			`insert into records_documents
			(id, record_id, record_kind, file_key, name, type, size, label, created_at, updated_at)
			values ('record_doc_00000000-0000-7000-8000-000000000001',
				'vehicle_00000000-0000-7000-8000-000000000001', 'vehicle', ?, 'policy.pdf',
				'application/pdf', 6, 'insurance', 1, 1)`,
		)
		.run(key);
	const sealed = createSecretBox(config.secret, 'extension-secrets').seal(FEED);
	handle.sqlite
		.prepare(
			`insert into calendar_subscriptions
			(id, name, sealed_url, url_host, color, member_ids, reminders, allow_local, created_at, updated_at)
			values ('cal_sub_00000000-0000-7000-8000-000000000001', 'School', ?, 'school.example',
				'#3366cc', '[]', 0, 0, 1, 1)`,
		)
		.run(sealed);

	// The upgrade: migrations, then the server starts.
	expect(await migrate(runtime)).toBeGreaterThan(0);
	await kernel.start();

	const route = kernel.registry.routes.find(
		(r) => r.route.operationId === 'records.getDocumentFile',
	);
	if (!route) throw new Error('records.getDocumentFile is missing');
	const file = (await route.route.handle(kernel.contextFor('records'), {
		params: { documentId: 'record_doc_00000000-0000-7000-8000-000000000001' },
		query: undefined,
		body: undefined,
		actor: { kind: 'system', source: 'test' },
		device: null,
		files: [],
	})) as { stream: AsyncIterable<Uint8Array>; filename: string };
	const chunks: Uint8Array[] = [];
	for await (const chunk of file.stream) chunks.push(chunk);
	expect(Buffer.concat(chunks).toString()).toBe('policy');
	expect(file.filename).toBe('policy.pdf');

	await kernel.contextFor('calendar').enqueue('calendar.refreshSubscription', {
		subscriptionId: 'cal_sub_00000000-0000-7000-8000-000000000001',
	});
	await kernel.worker.drain();
	expect(http.requests.map((r) => r.url)).toContain(FEED);
	const sub = handle.sqlite
		.prepare('select sealed_url, last_error, event_count from calendar_subscriptions')
		.get() as { sealed_url: string; last_error: string | null; event_count: number };
	expect(sub).toMatchObject({ last_error: null, event_count: 1 });
	const resealed = sub.sealed_url;
	expect(resealed.startsWith('v2.')).toBe(true);
	expect(kernel.contextFor('calendar').secrets.open(resealed)).toBe(FEED);
	expect(kernel.contextFor('ambient').secrets.open(resealed)).toBeNull();
});
