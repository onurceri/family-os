import { z } from 'zod';
import { normalizeBaseUrl } from './url.ts';

export { type BaseUrl, normalizeBaseUrl } from './url.ts';

/**
 * Home Assistant contract: the connection the family made and what the check found out.
 */

/** What the last check found: `checking` until the job has answered. */
export const CONNECTION_STATUSES = [
	'checking',
	'ok',
	'token_refused',
	'not_home_assistant',
	'unreachable',
	'blocked_address',
	'timeout',
	'failed',
] as const;
export const ConnectionStatusSchema = z.enum(CONNECTION_STATUSES);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

/** A long-lived access token: one word, as Home Assistant shows it. */
export const TokenSchema = z
	.string()
	.trim()
	.min(1)
	.max(1024)
	.regex(/^\S+$/, 'A token has no spaces');

export const AddressSchema = z
	.string()
	.max(2000)
	.refine((value) => normalizeBaseUrl(value) !== null, {
		message: 'Use an http or https address without a user name, query or fragment',
	});

export const ConnectInputSchema = z.object({
	url: AddressSchema,
	token: TokenSchema,
});
export type ConnectInput = z.infer<typeof ConnectInputSchema>;

/** What testing an address and a token found; nothing is stored. */
export const TestResultSchema = z.object({
	status: ConnectionStatusSchema.exclude(['checking']),
	version: z.string().nullable(),
	name: z.string().nullable(),
});
export type TestResult = z.infer<typeof TestResultSchema>;

/** The address without anything that could be a secret in it. */
export const ConnectionAddressSchema = z.object({
	scheme: z.enum(['http', 'https']),
	host: z.string(),
	port: z.number().int().nullable(),
	path: z.string().nullable(),
});
export type ConnectionAddress = z.infer<typeof ConnectionAddressSchema>;

/** The connection as the API shows it: never the token. */
export const ConnectionSchema = z.discriminatedUnion('connected', [
	z.object({ connected: z.literal(false) }),
	z.object({
		connected: z.literal(true),
		address: ConnectionAddressSchema,
		status: ConnectionStatusSchema,
		checkedAt: z.number().int().nullable(),
		version: z.string().nullable(),
		name: z.string().nullable(),
	}),
]);
export type Connection = z.infer<typeof ConnectionSchema>;

export const connectionChangedPayload = z.object({});

/** The most things a family can show from Home Assistant. */
export const MAX_ITEMS = 12;

/**
 * Any Home Assistant entity can be read, except where people are: persons, device trackers and
 * zones. Presence and location are not shown from here. Showing a light or a lock does not let
 * anyone switch it: that is a choice of its own per item (`control`).
 */
export const ENTITY_ID_PATTERN = /^(?!person\.|device_tracker\.|zone\.)[a-z_]+\.[a-z0-9_]+$/;
export const EntityIdSchema = z.string().max(200).regex(ENTITY_ID_PATTERN);

export const LabelSchema = z.string().trim().min(1).max(40);

export const ItemIdSchema = z.string().min(1).max(100);

/**
 * What FamilyOS may ask Home Assistant to do, per domain: the only services it ever calls. The
 * address of a call is built from this table alone, never from what a request says, so nothing
 * else in Home Assistant can be reached through FamilyOS. Lights, switches, fans and helpers are
 * on or off; covers open, close and stop; locks lock and unlock; scenes and scripts run.
 */
export const CONTROLS = {
	light: ['turn_on', 'turn_off'],
	switch: ['turn_on', 'turn_off'],
	fan: ['turn_on', 'turn_off'],
	input_boolean: ['turn_on', 'turn_off'],
	cover: ['open_cover', 'close_cover', 'stop_cover'],
	lock: ['lock', 'unlock'],
	scene: ['turn_on'],
	script: ['turn_on'],
} as const;
export type ControlDomain = keyof typeof CONTROLS;
export type Operation = (typeof CONTROLS)[ControlDomain][number];
export const OPERATIONS = [
	'turn_on',
	'turn_off',
	'open_cover',
	'close_cover',
	'stop_cover',
	'lock',
	'unlock',
] as const satisfies readonly Operation[];
export const OperationSchema = z.enum(OPERATIONS);

