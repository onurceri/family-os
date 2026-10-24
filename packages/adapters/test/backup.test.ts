import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { openDatabase, runMigrations } from '@famos/db';
import type { Logger } from '@famos/sdk';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptStream } from '../src/backup/encryption.ts';
import {
	type BackupService,
	BackupTargetError,
	backupMigrations,
	createBackupJobs,
	createBackupService,
	createS3Target,
	createWebDavTarget,
	DecryptError,
	decryptFile,
	enqueueUploads,
	isRecipient,
	PART_SIZE,
} from '../src/backup/index.ts';
import { uuidv7Ids } from '../src/runtime/index.ts';
import { createSecretBox } from '../src/secrets/index.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const stream = (bytes: Uint8Array) =>
	Readable.toWeb(Readable.from([Buffer.from(bytes)])) as ReadableStream<Uint8Array>;
const NAME = 'famos-2026-10-07T03-00-00-000Z-scheduled.tar';
const NAME2 = 'famos-2026-10-08T03-00-00-000Z-scheduled.tar';
const NAME3 = 'famos-2026-10-09T03-00-00-000Z-scheduled.tar';

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'famos-backup-test-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/* ───────────── stand-in servers ───────────── */

interface Req {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
	body: Buffer;
}

async function listen(handler: (req: Req, res: http.ServerResponse) => void) {
	const requests: Req[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			const seen = {
				method: req.method ?? '',
				url: req.url ?? '',
				headers: req.headers,
				body: Buffer.concat(chunks),
			};
			requests.push(seen);
			handler(seen, res);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		requests,
		origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** A tiny S3: objects, multipart uploads, ListObjectsV2. `failPart` makes that part number fail. */
function fakeS3() {
	const objects = new Map<string, Buffer>();
	const uploads = new Map<string, Map<number, Buffer>>();
	const state = { failPart: 0, aborted: 0, status: 0 };
	const handler = (req: Req, res: http.ServerResponse) => {
		if (state.status)
			return void res.writeHead(state.status).end('<Error><Code>Denied</Code></Error>');
		const url = new URL(req.url, 'http://x');
		const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ''));
		const uploadId = url.searchParams.get('uploadId');
		if (req.method === 'POST' && url.searchParams.has('uploads'))
			return void res.end(
				'<InitiateMultipartUploadResult><UploadId>up1</UploadId></InitiateMultipartUploadResult>',
			);
		if (req.method === 'PUT' && uploadId) {
			const n = Number(url.searchParams.get('partNumber'));
			if (n === state.failPart) return void res.writeHead(500).end();
			const parts = uploads.get(uploadId) ?? new Map();
			parts.set(n, req.body);
			uploads.set(uploadId, parts);
			return void res.writeHead(200, { etag: `"etag-${n}"` }).end();
		}
		if (req.method === 'POST' && uploadId) {
			const order = [...req.body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) =>
				Number(m[1]),
			);
			const parts = uploads.get(uploadId);
			objects.set(key, Buffer.concat(order.map((n) => parts?.get(n) ?? Buffer.alloc(0))));
			return void res.end('<CompleteMultipartUploadResult/>');
		}
		if (req.method === 'DELETE' && uploadId) {
			state.aborted++;
			uploads.delete(uploadId);
			return void res.writeHead(204).end();
		}
		if (req.method === 'PUT') {
			objects.set(key, req.body);
			return void res.writeHead(200).end();
		}
		if (req.method === 'DELETE') {
			objects.delete(key);
			return void res.writeHead(204).end();
		}
		if (req.method === 'GET') {
			const prefix = url.searchParams.get('prefix') ?? '';
			const body = [...objects]
				.filter(([k]) => k.startsWith(prefix))
				.map(
					([k, v]) =>
						`<Contents><Key>${k}</Key><Size>${v.length}</Size><LastModified>2026-10-07T03:00:00.000Z</LastModified></Contents>`,
				)
				.join('');
			return void res.end(
				`<ListBucketResult><IsTruncated>false</IsTruncated>${body}</ListBucketResult>`,
			);
		}
		res.writeHead(400).end();
	};
	return { objects, uploads, state, handler };
}

