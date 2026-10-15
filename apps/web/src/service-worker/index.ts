import { version } from '$app/env';
import { assets, immutable } from '$app/manifest';
import { self } from '$app/service-worker';

/**
 * Offline shell + Web Share Target.
 * - Precaches build output, static files and the SPA fallback page.
 * - Caches API calls only for a short allow-list of read routes: network first, and
 *   the last copy when offline, flagged with `x-famos-offline`. Writes, auth, files and every
 *   other route are never cached; the server stays the source of truth. The copy is dropped on
 *   sign-out (message `CLEAR_API_CACHE`).
 * - Keeps the extension packages' files (`/extensions/<id>/<digest>/…`) once the app names them
 *   after it opened (message `CACHE_EXTENSIONS`), and serves them from that copy first: their
 *   address changes with every build, so a copy is never stale. Files of packages the app no
 *   longer names are dropped. Each page the server answers refreshes the cached shell, which
 *   names the packages and maps the modules they share, so an offline start opens what the
 *   server last ran.
 * - Intercepts share-target POSTs, stores them, and redirects to /share.
 */
const CACHE = `famos-${version}`;
const SHARE_CACHE = 'famos-share-target';
/** Last-seen copies of the allow-listed reads. Not versioned: it survives app updates. */
const API_CACHE = 'famos-api-reads';
/** The extension packages' files. Not versioned: addressed by digest, they outlive app updates. */
const EXTENSIONS_CACHE = 'famos-extensions';
const EXTENSION_FILES = '/extensions/';
/**
 * The only API reads kept for offline use: what the app needs to open (who am I, members,
 * family settings), Today's calendar, the shopping lists and items, tasks and chores. The
 * server marks every API response `no-store` for browsers and proxies; this private copy is
 * the one deliberate exception, limited to these paths.
 */
const OFFLINE_READS = [
	/^\/api\/v1\/core\/(me|setup|members|settings\/family)$/,
	/^\/api\/v1\/calendar\/occurrences$/,
	/^\/api\/v1\/lists\/tasks$/,
	/^\/api\/v1\/lists\/shopping\/lists(\/[^/]+\/items)?$/,
	/^\/api\/v1\/chores\/chores$/,
];
/** Without an answer after this long, a cached copy is shown (the network keeps trying). */
const SLOW_NETWORK_MS = 5000;
const toPath = (p: string) => new URL(p, self.registration.scope).pathname;
const SHELL = toPath('index.html');
const ASSETS: string[] = [...immutable, ...assets].map((a) => toPath(a.path)).concat(SHELL);

self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter(
							(k) => k !== CACHE && k !== SHARE_CACHE && k !== API_CACHE && k !== EXTENSIONS_CACHE,
						)
						.map((k) => caches.delete(k)),
				),
			),
	);
});

self.addEventListener('message', (event) => {
	if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
	// The page asks which app this worker serves, so it reloads only when it runs an older one.
	if (event.data?.type === 'VERSION') event.ports[0]?.postMessage(version);
	if (event.data?.type === 'CLEAR_API_CACHE') event.waitUntil(caches.delete(API_CACHE));
	if (event.data?.type === 'CACHE_EXTENSIONS') event.waitUntil(keepExtensions(event.data.files));
});

/**
 * Keeps exactly the extension files the app names: drops the others (older builds, removed
 * packages) and fetches the missing ones. A file that cannot be fetched now is tried again the
 * next time the app opens.
 */
async function keepExtensions(files: unknown): Promise<void> {
	if (!Array.isArray(files)) return;
	const wanted = new Set(
		files.filter((f): f is string => typeof f === 'string' && f.startsWith(EXTENSION_FILES)),
	);
	const cache = await caches.open(EXTENSIONS_CACHE);
	const held = new Set<string>();
	for (const request of await cache.keys()) {
		const path = new URL(request.url).pathname;
		if (wanted.has(path)) held.add(path);
		else await cache.delete(request);
	}
	await Promise.all(
		[...wanted]
			.filter((path) => !held.has(path))
			.map(async (path) => {
				const response = await fetch(path).catch(() => undefined);
				if (response?.ok) await cache.put(path, response);
			}),
	);
}

/** From the kept copy first; a file not kept yet comes from the network and is kept. */
async function handleExtensionFile(request: Request): Promise<Response> {
	const cache = await caches.open(EXTENSIONS_CACHE);
	const path = new URL(request.url).pathname;
	const cached = await cache.match(path);
	if (cached) return cached;
	const response = await fetch(request);
	if (response.ok) await cache.put(path, response.clone());
	return response;
}

