import { z } from 'zod';

export const PublicKeySchema = z.object({ publicKey: z.string() });

export const SubscribeInputSchema = z.object({
	endpoint: z.string().min(1).max(2048),
	keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
	/** A device name such as "iPhone · Safari"; trimmed to 60 characters. */
	label: z.string().max(200).optional(),
});
export type SubscribeInput = z.infer<typeof SubscribeInputSchema>;

export const UnsubscribeInputSchema = z.object({ endpoint: z.string().min(1).max(2048) });

export const DeviceSchema = z.object({
	/** SHA-256 of the browser's address, hex: lets a browser recognise its own entry without the address being shown. */
	endpointId: z.string(),
	label: z.string(),
	createdAt: z.number().int(),
	lastSuccessAt: z.number().int().nullable(),
});
export type PushDevice = z.infer<typeof DeviceSchema>;
export const DeviceListSchema = z.array(DeviceSchema);

export const TestResultSchema = z.object({ sent: z.number().int() });