/** A tiny WebDAV folder at /dav/. */
function fakeDav() {
	const files = new Map<string, Buffer>();
	const state = { folder: false, status: 0 };
	const handler = (req: Req, res: http.ServerResponse) => {
		if (state.status) return void res.writeHead(state.status).end();
		const path = decodeURIComponent(req.url.replace(/^\/dav\/?/, ''));
		if (req.method === 'MKCOL') {
			const existed = state.folder;
			state.folder = true;
			return void res.writeHead(existed ? 405 : 201).end();
		}
		if (req.method === 'PUT') {
			files.set(path, req.body);
			return void res.writeHead(201).end();
		}
		if (req.method === 'DELETE') {
			files.delete(path);
			return void res.writeHead(204).end();
		}
		if (req.method === 'PROPFIND') {
			const entries = [...files]
				.map(
					([n, v]) =>
						`<d:response><d:href>/dav/${encodeURIComponent(n)}</d:href><d:propstat><d:prop><d:getcontentlength>${v.length}</d:getcontentlength><d:getlastmodified>Wed, 07 Oct 2026 03:00:00 GMT</d:getlastmodified><d:resourcetype/></d:prop></d:propstat></d:response>`,
				)
				.join('');
			return void res
				.writeHead(207, { 'content-type': 'application/xml' })
				.end(
					`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>${entries}</d:multistatus>`,
				);
		}
		res.writeHead(400).end();
	};
	return { files, state, handler };
}

/* ───────────── encryption ───────────── */

describe('age encryption', () => {
	const plain = randomBytes(300_000);

	async function encryptToFile(
		enc: Parameters<typeof encryptStream>[2],
		out: string,
	): Promise<number> {
		const { stream: s, size } = await encryptStream(stream(plain), plain.length, enc, 10);
		const bytes = Buffer.from(await new Response(s).arrayBuffer());
		await writeFile(out, bytes);
		expect(bytes.length).toBe(size);
		return size;
	}

	it('round-trips with a passphrase and reports the exact size up front', async () => {
		const file = join(dir, 'p.tar.age');
		await encryptToFile({ mode: 'passphrase', passphrase: 'correct horse battery' }, file);
		expect((await readFile(file)).subarray(0, 21).toString()).toBe('age-encryption.org/v1');
		const out = join(dir, 'p.tar');
		await decryptFile({ input: file, output: out, passphrase: 'correct horse battery' });
		expect(sha(await readFile(out))).toBe(sha(plain));
	});

	it('fails cleanly with the wrong passphrase', async () => {
		const file = join(dir, 'w.tar.age');
		await encryptToFile({ mode: 'passphrase', passphrase: 'correct horse battery' }, file);
		await expect(
			decryptFile({ input: file, output: join(dir, 'w.tar'), passphrase: 'wrong wrong wrong' }),
		).rejects.toBeInstanceOf(DecryptError);
	});

	it('round-trips with a recipient key, which needs no secret on the server', async () => {
		const identity = await generateX25519Identity();
		const recipient = await identityToRecipient(identity);
		expect(await isRecipient(recipient)).toBe(true);
		expect(await isRecipient('age1notakey')).toBe(false);
		expect(await isRecipient('hunter2 hunter2')).toBe(false);
		const file = join(dir, 'r.tar.age');
		await encryptToFile({ mode: 'recipient', recipient }, file);
		const out = join(dir, 'r.tar');
		await decryptFile({ input: file, output: out, identity });
		expect(sha(await readFile(out))).toBe(sha(plain));
		const other = await generateX25519Identity();
		await expect(
			decryptFile({ input: file, output: join(dir, 'r2.tar'), identity: other }),
		).rejects.toBeInstanceOf(DecryptError);
	});
});

/* ───────────── S3 ───────────── */

const S3_CONFIG = {
	region: 'eu-central-1',
	bucket: 'bucket',
	prefix: 'family',
	accessKeyId: 'AKIDEXAMPLE',
	secretAccessKey: 'super-secret-key',
	pathStyle: true,
};

