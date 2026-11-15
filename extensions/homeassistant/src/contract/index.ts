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
 * else in Home Assistant can be reached through FamilyOS. Lights, switches, fans, humidifiers and
 * helpers are on or off; covers and valves open, close and stop; locks lock and unlock; scenes and
 * scripts run; buttons are pressed; vacuums start, pause and go home; media players play, pause and
 * turn on or off; fans also take a speed and a preset, covers and valves a position, humidifiers a
 * target humidity and a mode, media players a volume. A light is dimmed with `turn_on` and a
 * brightness (see `SERVICE_DATA`), so it has no service of its own for that.
 */
export const CONTROLS = {
	light: ['turn_on', 'turn_off'],
	switch: ['turn_on', 'turn_off'],
	fan: ['turn_on', 'turn_off', 'set_percentage', 'set_preset_mode'],
	humidifier: ['turn_on', 'turn_off', 'set_humidity', 'set_mode'],
	input_boolean: ['turn_on', 'turn_off'],
	cover: ['open_cover', 'close_cover', 'stop_cover', 'set_cover_position'],
	lock: ['lock', 'unlock'],
	valve: ['open_valve', 'close_valve', 'stop_valve', 'set_valve_position'],
	vacuum: ['start', 'pause', 'return_to_base'],
	media_player: ['media_play', 'media_pause', 'turn_on', 'turn_off', 'volume_set'],
	button: ['press'],
	input_button: ['press'],
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
	'open_valve',
	'close_valve',
	'stop_valve',
	'start',
	'pause',
	'return_to_base',
	'media_play',
	'media_pause',
	'press',
	'set_percentage',
	'set_preset_mode',
	'set_humidity',
	'set_mode',
	'set_cover_position',
	'set_valve_position',
	'volume_set',
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

/** A bound of a number: fixed, or named by an attribute of the entity read when it is sent. */
type Bound = number | { attribute: string };

/**
 * The one extra field a service call may carry, and what its value must be. Either a number
 * (whole or not, between two bounds that are fixed or read from named attributes of the entity,
 * on the grid of a step attribute when given) or one of the options the entity itself lists in an
 * attribute (such as `preset_modes`).
 */
export type ServiceDataRule =
	| {
			kind: 'number';
			field: string;
			integer: boolean;
			min: Bound;
			max: Bound;
			step?: { attribute: string };
			/** The operation also works without the field (`light.turn_on` without a brightness). */
			optional?: true;
	  }
	| { kind: 'option'; field: string; options: { attribute: string }; optional?: true };

/**
 * The only service data FamilyOS ever sends: per `<domain>.<operation>`, exactly one field with
 * the rule its value must meet. A call's body is its entity plus what this table allows for the
 * operation, built by `serviceBody`; an operation not listed here carries nothing, and no other
 * field passes. Each entry widens what FamilyOS can do in the home, so one is added deliberately,
 * with its own tests, never as a side effect of something else.
 */
export const SERVICE_DATA: Readonly<Record<string, ServiceDataRule>> = {
	'fan.set_percentage': { kind: 'number', field: 'percentage', integer: true, min: 0, max: 100 },
	'fan.set_preset_mode': {
		kind: 'option',
		field: 'preset_mode',
		options: { attribute: 'preset_modes' },
	},
	// Switching a light on carries a brightness only when one is chosen; the plain switch sends none.
	'light.turn_on': {
		kind: 'number',
		field: 'brightness_pct',
		integer: true,
		min: 1,
		max: 100,
		optional: true,
	},
	'cover.set_cover_position': {
		kind: 'number',
		field: 'position',
		integer: true,
		min: 0,
		max: 100,
	},
	'valve.set_valve_position': {
		kind: 'number',
		field: 'position',
		integer: true,
		min: 0,
		max: 100,
	},
	'humidifier.set_humidity': {
		kind: 'number',
		field: 'humidity',
		integer: true,
		min: { attribute: 'min_humidity' },
		max: { attribute: 'max_humidity' },
	},
	'humidifier.set_mode': {
		kind: 'option',
		field: 'mode',
		options: { attribute: 'available_modes' },
	},
	'media_player.volume_set': {
		kind: 'number',
		field: 'volume_level',
		integer: false,
		min: 0,
		max: 1,
	},
};

/** The rule for an operation on an entity, or null when it takes no data. */
export function serviceDataRule(entityId: string, operation: string): ServiceDataRule | null {
	const key = `${domainOf(entityId)}.${operation}`;
	return Object.hasOwn(SERVICE_DATA, key) ? (SERVICE_DATA[key] ?? null) : null;
}

/** Whether the rule needs the entity's live attributes to be checked. */
export function needsAttributes(rule: ServiceDataRule): boolean {
	if (rule.kind === 'option') return true;
	return typeof rule.min === 'object' || typeof rule.max === 'object' || rule.step !== undefined;
}

const finiteNumber = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? value : null;

const boundOf = (value: Bound, attributes: Record<string, unknown>): number | null =>
	typeof value === 'number' ? value : finiteNumber(attributes[value.attribute]);

/**
 * The body of a service call under one rule: the entity and the rule's one field. Null refuses a
 * value the rule does not allow. `attributes` are the entity's live attributes; leave them out
 * where they have not been read (the action's early check): what depends on them is then left to
 * the job, which reads them and refuses when an attribute is missing.
 */
export function bodyUnderRule(
	rule: ServiceDataRule,
	entityId: string,
	value: unknown,
	attributes?: Record<string, unknown>,
): Record<string, string | number> | null {
	const body = (v: string | number) => ({ entity_id: entityId, [rule.field]: v });
	if (rule.kind === 'option') {
		if (typeof value !== 'string' || value === '') return null;
		if (!attributes) return body(value);
		const list = attributes[rule.options.attribute];
		return Array.isArray(list) && list.includes(value) ? body(value) : null;
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	if (rule.integer && !Number.isInteger(value)) return null;
	if (typeof rule.min === 'number' && value < rule.min) return null;
	if (typeof rule.max === 'number' && value > rule.max) return null;
	if (attributes) {
		const min = boundOf(rule.min, attributes);
		const max = boundOf(rule.max, attributes);
		if (min === null || max === null || value < min || value > max) return null;
		if (rule.step) {
			const step = finiteNumber(attributes[rule.step.attribute]);
			if (step === null || step <= 0) return null;
			const steps = (value - min) / step;
			if (Math.abs(steps - Math.round(steps)) > 1e-6) return null;
		}
	}
	return body(value);
}

/**
 * The body of a service call: the entity, and for an operation in `SERVICE_DATA` its one field.
 * Null refuses: a value for an operation that takes none, none for one that needs it (unless the
 * rule is `optional`, then the body is the entity alone), or one the rule does not allow (see
 * `bodyUnderRule`).
 */
export function serviceBody(
	entityId: string,
	operation: string,
	value: unknown,
	attributes?: Record<string, unknown>,
): Record<string, string | number> | null {
	const rule = serviceDataRule(entityId, operation);
	const none = value === undefined || value === null;
	if (!rule || (rule.optional && none)) return none ? { entity_id: entityId } : null;
	return bodyUnderRule(rule, entityId, value, attributes);
}

/** Fans with more speeds than this stay on or off: a choice of a dozen speeds is no quick change. */
export const MAX_SPEEDS = 6;

/** The speed (1, 2, 3 …) a request names, for the history's words; never sent to Home Assistant. */
export const SpeedLevelSchema = z.number().int().min(1).max(MAX_SPEEDS);

/**
 * What a switch set, for the history: a number as the percentage it is shown as (a volume of 0.3
 * is 30), an option as it is. Null for a fan's speed, which the history words by its level, and
 * for a switch that set nothing.
 */
export function chosenOf(operation: string, value: unknown): string | null {
	if (operation === 'set_percentage') return null;
	if (typeof value === 'string') return value;
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	return String(operation === 'volume_set' ? Math.round(value * 100) : value);
}

export const SwitchInputSchema = z.object({
	id: ItemIdSchema,
	operation: OperationSchema,
	/**
	 * What the operation sets: a number or an option, only where `SERVICE_DATA` has a rule for the
	 * operation (required unless the rule is optional, as for a light's brightness).
	 */
	value: z.union([z.number(), z.string().min(1).max(100)]).optional(),
	/** The same speed as the fan's own step (1 … 6), for the history; only for `set_percentage`. */
	level: SpeedLevelSchema.optional(),
});

/** The most switches the history shows at once. */
export const MAX_HISTORY = 20;

/** One switch, as the history tells it: who asked, what was done to what, and how it went. */
export const SwitchEntrySchema = z.object({
	id: z.string().min(1).max(100),
	itemId: ItemIdSchema,
	entityId: EntityIdSchema,
	/** The family's name for the item when it was switched. */
	label: LabelSchema,
	operation: OperationSchema,
	/** A fan's speed (1, 2, 3 …) when the switch set one. */
	level: SpeedLevelSchema.nullable().optional(),
	/**
	 * What a level, a position, a humidity, a volume (as a percentage) or a mode was set to, as
	 * text; null for a switch that set none.
	 */
	chosen: z.string().max(100).nullable().optional(),
	/** Who asked; null for a display, which is never told who, or for no one. */
	memberId: z.string().nullable(),
	/** Home Assistant took the order; false when it could not be done. */
	ok: z.boolean(),
	at: z.number().int(),
});
export type SwitchEntry = z.infer<typeof SwitchEntrySchema>;

export const SwitchHistoryQuerySchema = z.object({
	/** Only this item's switches. */
	itemId: ItemIdSchema.optional(),
	limit: z.coerce.number().int().min(1).max(MAX_HISTORY).optional(),
});
export const SwitchHistorySchema = z.object({ entries: z.array(SwitchEntrySchema) });
export type SwitchHistory = z.infer<typeof SwitchHistorySchema>;

export const switchesChangedPayload = z.object({});

/** A switch could not be done; only the person who asked for it hears of it. */
export const switchFailedPayload = z.object({ id: ItemIdSchema });
/** Something was switched: the values are worth reading again. */
export const valuesChangedPayload = z.object({ id: ItemIdSchema });

/** The domains whose state words FamilyOS knows how to say. */
export const STATE_DOMAINS = [
	'lock',
	'cover',
	'climate',
	'valve',
	'vacuum',
	'media_player',
] as const;

/** The most options (modes, presets) kept of an entity, and the longest word of one. */
export const MAX_OPTIONS = 20;
export const MAX_OPTION_LENGTH = 40;

const OptionsSchema = z.object({
	options: z.array(z.string().max(MAX_OPTION_LENGTH)).min(1).max(MAX_OPTIONS),
	current: z.string().max(MAX_OPTION_LENGTH).nullable(),
});
const PercentSchema = z.object({ percent: z.number().int().min(0).max(100).nullable() });

/**
 * What a thing can be set to beyond on and off, from what it reports now: only the groups it
 * offers are present. A percentage is null while it is not known (a light that is off).
 */
export const LevelsSchema = z.object({
	brightness: PercentSchema.optional(),
	position: PercentSchema.optional(),
	volume: PercentSchema.optional(),
	humidity: z
		.object({
			target: z.number().int().nullable(),
			min: z.number().int(),
			max: z.number().int(),
		})
		.optional(),
	/** A humidifier's modes. */
	mode: OptionsSchema.optional(),
	/** A fan's presets. */
	preset: OptionsSchema.optional(),
});
export type Levels = z.infer<typeof LevelsSchema>;

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
	z.object({
		kind: z.literal('binary'),
		on: z.boolean(),
		deviceClass: z.string().nullable(),
		/** A fan's speed as Home Assistant reports it; only fans have it. */
		speed: z.object({ percentage: z.number().nullable(), step: z.number().nullable() }).optional(),
		/** What a light, a fan or a humidifier can be set to besides on and off. */
		levels: LevelsSchema.optional(),
	}),
	/** A lock, a cover, a valve, a vacuum, a media player or a thermostat: Home Assistant's state word, and a temperature if it has one. */
	z.object({
		kind: z.literal('state'),
		domain: z.enum(STATE_DOMAINS),
		state: z.string(),
		temperature: z.number().nullable(),
		/** A cover's or valve's position, a media player's volume. */
		levels: LevelsSchema.optional(),
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
	/** More entities matched than the list holds; the picker asks for a narrower search. */
	more: z.boolean(),
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

/**
 * A service of Home Assistant's `notify` domain, without the domain (`mobile_app_alex_phone`).
 * The address of a send is built from it, so it is one word of lower-case letters, digits and
 * underscores and nothing else.
 */
export const NOTIFY_SERVICE_PATTERN = /^[a-z0-9_]+$/;
export const NotifyServiceSchema = z.string().min(1).max(100).regex(NOTIFY_SERVICE_PATTERN);

/** How the last send to a member's phone went; `refused` and `unreachable` only come from a test. */
export const NOTIFY_STATUSES = ['ok', 'missing', 'refused', 'unreachable'] as const;
export const NotifyStatusSchema = z.enum(NOTIFY_STATUSES);
export type NotifyStatus = z.infer<typeof NotifyStatusSchema>;

export const SetNotifyTargetInputSchema = z.object({
	memberId: MemberIdSchema,
	/** Null: texts do not go to Home Assistant for this member. */
	service: NotifyServiceSchema.nullable(),
});
export const TestNotifyInputSchema = z.object({ memberId: MemberIdSchema });

/** One link, as the admin sees it: the person's choice is shown, never changed, there. */
export const PersonLinkSchema = z.object({
	memberId: MemberIdSchema,
	personEntity: PersonEntitySchema,
	level: SharingLevelSchema,
	onDisplays: z.boolean(),
	/** Where this member's texts go in Home Assistant, or null. */
	notifyService: NotifyServiceSchema.nullable(),
	notifyStatus: NotifyStatusSchema.nullable(),
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
			/** Null for a family display that was not granted names. */
			memberId: MemberIdSchema.nullable(),
			presence: PresenceSchema,
			/** When it last changed, in epoch ms (Home Assistant's `last_changed`). */
			since: z.number().int().nullable(),
		}),
	),
	status: z.enum(VALUES_STATUSES),
});
export type PresenceList = z.infer<typeof PresenceListSchema>;

/** A service Home Assistant offers for texts; `suggested` when its name matches the person's phone. */
export const NotifyTargetSchema = z.object({
	service: NotifyServiceSchema,
	suggested: z.boolean(),
});
export const NotifyTargetsQuerySchema = z.object({ memberId: MemberIdSchema.optional() });
export const NotifyTargetsSchema = z.object({
	targets: z.array(NotifyTargetSchema),
	status: z.enum(['ok', 'not_connected', 'unavailable']),
});
export type NotifyTargets = z.infer<typeof NotifyTargetsSchema>;

export const peopleChangedPayload = z.object({});

/** What a fan's speed means: how many speeds it has and which one it is on now. */
export interface FanSpeeds {
	speeds: number;
	/** 0 when off; null when it is on and Home Assistant does not say how fast. */
	current: number | null;
}

/**
 * The speeds of a fan from what Home Assistant reports (`percentage_step` is 100 divided by the
 * speed count), or null when it has none to pick from: no step, one speed, or more than
 * `MAX_SPEEDS`.
 */
export function fanSpeeds(value: Value): FanSpeeds | null {
	if (value.kind !== 'binary' || !value.speed) return null;
	const { percentage, step } = value.speed;
	if (step === null || !(step > 0)) return null;
	const speeds = Math.round(100 / step);
	if (speeds < 2 || speeds > MAX_SPEEDS) return null;
	if (!value.on) return { speeds, current: 0 };
	if (percentage === null) return { speeds, current: null };
	return { speeds, current: Math.min(speeds, Math.max(1, Math.round(percentage / step))) };
}

/**
 * The percentage that puts a fan with `speeds` speeds on `level`. Home Assistant rounds a
 * percentage up to the next speed, so this rounds down: 66 is speed 2 of 3, 67 would be speed 3.
 */
export const percentageForLevel = (level: number, speeds: number) =>
	Math.floor((level * 100) / speeds);
