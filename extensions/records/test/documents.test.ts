import { FamosError } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecordDocument } from '../src/contract/index.ts';
import { applied, CAR, createKernel, OTHER_CAR, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;

beforeEach(async () => {
	({ k } = await createKernel());
	admin = await person(k, 'admin');
});
afterEach(() => k.close());

const ITEM = 'inbox_item_00000000-0000-7000-8000-000000000001';
const key = (n = 0) => `inbox/${ITEM}/${n}`;
async function store(n: number, text: string) {
	await k.ctx.files.put(key(n), new TextEncoder().encode(text), 'application/pdf');
	// The Inbox lets records read what it files.
	await k.ctx.files.grant(key(n), 'records');
}
const file = (n = 0, name = 'policy.pdf') => ({ key: key(n), name, type: 'application/pdf' });
const attach = (input: Record<string, unknown>, actor = admin.actor) =>
	applied<RecordDocument[]>(
		k,
		'records.attachDocument',
		{ recordId: CAR, recordKind: 'vehicle', files: [file()], ...input },
		actor,
	);
const list = (record = CAR): Promise<RecordDocument[]> =>
	k.route('records.listDocuments').call({ query: { recordId: record } });
async function read(documentId: string): Promise<string> {
	const res = await k.route('records.getDocumentFile').call({ params: { documentId } });
	const chunks: Uint8Array[] = [];
	for await (const chunk of res.stream) chunks.push(chunk);
	return new TextDecoder().decode(Buffer.concat(chunks));
}

describe('documents', () => {
	it('links stored files to a record with a label and an expiry', async () => {
		await store(0, 'policy text');
		await store(1, 'invoice text');
		const docs = await attach({
			files: [file(0), file(1, 'invoice.pdf')],
			label: 'policy',
			expiresOn: '2027-01-01',
			sourceItemId: ITEM,
		});
		expect(docs).toHaveLength(2);
		expect(docs[0]).toMatchObject({
			recordId: CAR,
			name: 'policy.pdf',
			label: 'policy',
			expiresOn: '2027-01-01',
			sourceItemId: ITEM,
			size: 11,
			createdBy: admin.id,
		});
		expect(await list()).toHaveLength(2);
		expect(await list(OTHER_CAR)).toHaveLength(0);
	});

	it('serves a linked file and nothing else', async () => {
		await store(0, 'policy text');
		await store(1, 'not linked');
		const [doc] = await attach({});
		expect(await read((doc as RecordDocument).id)).toBe('policy text');
		const missing = await k
			.route('records.getDocumentFile')
			.call({ params: { documentId: 'record_doc_00000000-0000-7000-8000-000000000099' } })
			.catch((e: unknown) => e);
		expect(missing).toBeInstanceOf(FamosError);
		expect(missing).toMatchObject({ code: 'not_found' });
	});

	it('refuses files that do not exist or are not from the Inbox', async () => {
		await expect(attach({})).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			attach({ files: [{ key: 'backups/secret', name: 'x', type: 'text/plain' }] }),
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			attach({ files: [{ key: 'inbox/../x/0', name: 'x', type: 'text/plain' }] }),
		).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('cannot read an Inbox file the Inbox did not grant it', async () => {
		await k.ctx.files.put(key(5), new TextEncoder().encode('private'), 'application/pdf');
		await expect(attach({ files: [file(5)] })).rejects.toMatchObject({ code: 'bad_request' });
		const records = k.contextFor('records').files;
		expect(await records.get(key(5))).toBeNull();
		await expect(records.put(key(6), new Uint8Array([1]))).rejects.toMatchObject({
			code: 'forbidden',
		});
		await expect(records.grant(key(5), 'records')).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('attaching the same file twice keeps one link', async () => {
		await store(0, 'policy text');
		await attach({});
		await attach({ label: 'invoice' });
		expect(await list()).toHaveLength(1);
	});

	it('changes label and expiry, and detaches the link but keeps the file', async () => {
		await store(0, 'policy text');
		const [doc] = (await attach({})) as [RecordDocument];
		const updated = await applied<RecordDocument>(
			k,
			'records.updateDocument',
			{ id: doc.id, label: 'receipt', expiresOn: '2028-02-29' },
			admin.actor,
		);
		expect(updated).toMatchObject({ label: 'receipt', expiresOn: '2028-02-29' });
		await applied(k, 'records.detachDocument', { id: doc.id }, admin.actor);
		expect(await list()).toHaveLength(0);
		expect(await k.ctx.files.stat(key(0))).not.toBeNull();
	});

	it('hides and stops serving the papers of an archived record', async () => {
		await store(0, 'policy text');
		const [doc] = (await attach({})) as [RecordDocument];
		await applied(k, 'records.archiveForRecord', { recordId: CAR }, admin.actor);
		expect(await list()).toHaveLength(0);
		await expect(read(doc.id)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('needs records.edit to attach, and records.view to look', async () => {
		await store(0, 'policy text');
		const kid = await person(k, 'supervised');
		const guest = await person(k, 'guest');
		await expect(attach({}, kid.actor)).rejects.toMatchObject({ code: 'forbidden' });
		await expect(attach({}, guest.actor)).rejects.toMatchObject({ code: 'forbidden' });
		expect(await list()).toHaveLength(0);
		const [doc] = (await attach({})) as [RecordDocument];
		// Changing a paper is proposed by people who may only suggest.
		const r = await k.runner.invoke('records.detachDocument', { id: doc.id }, kid.actor);
		expect(r.status).toBe('drafted');
		expect(await list()).toHaveLength(1);
	});
});