describe('S3 target', () => {
	let s3: ReturnType<typeof fakeS3>;
	let server: Awaited<ReturnType<typeof listen>>;
	beforeEach(async () => {
		s3 = fakeS3();
		server = await listen(s3.handler);
		return () => server.close();
	});
	const target = () => createS3Target({ ...S3_CONFIG, endpoint: server.origin });

	it('sends a small backup with one signed PUT', async () => {
		const data = randomBytes(1000);
		await target().put(NAME, stream(data), data.length);
		expect(server.requests).toHaveLength(1);
		const [req] = server.requests;
		expect(req?.method).toBe('PUT');
		expect(req?.url).toBe(`/bucket/family/${NAME}`);
		expect(req?.headers.authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/s3\/aws4_request/,
		);
		expect(req?.headers['x-amz-content-sha256']).toBe(sha(data));
		expect(s3.objects.get(`family/${NAME}`)?.equals(data)).toBe(true);
	});

	it('uploads a large backup in 8 MiB parts and completes it', async () => {
		const data = randomBytes(PART_SIZE * 2 + 1234);
		await target().put(NAME, stream(data));
		const parts = server.requests.filter((r) => r.method === 'PUT');
		expect(parts.map((p) => p.body.length)).toEqual([PART_SIZE, PART_SIZE, 1234]);
		expect(parts.map((p) => new URL(p.url, 'http://x').searchParams.get('partNumber'))).toEqual([
			'1',
			'2',
			'3',
		]);
		const complete = server.requests.at(-1);
		expect(complete?.method).toBe('POST');
		expect(complete?.body.toString()).toContain(
			'<PartNumber>3</PartNumber><ETag>&quot;etag-3&quot;</ETag>',
		);
		expect(sha(s3.objects.get(`family/${NAME}`) ?? Buffer.alloc(0))).toBe(sha(data));
	});

	it('aborts the multipart upload when a part fails', async () => {
		s3.state.failPart = 2;
		const data = randomBytes(PART_SIZE * 2 + 10);
		await expect(target().put(NAME, stream(data))).rejects.toMatchObject({
			code: 'http_500',
			retryable: true,
		});
		expect(s3.state.aborted).toBe(1);
		expect(s3.objects.size).toBe(0);
	});

	it('lists only our files under the prefix, deletes, and tests with a probe', async () => {
		s3.objects.set(`family/${NAME}`, Buffer.from('a'));
		s3.objects.set(`family/${NAME2}.age`, Buffer.from('bb'));
		s3.objects.set('family/notes.txt', Buffer.from('x'));
		s3.objects.set(`other/${NAME}`, Buffer.from('x'));
		const t = target();
		const names = (await t.list()).map((f) => f.name).sort();
		expect(names).toEqual([NAME, `${NAME2}.age`]);
		await t.delete(NAME);
		expect(s3.objects.has(`family/${NAME}`)).toBe(false);
		await t.test();
		expect([...s3.objects.keys()].some((k) => k.includes('probe'))).toBe(false);
	});

	it('maps refusals to non-retryable codes and unreachable servers to retryable ones', async () => {
		s3.state.status = 403;
		await expect(target().test()).rejects.toMatchObject({ code: 'http_403', retryable: false });
		await server.close();
		const err = await target()
			.test()
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BackupTargetError);
		expect(err).toMatchObject({ code: 'unreachable', retryable: true });
	});
});

/* ───────────── WebDAV ───────────── */

describe('WebDAV target', () => {
	let dav: ReturnType<typeof fakeDav>;
	let server: Awaited<ReturnType<typeof listen>>;
	beforeEach(async () => {
		dav = fakeDav();
		server = await listen(dav.handler);
		return () => server.close();
	});
	const target = () =>
		createWebDavTarget({ url: `${server.origin}/dav`, username: 'anna', password: 'app-password' });

	it('creates the folder (tolerating "exists") and streams the file with its length', async () => {
		const t = target();
		const data = randomBytes(200_000);
		await t.put(NAME, stream(data), data.length);
		await t.put(NAME2, stream(data), data.length);
		const mkcols = server.requests.filter((r) => r.method === 'MKCOL');
		expect(mkcols).toHaveLength(2);
		const put = server.requests.find((r) => r.method === 'PUT');
		expect(put?.headers['content-length']).toBe(String(data.length));
		expect(put?.headers.authorization).toBe(
			`Basic ${Buffer.from('anna:app-password').toString('base64')}`,
		);
		expect(dav.files.get(NAME)?.equals(data)).toBe(true);
	});

	it('lists with PROPFIND depth 1, ignoring the folder and foreign files', async () => {
		dav.files.set(NAME, Buffer.from('abc'));
		dav.files.set(`${NAME2}.age`, Buffer.from('abcd'));
		dav.files.set('photo.jpg', Buffer.from('z'));
		const files = await target().list();
		expect(server.requests[0]?.headers.depth).toBe('1');
		expect(files.map((f) => [f.name, f.size]).sort()).toEqual([
			[NAME, 3],
			[`${NAME2}.age`, 4],
		]);
		expect(files[0]?.modifiedAt).toBe(Date.UTC(2026, 9, 7, 3));
		await target().delete(NAME);
		expect(dav.files.has(NAME)).toBe(false);
	});

	it('tests with a probe and reports a wrong password without retrying', async () => {
		await target().test();
		expect([...dav.files.keys()]).toEqual([]);
		dav.state.status = 401;
		await expect(target().test()).rejects.toMatchObject({ code: 'http_401', retryable: false });
	});
});

