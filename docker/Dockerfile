# syntax=docker/dockerfile:1.7
# FamilyOS: one image for amd64 and arm64. Debian slim, not Alpine (native modules on Pi).
ARG NODE_VERSION=24

# The build stage only makes architecture-independent output (the web app, the bundled server and
# the packs; native better-sqlite3 stays external), so it runs once on the builder's own platform
# instead of under emulation for each target. Only the runtime stage is built per architecture.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /repo
# Install dependencies first for better layer caching.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
# The pnpm version is the one package.json's packageManager names, the single place to change it.
RUN corepack enable
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/e2e/package.json apps/e2e/
COPY packages/sdk/package.json packages/sdk/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/adapters/package.json packages/adapters/
COPY packages/testing/package.json packages/testing/
COPY packages/ui/package.json packages/ui/
COPY packages/api-client/package.json packages/api-client/
COPY packages/i18n/package.json packages/i18n/
COPY packages/time/package.json packages/time/
COPY packages/themes/package.json packages/themes/
COPY packages/pack/package.json packages/pack/
COPY extensions/ambient/package.json extensions/ambient/
COPY extensions/assistant/package.json extensions/assistant/
COPY extensions/board/package.json extensions/board/
COPY extensions/calendar/package.json extensions/calendar/
COPY extensions/chores/package.json extensions/chores/
COPY extensions/lists/package.json extensions/lists/
COPY extensions/home/package.json extensions/home/
COPY extensions/homeassistant/package.json extensions/homeassistant/
COPY extensions/inbox/package.json extensions/inbox/
COPY extensions/kitchen/package.json extensions/kitchen/
COPY extensions/pets/package.json extensions/pets/
COPY extensions/records/package.json extensions/records/
COPY extensions/vehicles/package.json extensions/vehicles/
RUN pnpm install --frozen-lockfile
COPY . .
# The web app, the server, and every extension package gathered into dist/extensions.
RUN pnpm --filter @famos/web build && pnpm --filter @famos/server build \
  && pnpm --filter "./extensions/*" build && node scripts/collect-extensions.mjs
# The bundle keeps native better-sqlite3 external: its exact locked version and hash, as an npm lockfile.
RUN node scripts/runtime-lock.mjs /repo/runtime

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    FAMOS_DATA_DIR=/data \
    FAMOS_WEB_DIR=/app/web \
    PORT=3000
WORKDIR /app
# Installed here, per target architecture, from the build stage's lockfile (not from the registry's latest).
# better-sqlite3 ships its compiled binaries in the package, so no install script runs (npm ci would
# otherwise try to compile it from source); the module is then opened once so a missing binary fails the build.
# The server never runs npm, so npm, npx and corepack leave the image with their own dependencies.
COPY --from=build /repo/runtime/ ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force \
  && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()" \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /root/.npm
COPY --from=build /repo/apps/server/dist ./server
COPY docker/healthcheck.mjs ./healthcheck.mjs
COPY --from=build /repo/apps/web/build ./web
# Extension packages shipped with the app, found next to the server bundle (/app/server → /app/extensions).
COPY --from=build /repo/dist/extensions ./extensions
# Language packs shipped with the app; installed ones live in the data volume.
COPY --from=build /repo/languages ./languages
# Theme packs shipped with the app; installed ones live in the data volume.
COPY --from=build /repo/themes ./themes
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
# Asks /health, or for a worker-only container (FAMOS_ROLES=worker) checks its heartbeat file.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "/app/healthcheck.mjs"]
# The supervisor: runs `serve` and starts it again when it asks to (after installing an extension);
# other commands run directly. `node /app/server/main.mjs <command>` works as well.
ENTRYPOINT ["node", "--enable-source-maps", "/app/server/famos.mjs"]
CMD ["serve"]
