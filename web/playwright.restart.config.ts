// What outlives a restart (`pnpm test:e2e:restart`): the built app on a database made fresh for the run, which
// e2e/restart/ stops and starts itself, as a rebuild or a container restart does, so it has no webServer here. It
// listens on loopback, as an orrery on all addresses asks for a login. RESTART_NO_BUILD=1 runs the build already in
// .output (and the API already built), for trying again quickly.
import {fileURLToPath} from 'node:url'
import {defineConfig, devices} from '@playwright/test'

// The Rust API the built app starts beside itself, as the image's NUXT_API_BIN does: the repo's debug build, which
// `test:e2e:restart` builds first, unless one is named. Without it every route that's the API's alone answers 503.
process.env.NUXT_API_BIN ||= fileURLToPath(new URL('../api/target/debug/orrery-api', import.meta.url))

export default defineConfig({
    testDir: 'e2e/restart',
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    timeout: 120_000,
    reporter: 'list',
    outputDir: 'test-results-restart',
    use: {trace: 'retain-on-failure', ...devices['Desktop Chrome']},
})
