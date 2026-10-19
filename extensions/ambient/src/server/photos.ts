import {
	defineAction,
	defineJob,
	defineRoute,
	FamosError,
	FileResponseSchema,
	selfOf,
} from '@famos/sdk';
import { z } from 'zod';
import {
	LibraryPhotoSchema,
	PhotoIdSchema,
	PhotoListSchema,
	StoredPhotoSchema,
} from '../contract/index.ts';
import { ambientManage, ambientPhotos } from './capabilities.ts';
import { inspectImage } from './image.ts';
import { loadSettings, tables } from './store.ts';

/**
 * Photos the family uploads for displays. The browser shrinks each one before it is
 * sent; the server checks the bytes again, stores the file in the file store and serves it to
 * displays that were granted `ambient.photos`.
 */

/** A slideshow list is capped, so a display never fetches an endless library. */
export const MAX_PHOTOS = 200;
/** The library is capped as well: displays run on modest hardware and disks. */
export const MAX_LIBRARY = 500;
/** After the browser resized it (a 1920 px JPEG is a few hundred KB). */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** Larger than this on either side is not a screen photo. */
export const PHOTO_MAX_SIDE = 8192;

const EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;

/** Fisher-Yates; `random` is injectable for tests. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

const memberOf = selfOf;

/** Records a photo whose file the upload route already put in the file store. */
export const addPhoto = defineAction({
	id: 'ambient.addPhoto',
	title: 'Add a photo to the display photos',
	input: StoredPhotoSchema,
	output: z.object({ id: PhotoIdSchema }),
	requires: ambientManage.id,
	approval: 'never',
	async run(uow, input) {
		const { count } = await tables(uow.db)
			.selectFrom('ambient_photos')
			.select((eb) => eb.fn.countAll<number>().as('count'))
			.executeTakeFirstOrThrow();
		if (Number(count) >= MAX_LIBRARY)
			throw new FamosError('bad_request', `At most ${MAX_LIBRARY} photos are kept`);
		const id = uow.ids.next('amb_photo') as z.output<typeof PhotoIdSchema>;
		await tables(uow.db)
			.insertInto('ambient_photos')
			.values({
				id,
				file_key: input.key,
				content_type: input.type,
				width: input.width,
				height: input.height,
				byte_size: input.size,
				uploaded_by: memberOf(uow.actor),
				created_at: uow.clock.now(),
			})
			.execute();
		return { id };
	},
});

export const deleteFileJob = defineJob({
	name: 'ambient.deleteFile',
	payload: z.object({ key: z.string().min(1) }),
	async handle(ctx, { key }) {
		await ctx.files.delete(key);
	},
});

export const deletePhoto = defineAction({
	id: 'ambient.deletePhoto',
	title: 'Remove a photo from the display photos',
	input: z.object({ id: PhotoIdSchema }),
	output: z.object({ removed: z.boolean() }),
	requires: ambientManage.id,
	approval: 'never',
	async run(uow, { id }) {
		const row = await tables(uow.db)
			.selectFrom('ambient_photos')
			.select('file_key')
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) return { removed: false };
		await tables(uow.db).deleteFrom('ambient_photos').where('id', '=', id).execute();
		// The file goes with a job, so it is removed only if the row really is gone.
		await uow.enqueue('ambient.deleteFile', { key: row.file_key });
		return { removed: true };
	},
});

export const uploadPhoto = defineRoute({
	method: 'post',
	path: '/photos',
	operationId: 'ambient.uploadPhoto',
	summary: 'Add a photo for displays (multipart: one JPEG, PNG or WebP image, at most 5 MB)',
	requires: ambientManage.id,
	upload: {
		maxBytes: PHOTO_MAX_BYTES + 64 * 1024,
		maxFiles: 1,
		accept: ['image/jpeg', 'image/png', 'image/webp'],
	},
	response: z.object({ id: PhotoIdSchema }),
	async handle(ctx, { files, actor }) {
		const file = files[0];
		if (!file) throw new FamosError('bad_request', 'Send one image');
		if (file.size > PHOTO_MAX_BYTES) throw new FamosError('bad_request', 'The photo is too large');
		const bytes = await file.bytes();
		if (bytes.byteLength > PHOTO_MAX_BYTES)
			throw new FamosError('bad_request', 'The photo is too large');
		const info = inspectImage(bytes);
		if (!info) throw new FamosError('bad_request', 'The photo must be a JPEG, PNG or WebP image');
		if (info.width > PHOTO_MAX_SIDE || info.height > PHOTO_MAX_SIDE)
			throw new FamosError('bad_request', 'The photo is too large');
		// Files cannot join a transaction: store first, remove again if the action fails.
		const key = `ambient/photos/${ctx.ids.next('amb_file')}.${EXTENSION[info.type]}`;
		await ctx.files.put(key, bytes, info.type);
		try {
			const result = await ctx.actions.invoke<{ id: z.output<typeof PhotoIdSchema> }>(
				'ambient.addPhoto',
				{
					key,
					type: info.type,
					width: info.width,
					height: info.height,
					size: bytes.byteLength,
				},
				actor,
			);
			if (result.status !== 'applied') throw new FamosError('conflict', 'The photo was not saved');
			return { id: result.output.id };
		} catch (error) {
			await ctx.files.delete(key);
			throw error;
		}
	},
});

export const listLibrary = defineRoute({
	method: 'get',
	path: '/library',
	operationId: 'ambient.listLibrary',
	summary: 'The uploaded display photos, newest first, for the settings page',
	requires: ambientManage.id,
	response: z.array(LibraryPhotoSchema),
	async handle(ctx) {
		const rows = await tables(ctx.db)
			.selectFrom('ambient_photos')
			.selectAll()
			.orderBy('created_at', 'desc')
			.orderBy('id', 'desc')
			.limit(MAX_LIBRARY)
			.execute();
		return rows.map((r) => ({
			id: r.id,
			contentType: r.content_type,
			width: r.width,
			height: r.height,
			size: r.byte_size,
			uploadedBy: r.uploaded_by,
			createdAt: r.created_at,
		}));
	},
});

export const listPhotos = defineRoute({
	method: 'get',
	path: '/photos',
	operationId: 'ambient.listPhotos',
	summary: 'Shuffled ids of the uploaded display photos (at most 200)',
	requires: ambientPhotos.id,
	response: PhotoListSchema,
	async handle(ctx) {
		const { settings } = await loadSettings(ctx.db);
		const rows = await tables(ctx.db).selectFrom('ambient_photos').select('id').execute();
		return {
			ids: shuffle(rows.map((r) => r.id)).slice(0, MAX_PHOTOS),
			timing: settings.timing,
		};
	},
});

export const getPhoto = defineRoute({
	method: 'get',
	path: '/photos/{photoId}',
	operationId: 'ambient.getPhoto',
	summary: 'An uploaded display photo',
	requires: ambientPhotos.id,
	params: z.object({ photoId: PhotoIdSchema }),
	response: FileResponseSchema,
	async handle(ctx, { params }) {
		const row = await tables(ctx.db)
			.selectFrom('ambient_photos')
			.selectAll()
			.where('id', '=', params.photoId)
			.executeTakeFirst();
		const stored = row ? await ctx.files.get(row.file_key) : null;
		if (!row || !stored) throw new FamosError('not_found', 'Photo not found');
		return {
			stream: stored.stream,
			contentType: row.content_type,
			size: stored.stat.size,
			filename: `photo.${EXTENSION[row.content_type as keyof typeof EXTENSION] ?? 'jpg'}`,
			cacheControl: 'private, max-age=3600',
		};
	},
});
