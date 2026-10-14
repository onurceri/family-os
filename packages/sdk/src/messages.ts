/** Translatable texts: keys to strings, nested as in the JSON catalog files. */
export interface MessageCatalog {
	readonly [key: string]: string | MessageCatalog;
}

/**
 * An extension's texts, by language code: its English catalog (`src/messages/en.json`, the one
 * every key must be in) and the translations it ships (`src/messages/<code>.json`). They are
 * registered under the extension's id, so a key reads `<id>:<key>`. A language pack's strings
 * win over the extension's own translation; whatever neither has shows in English.
 */
export interface ExtensionMessages {
	readonly en: MessageCatalog;
	readonly [language: string]: MessageCatalog;
}
