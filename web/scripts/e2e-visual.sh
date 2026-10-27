#!/usr/bin/env bash
# The screenshot checks (`e2e/visual.spec.ts`) in CI's own Playwright image, so the images match the ones CI
# compares against wherever this runs: `pnpm test:e2e:visual`, or `pnpm test:e2e:visual --update-snapshots`
# after a change that's meant to show. Linux's node_modules and pnpm's store stay in Docker volumes of their own.
set -euo pipefail
cd "$(dirname "$0")/../.."
version=$(node -p "require('./web/package.json').devDependencies['@playwright/test']")
exec docker run --rm --ipc=host \
    -v "$PWD":/w -v orrery-e2e-modules:/w/node_modules -v orrery-e2e-web-modules:/w/web/node_modules -v orrery-e2e-store:/store \
    -e npm_config_store_dir=/store -e NODE_COMPILE_CACHE=/tmp/node-compile-cache -w /w \
    "mcr.microsoft.com/playwright:v$version-noble" \
    bash -c 'corepack enable && pnpm install --frozen-lockfile --silent && cd web && pnpm exec playwright test e2e/visual.spec.ts "$@"' -- "$@"
