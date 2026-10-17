/**
 * The address of a Home Assistant, as a family types it and as it is stored: the base every
 * request is built from. Home Assistant is sometimes served under a path by a reverse proxy, so a
 * path stays; `/api` at the end is what people copy from Home Assistant's own documentation and is
 * not part of the base.
 */
export interface BaseUrl {
	/** What is stored and requested: no trailing slash, no `/api`. */
	readonly url: string;
	readonly scheme: 'http' | 'https';
	readonly host: string;
	readonly port: number | null;
	/** Starts with `/`; null when Home Assistant is at the root. */
	readonly path: string | null;
}

const MAX_LENGTH = 2000;

/** The normalized address, or null when it is not an http(s) address of the shape described above. */
export function normalizeBaseUrl(raw: string): BaseUrl | null {
	const text = raw.trim();
	// A query or a fragment (even an empty one) means this is not the base of a server.
	if (!text || text.length > MAX_LENGTH || /[\s?#]/.test(text)) return null;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (url.username || url.password || !url.hostname) return null;
	let path = url.pathname.replace(/\/+$/, '');
	if (/\/api$/i.test(path)) path = path.slice(0, -4).replace(/\/+$/, '');
	const scheme = url.protocol === 'https:' ? 'https' : 'http';
	return {
		url: `${scheme}://${url.host}${path}`,
		scheme,
		host: url.hostname,
		port: url.port ? Number(url.port) : null,
		path: path || null,
	};
}
