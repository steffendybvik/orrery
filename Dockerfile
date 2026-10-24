# Orrery on http://localhost:9000. The database lives in /data (a volume), so it outlasts the container.
FROM node:24.22.1-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build

FROM node:24.22.1-bookworm-slim
COPY --from=build /src/.output /app
RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=9000 NODE_ENV=production NUXT_DATABASE=/data/orrery.db
VOLUME /data
EXPOSE 9000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:9000/api/projects').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "/app/server/index.mjs"]