/** Network first; the last copy when there is no answer (or a slow one), marked as old. */
async function handleRead(event: FetchEvent): Promise<Response> {
	const { request } = event;
	const cache = await caches.open(API_CACHE);
	const fresh = fetch(request).then(async (response) => {
		// Only complete, successful answers replace the copy (never a 401 after sign-out).
		if (response.status === 200) await cache.put(request.url, response.clone());
		return response;
	});
	fresh.catch(() => {}); // a late failure after a cached answer was shown is not an error
	const fromCache = async (): Promise<Response | undefined> => {
		const cached = await cache.match(request.url);
		if (!cached) return undefined;
		const headers = new Headers(cached.headers);
		headers.set('x-famos-offline', '1');
		const client = event.clientId ? await self.clients.get(event.clientId) : undefined;
		client?.postMessage({ type: 'FAMOS_SERVED_OFFLINE' });
		return new Response(cached.body, {
			status: cached.status,
			statusText: cached.statusText,
			headers,
		});
	};
	try {
		const slow = new Promise<'slow'>((resolve) =>
			setTimeout(() => resolve('slow'), SLOW_NETWORK_MS),
		);
		const first = await Promise.race([fresh, slow]);
		if (first !== 'slow') return first;
		return (await fromCache()) ?? (await fresh);
	} catch (error) {
		const cached = await fromCache();
		if (cached) return cached;
		throw error;
	}
}

async function handleShare(request: Request): Promise<Response> {
	const form = await request.formData();
	const cache = await caches.open(SHARE_CACHE);
	const files = form.getAll('files').filter((f): f is File => f instanceof File);
	const meta = {
		title: form.get('title')?.toString() ?? null,
		text: form.get('text')?.toString() ?? null,
		url: form.get('url')?.toString() ?? null,
		files: files.map((f, i) => ({
			key: `/__share/file/${i}`,
			name: f.name,
			type: f.type,
			size: f.size,
		})),
		at: Date.now(),
	};
	await Promise.all(
		files.map((f, i) =>
			cache.put(`/__share/file/${i}`, new Response(f, { headers: { 'content-type': f.type } })),
		),
	);
	await cache.put(
		'/__share/meta',
		new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }),
	);
	return Response.redirect('/share', 303);
}

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin) return;
	if (event.request.method === 'POST' && url.pathname === '/share-target') {
		event.respondWith(handleShare(event.request));
		return;
	}
	if (event.request.method === 'GET' && OFFLINE_READS.some((re) => re.test(url.pathname))) {
		event.respondWith(handleRead(event));
		return;
	}
	if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
	if (url.pathname.startsWith(EXTENSION_FILES)) {
		event.respondWith(handleExtensionFile(event.request));
		return;
	}

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);
			if (ASSETS.includes(url.pathname)) {
				const cached = await cache.match(url.pathname);
				if (cached) return cached;
			}
			try {
				const response = await fetch(event.request);
				// Every page is the shell; the newest one names what the server runs now.
				if (event.request.mode === 'navigate' && response.ok && isHtml(response))
					event.waitUntil(cache.put(SHELL, response.clone()));
				return response;
			} catch (error) {
				const fallback =
					event.request.mode === 'navigate'
						? await cache.match(SHELL)
						: await cache.match(event.request);
				if (fallback) return fallback;
				throw error;
			}
		})(),
	);
});

const isHtml = (response: Response) =>
	response.headers.get('content-type')?.startsWith('text/html') === true;

/**
 * Web Push. Safari requires a visible notification for every push, so one is always
 * shown, even when the payload cannot be read.
 */
self.addEventListener('push', (event) => {
	let title = 'FamilyOS';
	let body: string | undefined;
	let tag: string | undefined;
	let url = '/notifications';
	try {
		const data = event.data?.json() as
			| { title?: string; body?: string | null; url?: string | null; tag?: string }
			| undefined;
		if (data?.title) title = data.title;
		if (data?.body) body = data.body;
		if (data?.tag) tag = data.tag;
		// Only paths inside the app.
		if (data?.url?.startsWith('/') && !data.url.startsWith('//')) url = data.url;
	} catch {
		// Keep the fallback title.
	}
	event.waitUntil(
		self.registration.showNotification(title, {
			...(body && { body }),
			...(tag && { tag }),
			data: { url },
			icon: '/icon-192.png',
		}),
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = new URL(
		(event.notification.data as { url?: string } | null)?.url ?? '/notifications',
		self.location.origin,
	).href;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
			if (open) {
				await open.focus();
				await open.navigate(url).catch(() => undefined);
			} else {
				await self.clients.openWindow(url);
			}
		})(),
	);
});