/* ───────────── service and jobs ───────────── */

describe('backup service and upload job', () => {
	let db: ReturnType<typeof openDatabase>['db'];
	let service: BackupService;
	let logs: string[];
	let dav: ReturnType<typeof fakeDav>;
	let server: Awaited<ReturnType<typeof listen>>;
	let backups: string;

	const logger = (): Logger => {
		const write = (o: object, m?: string) => logs.push(JSON.stringify({ o, m }));
		const l: Logger = { debug: write, info: write, warn: write, error: write, child: () => l };
		return l;
	};
	const now = Date.UTC(2026, 9, 7, 3);

	beforeEach(async () => {
		logs = [];
		({ db } = openDatabase({ path: ':memory:' }));
		await runMigrations(db, [{ scope: 'backup', migrations: backupMigrations }]);
		service = createBackupService({
			db,
			box: createSecretBox('s'.repeat(32), 'backup'),
			clock: { now: () => now },
			ids: uuidv7Ids,
			logger: logger(),
			scryptWorkFactor: 10,
		});
		dav = fakeDav();
		server = await listen(dav.handler);
		backups = await mkdtemp(join(dir, 'b-'));
		for (const n of [NAME, NAME2, NAME3]) await writeFile(join(backups, n), randomBytes(5000));
		return () => server.close();
	});

	const addTarget = (keep = 7) =>
		service.createTarget({
			kind: 'webdav',
			name: 'Nextcloud',
			keep,
			config: { url: `${server.origin}/dav`, username: 'anna', password: 'app-password-123' },
		});

	function jobs() {
		const notes: {
			kind: string;
			dedupeKey?: string;
			body?: { params?: Record<string, unknown> };
		}[] = [];
		const enqueued: { job: string; payload: unknown; dedupeKey?: string }[] = [];
		const ctx = {
			logger: logger(),
			notify: async (r: (typeof notes)[number]) => void notes.push(r),
			enqueue: async (job: string, payload: unknown, o?: { dedupeKey?: string }) => {
				enqueued.push({ job, payload, ...(o?.dedupeKey && { dedupeKey: o.dedupeKey }) });
				return 'job';
			},
		};
		const [upload] = createBackupJobs({
			service,
			backupsDir: backups,
			createLocalBackup: async () => ({ name: NAME }),
		});
		const attempt = (targetId: string, n: number, name = NAME) =>
			upload?.handle(
				// biome-ignore lint/suspicious/noExplicitAny: a partial job context is enough here.
				ctx as any,
				{ targetId, name },
				{ id: 'j', attempt: n, maxAttempts: 3, signal: new AbortController().signal },
			);
		return { ctx, notes, enqueued, attempt };
	}

	it('uploads nothing until the admin has chosen how to encrypt', async () => {
		const t = await addTarget();
		const j = jobs();
		await j.attempt(t.id, 1);
		expect(dav.files.size).toBe(0);
		const [status] = await service.listTargets();
		expect(status?.lastResult).toBe('encryption_unset');
		expect(j.notes).toHaveLength(1);
	});

	it('uploads an encrypted copy that the passphrase opens, and never leaks secrets', async () => {
		await service.setEncryption({ mode: 'passphrase', passphrase: 'twelve chars passphrase' });
		const t = await addTarget();
		await jobs().attempt(t.id, 1);
		expect([...dav.files.keys()]).toEqual([`${NAME}.age`]);
		const remote = join(dir, 'remote.tar.age');
		await writeFile(remote, dav.files.get(`${NAME}.age`) ?? '');
		const out = join(dir, 'remote.tar');
		await decryptFile({ input: remote, output: out, passphrase: 'twelve chars passphrase' });
		expect(sha(await readFile(out))).toBe(sha(await readFile(join(backups, NAME))));

		const [status] = await service.listTargets();
		expect(status).toMatchObject({ lastResult: 'ok', enabled: true });
		expect(status?.lastSize).toBe(dav.files.get(`${NAME}.age`)?.length);
		const everything = JSON.stringify([
			await service.listTargets(),
			await service.encryptionStatus(),
			logs,
		]);
		for (const secret of ['app-password-123', 'twelve chars passphrase'])
			expect(everything).not.toContain(secret);
		// At rest the credentials are sealed.
		const row = await db
			.withTables<{
				backup_targets: { config: string };
				backup_settings: { sealed_passphrase: string };
			}>()
			.selectFrom('backup_targets')
			.select('config')
			.executeTakeFirstOrThrow();
		expect(row.config.startsWith('v1.')).toBe(true);
	});

	it('uploads in the clear only when encryption was switched off on purpose', async () => {
		await service.setEncryption({ mode: 'none' });
		const t = await addTarget();
		await jobs().attempt(t.id, 1);
		expect([...dav.files.keys()]).toEqual([NAME]);
	});

	it('encrypts to a recipient key without storing any secret', async () => {
		const identity = await generateX25519Identity();
		const recipient = await identityToRecipient(identity);
		await service.setEncryption({ mode: 'recipient', recipient });
		await expect(
			service.setEncryption({ mode: 'recipient', recipient: 'age1nope-not-a-key' }),
		).rejects.toMatchObject({ code: 'bad_request' });
		expect(await service.encryptionStatus()).toEqual({ mode: 'recipient', recipient });
		const t = await addTarget();
		await jobs().attempt(t.id, 1);
		const remote = join(dir, 'rr.tar.age');
		await writeFile(remote, dav.files.get(`${NAME}.age`) ?? '');
		await decryptFile({ input: remote, output: join(dir, 'rr.tar'), identity });
	});

	it('retries with backoff and tells the admins once, after the last attempt', async () => {
		await service.setEncryption({ mode: 'none' });
		const t = await addTarget();
		const j = jobs();
		dav.state.status = 503;
		await expect(j.attempt(t.id, 1)).rejects.toMatchObject({ code: 'http_503' });
		await expect(j.attempt(t.id, 2)).rejects.toMatchObject({ code: 'http_503' });
		expect(j.notes).toHaveLength(0);
		expect((await service.listTargets())[0]?.lastResult).toBe('retrying_http_503');
		await expect(j.attempt(t.id, 3)).rejects.toMatchObject({ code: 'http_503' });
		expect(j.notes).toHaveLength(1);
		expect(j.notes[0]).toMatchObject({
			kind: 'core.backupFailed',
			to: { capability: 'core.settings.manage' },
			dedupeKey: `backup-failed:${t.id}:${NAME}`,
		});
		const [status] = await service.listTargets();
		expect(status?.lastResult).toBe('http_503');
		expect(JSON.stringify(j.notes)).not.toContain('app-password');
		// The server comes back: the next backup works and the status recovers.
		dav.state.status = 0;
		await j.attempt(t.id, 1, NAME2);
		expect((await service.listTargets())[0]?.lastResult).toBe('ok');
	});

	it('does not retry what waiting cannot fix', async () => {
		await service.setEncryption({ mode: 'none' });
		const t = await addTarget();
		const j = jobs();
		dav.state.status = 401;
		await j.attempt(t.id, 1);
		expect(j.notes).toHaveLength(1);
		expect((await service.listTargets())[0]?.lastResult).toBe('http_401');
	});

	it('skips disabled and removed targets, and queues one upload per enabled target', async () => {
		await service.setEncryption({ mode: 'none' });
		const a = await addTarget();
		const b = await addTarget();
		await service.updateTarget(b.id, { enabled: false });
		const j = jobs();
		await j.attempt(b.id, 1);
		expect(dav.files.size).toBe(0);
		expect(await enqueueUploads(j.ctx, service, NAME)).toBe(1);
		expect(j.enqueued).toEqual([
			{
				job: 'backup.upload',
				payload: { targetId: a.id, name: NAME },
				dedupeKey: `backup-upload:${a.id}:${NAME}`,
			},
		]);
		await service.removeTarget(a.id);
		await j.attempt(a.id, 1);
		expect(dav.files.size).toBe(0);
	});

	it('keeps the N newest backups on the target', async () => {
		await service.setEncryption({ mode: 'none' });
		const t = await addTarget(2);
		const j = jobs();
		for (const n of [NAME, NAME2, NAME3]) await j.attempt(t.id, 1, n);
		expect([...dav.files.keys()].sort()).toEqual([NAME2, NAME3]);
	});

	it('merges edits and keeps credentials that the form left blank', async () => {
		const t = await addTarget();
		const edited = await service.updateTarget(t.id, {
			name: 'Cloud',
			keep: 3,
			config: { url: `${server.origin}/dav`, username: 'anna', password: '' },
		});
		expect(edited).toMatchObject({ name: 'Cloud', keep: 3 });
		expect(await service.testTarget(t.id)).toEqual({ ok: true, code: 'ok' });
		await expect(
			service.updateTarget(t.id, { config: { url: 'ftp://nope' } }),
		).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('reports a test failure as a code only', async () => {
		const t = await addTarget();
		dav.state.status = 403;
		expect(await service.testTarget(t.id)).toEqual({ ok: false, code: 'http_403' });
	});
});
