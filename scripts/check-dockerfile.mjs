// Fails if a workspace package's package.json is not copied in docker/Dockerfile's dependency
// layer (the image build would break or install an incomplete workspace). Run by `pnpm lint`.
import { readdirSync, readFileSync } from 'node:fs';

const dockerfile = readFileSync('docker/Dockerfile', 'utf8');
const missing = [];
for (const group of ['apps', 'packages', 'extensions']) {
	let dirs = [];
	try {
		dirs = readdirSync(group, { withFileTypes: true }).filter((d) => d.isDirectory());
	} catch {
		continue;
	}
	for (const dir of dirs) {
		const manifest = `${group}/${dir.name}/package.json`;
		try {
			readFileSync(manifest);
		} catch {
			continue;
		}
		if (!dockerfile.includes(`COPY ${manifest} ${group}/${dir.name}/`)) missing.push(manifest);
	}
}
// Bundled language packs must ship in the image.
if (!/COPY --from=build \/repo\/languages \.\/languages/.test(dockerfile)) {
	missing.push('languages/ (COPY --from=build /repo/languages ./languages)');
}
// Bundled theme packs must ship in the image.
if (!/COPY --from=build \/repo\/themes \.\/themes/.test(dockerfile)) {
	missing.push('themes/ (COPY --from=build /repo/themes ./themes)');
}
// The server finds its extension packages only beside its bundle (/app/server → /app/extensions).
if (!/COPY --from=build \/repo\/apps\/server\/dist \.\/server/.test(dockerfile)) {
	missing.push('the server bundle (COPY --from=build /repo/apps/server/dist ./server)');
}
if (!/COPY --from=build \/repo\/dist\/extensions \.\/extensions/.test(dockerfile)) {
	missing.push('dist/extensions/ (COPY --from=build /repo/dist/extensions ./extensions)');
}
// The supervisor is the entry point, so a restart the app asks for starts the server again.
if (!dockerfile.includes('ENTRYPOINT ["node", "--enable-source-maps", "/app/server/famos.mjs"]')) {
	missing.push('the supervisor as the entry point (ENTRYPOINT … /app/server/famos.mjs)');
}
if (
	!dockerfile.includes('pnpm --filter "./extensions/*" build') ||
	!dockerfile.includes('node scripts/collect-extensions.mjs')
) {
	missing.push(
		'the extension packages (built with famos-pack, then node scripts/collect-extensions.mjs)',
	);
}
// One source for the pnpm version: package.json's packageManager, which corepack reads.
if (/pnpm@\d/.test(dockerfile) || !/^RUN corepack enable$/m.test(dockerfile)) {
	missing.push('pnpm from package.json (RUN corepack enable, no pnpm@<version> in the Dockerfile)');
}
// The native modules come from the lockfile, in the build stage, then `npm ci` per architecture.
if (
	!dockerfile.includes('node scripts/runtime-lock.mjs /repo/runtime') ||
	!dockerfile.includes('npm ci --omit=dev') ||
	/npm install --omit/.test(dockerfile)
) {
	missing.push('the locked native modules (node scripts/runtime-lock.mjs, then npm ci --omit=dev)');
}
// The health check script is what HEALTHCHECK runs.
if (
	!dockerfile.includes('COPY docker/healthcheck.mjs ./healthcheck.mjs') ||
	!dockerfile.includes('CMD ["node", "/app/healthcheck.mjs"]')
) {
	missing.push(
		'the health check (COPY docker/healthcheck.mjs, HEALTHCHECK … /app/healthcheck.mjs)',
	);
}
if (missing.length > 0) {
	console.error(`docker/Dockerfile does not copy: ${missing.join(', ')}`);
	process.exit(1);
}
console.log(
	'✔ Dockerfile copies every workspace package manifest, the language, theme and extension packs',
);