const domainOf = (entityId: string) => entityId.slice(0, entityId.indexOf('.'));

/** The domain of an entity FamilyOS can switch, or null. */
export function controlDomain(entityId: string): ControlDomain | null {
	const domain = domainOf(entityId);
	return Object.hasOwn(CONTROLS, domain) ? (domain as ControlDomain) : null;
}

/** What may be done to an entity, from the table; nothing for one FamilyOS cannot switch. */
export function operationsOf(entityId: string): readonly Operation[] {
	const domain = controlDomain(entityId);
	return domain ? CONTROLS[domain] : [];
}

/**
 * The service to call for an operation on an entity, as the table spells it, or null when the
 * table does not offer it for that entity's domain.
 */
export function serviceFor(
	entityId: string,
	operation: string,
): { domain: ControlDomain; service: Operation } | null {
	const domain = controlDomain(entityId);
	if (!domain) return null;
	const service = CONTROLS[domain].find((known) => known === operation);
	return service ? { domain, service } : null;
}

/** One thing the family chose to show, with its own short name. */
export const ItemSchema = z.object({
	id: ItemIdSchema,
	entityId: EntityIdSchema,
	label: LabelSchema,
	position: z.number().int().min(0),
	/** The family allowed switching it from FamilyOS (for those who may switch). */
	control: z.boolean(),
	/** Ask before switching it. */
	confirm: z.boolean(),
});
export type Item = z.infer<typeof ItemSchema>;

export const ItemListSchema = z.object({ items: z.array(ItemSchema) });

export const AddItemInputSchema = z.object({ entityId: EntityIdSchema, label: LabelSchema });
export const RenameItemInputSchema = z.object({ id: ItemIdSchema, label: LabelSchema });
export const RemoveItemInputSchema = z.object({ id: ItemIdSchema });
export const MoveItemInputSchema = z.object({
	id: ItemIdSchema,
	position: z.number().int().min(0).max(MAX_ITEMS),
});
export const SetItemControlInputSchema = z.object({
	id: ItemIdSchema,
	control: z.boolean(),
	confirm: z.boolean(),
});
export const SwitchInputSchema = z.object({ id: ItemIdSchema, operation: OperationSchema });

/** A switch could not be done; only the person who asked for it hears of it. */
export const switchFailedPayload = z.object({ id: ItemIdSchema });
/** Something was switched: the values are worth reading again. */
export const valuesChangedPayload = z.object({ id: ItemIdSchema });

/** The domains whose state words FamilyOS knows how to say. */
export const STATE_DOMAINS = ['lock', 'cover', 'climate'] as const;

/**
 * What an entity reads right now, as data and not as words: the interface says it in the
 * reader's language and region.
 */
export const ValueSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('unavailable') }),
	z.object({ kind: z.literal('time'), at: z.number().int() }),
	/** A scene or a button: when it last ran, or null when it never has. */
	z.object({ kind: z.literal('lastRun'), at: z.number().int().nullable() }),
	z.object({ kind: z.literal('number'), value: z.number(), unit: z.string().nullable() }),
	z.object({ kind: z.literal('binary'), on: z.boolean(), deviceClass: z.string().nullable() }),
	/** A lock, a cover or a thermostat: Home Assistant's state word, and a temperature if it has one. */
	z.object({
		kind: z.literal('state'),
		domain: z.enum(STATE_DOMAINS),
		state: z.string(),
		temperature: z.number().nullable(),
	}),
	z.object({ kind: z.literal('text'), text: z.string() }),
]);
export type Value = z.infer<typeof ValueSchema>;

export const VALUES_STATUSES = ['ok', 'not_connected', 'unavailable'] as const;

export const ValuesSchema = z.object({
	items: z.array(
		z.object({
			id: ItemIdSchema,
			entityId: EntityIdSchema,
			label: LabelSchema,
			/** Home Assistant's own name for the entity. */
			name: z.string().nullable(),
			value: ValueSchema,
			changedAt: z.number().int().nullable(),
			control: z.boolean(),
			confirm: z.boolean(),
		}),
	),
	status: z.enum(VALUES_STATUSES),
});
export type Values = z.infer<typeof ValuesSchema>;

