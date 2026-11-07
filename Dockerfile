# orrery on http://localhost:9000. The database lives in /data (a volume), so it outlasts the container.
# Three images: `dev` (what compose runs) serves the repo mounted at /src with `nuxt dev`, so a change shows
# as soon as it's saved; `rust-api` is the Rust API alone, the playground's `api` container (ORR-1051); `prod` (the
# last stage, so the default) is the built app.

# dev: the repo comes in as a mount, and the app runs from web/. node_modules (Linux binaries, e.g.
# Tailwind's) and web/.nuxt (paths inside the container) are volumes of its own, so they don't clash with the Mac's.
FROM node:24.22.1-bookworm-slim AS dev
RUN npm install -g pnpm@10.14.0
WORKDIR /src
RUN mkdir -p /src/node_modules /src/web/node_modules /src/web/.nuxt /data /backup && chown -R node:node /src /data /backup
USER node
# pnpm's store sits in the node_modules volume, so a new container reinstalls without downloading.
ENV HOST=0.0.0.0 PORT=9000 ORRERY_IMAGE=1 NUXT_DATABASE=/data/orrery.db npm_config_store_dir=/src/node_modules/.pnpm-store
VOLUME /data
EXPOSE 9000
CMD ["sh", "-c", "pnpm install --frozen-lockfile && cd web && exec pnpm exec nuxt dev --host 0.0.0.0 --port 9000"]

# The Rust API's binary (ORR-922, api/). Bookworm, as the node images are, so it runs on their glibc.
FROM rust:1-bookworm AS api
WORKDIR /src/api
# It builds in the presets orrery ships (src/presets.rs), so that file comes with it.
COPY web/shared/presets.json /src/web/shared/presets.json
COPY api/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/api/target \
    cargo build --release --locked && cp target/release/orrery-api /orrery-api

# rust-api: the Rust API in a container of its own (ORR-1051), on the Nuxt server's database in /data. Only the
# playground runs it (docker-compose.api.yml, with ORRERY_RUST_API=1 in .playground/compose.env). It listens on the
# compose network, where only a request carrying the token both are given is answered. Uid 1000, as `dev`'s node user,
# so the files it makes in /data are the same owner's.
FROM debian:bookworm-slim AS rust-api
COPY --from=api /orrery-api /usr/local/bin/orrery-api
USER 1000:1000
ENV NUXT_DATABASE=/data/orrery.db ORRERY_API_LISTEN=0.0.0.0:9100 ORRERY_API_WAIT=1
EXPOSE 9100
CMD ["orrery-api"]

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
RUN mkdir /data /backup && chown node:node /data /backup
USER node
ENV HOST=0.0.0.0 PORT=9000 ORRERY_IMAGE=1 NODE_ENV=production NUXT_DATABASE=/data/orrery.db
VOLUME /data
EXPOSE 9000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:9000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "/app/server/index.mjs"]
