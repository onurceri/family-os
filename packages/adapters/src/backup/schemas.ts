import { z } from 'zod';

/** An http(s) address without credentials; a trailing slash is dropped. */
const Address = z
	.string()
	.trim()
	.max(500)
	.transform((value, ctx) => {
		try {
			const url = new URL(value);
			if (
				(url.protocol !== 'https:' && url.protocol !== 'http:') ||
				url.username ||
				url.password ||
				url.search ||
				url.hash
			)
				throw new Error('bad');
			return url.toString().replace(/\/+$/, '');
		} catch {
			ctx.addIssue({
				code: 'custom',
				message: 'Use an http(s) address without user name, password or query',
			});
			return z.NEVER;
		}
	});

/** A folder inside a bucket: letters, digits and `._-/` only, no leading or trailing slash. */
const Prefix = z
	.string()
	.trim()
	.max(200)
	.regex(/^[A-Za-z0-9._\-/]*$/, 'Use letters, digits and . _ - / only')
	.transform((v) => v.replace(/^\/+|\/+$/g, ''));

export const S3ConfigSchema = z.object({
	endpoint: Address,
	region: z.string().trim().min(1).max(60).default('us-east-1'),
	bucket: z
		.string()
		.trim()
		.regex(/^[a-zA-Z0-9][a-zA-Z0-9.\-_]{1,61}[a-zA-Z0-9]$/, 'Not a valid bucket name'),
	prefix: Prefix.default(''),
	accessKeyId: z.string().trim().min(1).max(200),
	secretAccessKey: z.string().min(1).max(500),
	/** `https://host/bucket/key` instead of `https://bucket.host/key` (MinIO, R2, many others). */
	pathStyle: z.boolean().default(false),
});
export type S3Config = z.infer<typeof S3ConfigSchema>;

export const WebDavConfigSchema = z.object({
	/** The folder to write into, e.g. `https://cloud/remote.php/dav/files/anna/FamilyOS`. */
	url: Address,
	username: z.string().trim().min(1).max(200),
	password: z.string().min(1).max(500),
});
export type WebDavConfig = z.infer<typeof WebDavConfigSchema>;

const Name = z.string().trim().min(1).max(60);
const Keep = z.number().int().min(1).max(365);

export const TargetInputSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('s3'),
		name: Name,
		keep: Keep.default(7),
		config: S3ConfigSchema,
	}),
	z.object({
		kind: z.literal('webdav'),
		name: Name,
		keep: Keep.default(7),
		config: WebDavConfigSchema,
	}),
]);
export type TargetInput = z.infer<typeof TargetInputSchema>;

/** Changes to a target. Credentials left out keep their value; `kind` cannot change. */
export const TargetPatchSchema = z.object({
	name: Name.optional(),
	keep: Keep.optional(),
	enabled: z.boolean().optional(),
	config: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
});
export type TargetPatch = z.infer<typeof TargetPatchSchema>;

export {
	BackupEncryptionModeSchema as EncryptionModeSchema,
	type BackupEncryptionStatus as EncryptionStatus,
	BackupEncryptionStatusSchema as EncryptionStatusSchema,
	type BackupTargetStatus as TargetStatus,
	BackupTargetStatusSchema as TargetStatusSchema,
	BackupTargetSummarySchema as TargetSummarySchema,
} from '@famos/sdk';

export const EncryptionInputSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('passphrase'), passphrase: z.string().min(12).max(500) }),
	z.object({ mode: z.literal('recipient'), recipient: z.string().trim().min(10).max(200) }),
	z.object({ mode: z.literal('none') }),
]);
export type EncryptionInput = z.infer<typeof EncryptionInputSchema>;

export const TestResultSchema = z.object({ ok: z.boolean(), code: z.string() });
export type TestResult = z.infer<typeof TestResultSchema>;
