// The main flows in a real browser (`pnpm test:e2e`): `nuxt dev` on a port of its own (one per checkout, e2e-port.ts),
// with a database made fresh for each run, so the tests start from an empty orrery whose owner has no name yet. A SQLite
// file by default; with E2E_POSTGRES_URL (a database named for it, `orrery_e2e`), that Postgres, emptied first.
import {defineConfig, devices} from '@playwright/test'
import {e2ePort} from './e2e-port'

const port = e2ePort(3100)
const postgres = process.env.E2E_POSTGRES_URL

export default defineConfig({
    testDir: 'e2e',
    // One orrery for every file, one at a time. first-run.spec.ts opens it fresh, with an owner who has no name yet,
    // so it runs first, as a Playwright project the rest depend on; each of them then makes an orrery project of its own.
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', {open: 'never'}], ['json', {outputFile: 'e2e-results.json'}]] : 'list',
    use: {baseURL: `http://localhost:${port}`, trace: 'retain-on-failure'},
    projects: [
        {name: 'first-run', testMatch: 'first-run.spec.ts', use: devices['Desktop Chrome']},
        {name: 'chromium', testIgnore: ['first-run.spec.ts', 'perf/**', 'login/**'], dependencies: ['first-run'], use: devices['Desktop Chrome']},
    ],
    webServer: {
        command: `${postgres ? 'jiti scripts/e2e-postgres.ts' : 'rm -f .data/e2e.db .data/e2e.db-* .data/e2e.db.backups.json .data/e2e-moved-*.db'} && nuxt dev --port ${port}`,
        env: {NUXT_DATABASE: postgres || '.data/e2e.db', NUXT_BACKUP_DIR: '', NUXT_UPDATE_CHECK: 'false', ORRERY_AUTH: 'off'},
        url: `http://localhost:${port}/api/settings`,
        reuseExistingServer: false,
        timeout: 180_000,
    },
})
