// How fast Orrery is with a lot in it (`pnpm test:e2e:perf`): e2e/perf/seed.ts fills a fresh database (a SQLite file,
// or with E2E_POSTGRES_URL that Postgres, emptied first), then the built app runs on it, as a real Orrery does, and
// e2e/perf/perf.spec.ts times its pages against their budgets. The report lands in perf-report/. The seed's sizes are
// PERF_* variables (see seed.ts); PERF_NO_BUILD=1 runs the build already in .output, for trying again quickly.
import {fileURLToPath} from 'node:url'
import {defineConfig, devices} from '@playwright/test'

const port = 3398
const postgres = process.env.E2E_POSTGRES_URL
const database = postgres || '.data/perf.db'
const shared = fileURLToPath(new URL('./shared', import.meta.url))

export default defineConfig({
    testDir: 'e2e/perf',
    workers: 1,
    retries: 0,
    timeout: 120_000,
    reporter: process.env.CI ? [['list'], ['html', {open: 'never'}]] : 'list',
    use: {baseURL: `http://localhost:${port}`, trace: 'retain-on-failure', ...devices['Desktop Chrome']},
    webServer: {
        command: [
            postgres ? 'jiti scripts/e2e-postgres.ts' : 'rm -f .data/perf.db .data/perf.db-* .data/perf.db.backups.json',
            `jiti e2e/perf/seed.ts ${database}`,
            ...process.env.PERF_NO_BUILD ? [] : ['nuxt build'],
            'node .output/server/index.mjs',
        ].join(' && '),
        env: {NUXT_DATABASE: database, NUXT_BACKUP_DIR: '', PORT: String(port), JITI_ALIAS: JSON.stringify({'#shared': shared})},
        url: `http://localhost:${port}/api/settings`,
        reuseExistingServer: false,
        timeout: 600_000,
        stdout: 'pipe',
    },
})
