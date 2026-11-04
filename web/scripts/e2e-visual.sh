#!/usr/bin/env bash
# The screenshot checks (`e2e/visual.spec.ts`) in CI's own Playwright image, so the images match the ones CI
# compares against wherever this runs: `pnpm test:e2e:visual`, or `pnpm test:e2e:visual --update-snapshots`
# after a change that's meant to show. The image's Node can be newer than the one pinned (only the browser's pixels
# matter here), and newer images have no corepack, so it's installed when it's missing. Linux's node_modules and pnpm's
# store stay in Docker volumes of their own.
set -euo pipefail
cd "$(dirname "$0")/../.."
version=$(node -p "require('./web/package.json').devDependencies['@playwright/test']")
exec docker run --rm --ipc=host \
    -v "$PWD":/w -v orrery-e2e-modules:/w/node_modules -v orrery-e2e-web-modules:/w/web/node_modules -v orrery-e2e-store:/store \
    -e npm_config_store_dir=/store -e NODE_COMPILE_CACHE=/tmp/node-compile-cache -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e npm_config_engine_strict=false -w /w \
    "mcr.microsoft.com/playwright:v$version-noble" \
    bash -c '(command -v corepack >/dev/null || npm i -g --silent --force corepack) && corepack enable && pnpm install --frozen-lockfile --silent && cd web && pnpm exec playwright test e2e/visual.spec.ts "$@"' -- "$@"
