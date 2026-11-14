# orrery on http://localhost:9000. The database lives in /data (a volume), so it outlasts the container.
# Two images, each with orrery's Rust API inside, which the server starts beside itself (ORR-1041): `dev` (the
# playground's) serves the repo mounted at /src with `nuxt dev`, so a change shows as soon as it's saved; `prod` (the
# last stage, so the default) is the built app.

# The Rust API's binary (ORR-922, api/). Bookworm, as the node images are, so it runs on their glibc.
FROM rust:1-bookworm AS api
WORKDIR /src/api
# It builds in the presets orrery ships (src/presets.rs), so that file comes with it.
COPY web/shared/presets.json /src/web/shared/presets.json
COPY docs/using.md /src/docs/using.md
COPY web/package.json /src/web/package.json
COPY api/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/api/target \
    cargo build --release --locked && cp target/release/orrery-api /orrery-api

# dev: the repo comes in as a mount, and the app runs from web/. node_modules (Linux binaries, e.g.
# Tailwind's) and web/.nuxt (paths inside the container) are volumes of its own, so they don't clash with the Mac's.
FROM node:24.22.1-bookworm-slim AS dev
RUN npm install -g pnpm@10.14.0
WORKDIR /src
RUN mkdir -p /src/node_modules /src/web/node_modules /src/web/.nuxt /data /backup && chown -R node:node /src /data /backup
# The Rust API, built from this checkout as the image is built, which the server starts beside itself (ORR-1041): the
# repo's own api/target is the host's build, not this one's.
COPY --from=api /orrery-api /usr/local/bin/orrery-api
USER node
# pnpm's store sits in the node_modules volume, so a new container reinstalls without downloading.
ENV HOST=0.0.0.0 PORT=9000 ORRERY_IMAGE=1 NUXT_DATABASE=/data/orrery.db NUXT_API_BIN=/usr/local/bin/orrery-api npm_config_store_dir=/src/node_modules/.pnpm-store
VOLUME /data
EXPOSE 9000
CMD ["sh", "-c", "pnpm install --frozen-lockfile && cd web && exec pnpm exec nuxt dev --host 0.0.0.0 --port 9000"]


FROM node:24.22.1-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build

FROM node:24.22.1-bookworm-slim AS prod
COPY --from=build /src/web/.output /app
COPY web/scripts/claim.mjs /app/server/claim.mjs
# The Rust API, which serves the board's data now that the Nuxt server's routes for it are gone (ORR-1041): the server
# starts it beside itself on its own database (NUXT_API_BIN).
COPY --from=api /orrery-api /usr/local/bin/orrery-api
RUN mkdir /data /backup && chown node:node /data /backup
USER node
ENV HOST=0.0.0.0 PORT=9000 ORRERY_IMAGE=1 NODE_ENV=production NUXT_DATABASE=/data/orrery.db NUXT_API_BIN=/usr/local/bin/orrery-api
VOLUME /data
EXPOSE 9000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:9000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "/app/server/index.mjs"]