export const EntitiesQuerySchema = z.object({ q: z.string().trim().max(80).optional() });

export const EntitiesSchema = z.object({
	entities: z.array(z.object({ entityId: EntityIdSchema, name: z.string(), value: ValueSchema })),
	/** `too_many`: the home has more than FamilyOS reads at once; the picker takes a typed id. */
	status: z.enum(['ok', 'too_many', 'not_connected', 'unavailable']),
});
export type Entities = z.infer<typeof EntitiesSchema>;

export const itemsChangedPayload = z.object({});

/**
 * Who is home. A Home Assistant person (`person.*`) is linked to a member by an admin; what
 * FamilyOS then shows about that member is theirs alone to choose. Nothing of a person is stored
 * but the link and that choice: never a place, a coordinate or a time.
 */
export const PERSON_ENTITY_PATTERN = /^person\.[a-z0-9_]+$/;
export const PersonEntitySchema = z.string().max(200).regex(PERSON_ENTITY_PATTERN);

/** What a person shows: nothing, whether they are home, or the name of the zone they are in. */
export const SHARING_LEVELS = ['none', 'home', 'place'] as const;
export const SharingLevelSchema = z.enum(SHARING_LEVELS);
export type SharingLevel = z.infer<typeof SharingLevelSchema>;

export const MemberIdSchema = z.string().min(1).max(100);

export const LinkPersonInputSchema = z.object({
	memberId: MemberIdSchema,
	personEntity: PersonEntitySchema,
});
export const UnlinkPersonInputSchema = z.object({ memberId: MemberIdSchema });

/**
 * A person's own choice. There is no member in it: whoever runs it changes only their own, so
 * nobody can choose for someone else.
 */
export const SetMySharingInputSchema = z.strictObject({
	level: SharingLevelSchema,
	onDisplays: z.boolean(),
});

/** One link, as the admin sees it: the person's choice is shown, never changed, there. */
export const PersonLinkSchema = z.object({
	memberId: MemberIdSchema,
	personEntity: PersonEntitySchema,
	level: SharingLevelSchema,
	onDisplays: z.boolean(),
});
export type PersonLink = z.infer<typeof PersonLinkSchema>;
export const PersonLinksSchema = z.object({ links: z.array(PersonLinkSchema) });

/** The signed-in member's own choice, or that they are not linked. */
export const MySharingSchema = z.discriminatedUnion('linked', [
	z.object({ linked: z.literal(false) }),
	z.object({ linked: z.literal(true), level: SharingLevelSchema, onDisplays: z.boolean() }),
]);
export type MySharing = z.infer<typeof MySharingSchema>;

/** The people Home Assistant has, with nothing but their id and name. */
export const PersonsSchema = z.object({
	persons: z.array(z.object({ entityId: PersonEntitySchema, name: z.string() })),
	status: z.enum(['ok', 'too_many', 'not_connected', 'unavailable']),
});
export type Persons = z.infer<typeof PersonsSchema>;

/** The longest zone name shown. */
export const MAX_PLACE = 60;

/** Where someone is, as much as they chose to show. */
export const PresenceSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('unknown') }),
	z.object({ kind: z.literal('home') }),
	z.object({ kind: z.literal('away') }),
	/** A Home Assistant zone, by the name Home Assistant gives it ("School"). */
	z.object({ kind: z.literal('place'), name: z.string().max(MAX_PLACE) }),
]);
export type Presence = z.infer<typeof PresenceSchema>;

export const PresenceListSchema = z.object({
	people: z.array(
		z.object({
			memberId: MemberIdSchema,
			presence: PresenceSchema,
			/** When it last changed, in epoch ms (Home Assistant's `last_changed`). */
			since: z.number().int().nullable(),
		}),
	),
	status: z.enum(VALUES_STATUSES),
});
export type PresenceList = z.infer<typeof PresenceListSchema>;

export const peopleChangedPayload = z.object({});
