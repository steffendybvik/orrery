// What outlives a restart (`pnpm test:e2e:restart`): the built app on a database made fresh for the run, which
// e2e/restart/ stops and starts itself, as a rebuild or a container restart does, so it has no webServer here. It
// listens on loopback, as an orrery on all addresses asks for a login. RESTART_NO_BUILD=1 runs the build already in
// .output, for trying again quickly.
import {defineConfig, devices} from '@playwright/test'

export default defineConfig({
    testDir: 'e2e/restart',
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    timeout: 120_000,
    reporter: 'list',
    outputDir: 'test-results-restart',
    use: {trace: 'retain-on-failure', ...devices['Desktop Chrome']},
})
