// The main flows in a real browser (`pnpm test:e2e`): `nuxt dev` on a port of its own, with a database
// made fresh for each run, so the tests start from an empty Orrery whose owner has no name yet. A SQLite
// file by default; with E2E_POSTGRES_URL (a database named for it, `orrery_e2e`), that Postgres, emptied first.
import {defineConfig, devices} from '@playwright/test'

const port = 3199
const postgres = process.env.E2E_POSTGRES_URL

export default defineConfig({
    testDir: 'e2e',
    // One Orrery, one story: the flows build on each other. Files run in name order, and flows.spec.ts expects an
    // owner with no name yet, so a spec that names one must sort after it.
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', {open: 'never'}]] : 'list',
    use: {baseURL: `http://localhost:${port}`, trace: 'retain-on-failure'},
    projects: [{name: 'chromium', use: devices['Desktop Chrome']}],
    webServer: {
        command: `${postgres ? 'jiti scripts/e2e-postgres.ts' : 'rm -f .data/e2e.db .data/e2e.db-*'} && nuxt dev --port ${port}`,
        env: {NUXT_DATABASE: postgres || '.data/e2e.db', NUXT_BACKUP_DIR: ''},
        url: `http://localhost:${port}/api/settings`,
        reuseExistingServer: false,
        timeout: 180_000,
    },
})
