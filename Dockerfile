# Orrery on http://localhost:9000. The database lives in /data (a volume), so it outlasts the container.
# Two images: `dev` (what compose runs) serves the repo mounted at /src with `nuxt dev`, so a change shows
# as soon as it's saved; `prod` (the last stage, so the default) is the built app.

# dev: the repo comes in as a mount, and the app runs from web/. node_modules (Linux binaries, e.g.
# Tailwind's) and web/.nuxt (paths inside the container) are volumes of its own, so they don't clash with the Mac's.
FROM node:24.22.1-bookworm-slim AS dev
RUN npm install -g pnpm@10.14.0
WORKDIR /src
RUN mkdir -p /src/node_modules /src/web/node_modules /src/web/.nuxt /data /backup && chown -R node:node /src /data /backup
USER node
# pnpm's store sits in the node_modules volume, so a new container reinstalls without downloading.
ENV HOST=0.0.0.0 PORT=9000 NUXT_DATABASE=/data/orrery.db npm_config_store_dir=/src/node_modules/.pnpm-store
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
RUN mkdir /data /backup && chown node:node /data /backup
USER node
ENV HOST=0.0.0.0 PORT=9000 NODE_ENV=production NUXT_DATABASE=/data/orrery.db
VOLUME /data
EXPOSE 9000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:9000/api/projects').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "/app/server/index.mjs"]
