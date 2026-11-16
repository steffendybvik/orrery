#!/usr/bin/env bash
# The screenshot checks (`e2e/visual.spec.ts`) in CI's own Playwright image, so the images match the ones CI
# compares against wherever this runs: `pnpm test:e2e:visual`, or `pnpm test:e2e:visual --update-snapshots`
# after a change that's meant to show. The image's Node can be newer than the one pinned (only the browser's pixels
# matter here), and newer images have no corepack, so it's installed when it's missing. Linux's node_modules and pnpm's
# store stay in Docker volumes of their own.
# The server needs the Rust API (ORR-1196), and Playwright's image has no Rust, so a Linux build of it is made first in
# Rust's image, into a volume of its own (quick once built), and handed over as NUXT_API_BIN, as CI hands its jobs one.
set -euo pipefail
cd "$(dirname "$0")/../.."
version=$(node -p "require('./web/package.json').devDependencies['@playwright/test']")
docker run --rm -v "$PWD":/w:ro -v orrery-e2e-cargo:/usr/local/cargo/registry -v orrery-e2e-api:/target \
    -e CARGO_TARGET_DIR=/target -w /w/api rust:1 cargo build --locked --quiet
exec docker run --rm --ipc=host \
    -v "$PWD":/w -v orrery-e2e-modules:/w/node_modules -v orrery-e2e-web-modules:/w/web/node_modules -v orrery-e2e-store:/store \
    -v orrery-e2e-api:/api-target:ro -e NUXT_API_BIN=/api-target/debug/orrery-api \
    -e npm_config_store_dir=/store -e NODE_COMPILE_CACHE=/tmp/node-compile-cache -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e npm_config_engine_strict=false -w /w \
    "mcr.microsoft.com/playwright:v$version-noble" \
    bash -c '(command -v corepack >/dev/null || npm i -g --silent --force corepack) && corepack enable && pnpm install --frozen-lockfile --silent && cd web && pnpm exec playwright test e2e/visual.spec.ts "$@"' -- "$@"
