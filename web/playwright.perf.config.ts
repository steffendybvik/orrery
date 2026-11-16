// How fast Orrery is with a lot in it (`pnpm test:e2e:perf`): the built app runs on a fresh database (a SQLite file, or
// with E2E_POSTGRES_URL that Postgres, emptied first), with the Rust API beside it as a real Orrery has (NUXT_API_BIN:
// CI's `api` job's, else the repo's debug build, built first). Then the `seed` project fills it over HTTP
// (e2e/perf/seed.setup.ts, ORR-1240), and e2e/perf/perf.spec.ts times its pages against their budgets. It listens on loopback, as an orrery on all addresses asks
// for a login. The report lands in perf-report/. The seed's sizes are PERF_* variables (see seed.ts); PERF_NO_BUILD=1
// runs the build already in .output, for trying again quickly.
import {fileURLToPath} from 'node:url'
import {defineConfig, devices} from '@playwright/test'
import {e2ePort} from './e2e-port'
import {apiBuild, serverTimeout} from './e2e-api'

const port = e2ePort(3400)
const postgres = process.env.E2E_POSTGRES_URL
const database = postgres || '.data/perf.db'
// The API the built server starts beside itself, as the image's does; built first unless one is named.
const build = apiBuild
process.env.NUXT_API_BIN ||= fileURLToPath(new URL('../api/target/debug/orrery-api', import.meta.url))
// Where the seed writes its bulk rows: the database the server runs on.
process.env.PERF_DATABASE = database

export default defineConfig({
    testDir: 'e2e/perf',
    projects: [
        {name: 'seed', testMatch: 'seed.setup.ts'},
        {name: 'perf', testMatch: 'perf.spec.ts', dependencies: ['seed'], use: devices['Desktop Chrome']},
    ],
    workers: 1,
    retries: 0,
    timeout: 120_000,
    reporter: process.env.CI ? [['list'], ['html', {open: 'never'}]] : 'list',
    use: {baseURL: `http://localhost:${port}`, trace: 'retain-on-failure', ...devices['Desktop Chrome']},
    webServer: {
        command: [
            postgres ? 'jiti scripts/e2e-postgres.ts' : 'rm -f .data/perf.db .data/perf.db-*',
            ...process.env.PERF_NO_BUILD ? [] : [`${build}nuxt build`],
            'node .output/server/index.mjs',
        ].join(' && '),
        env: {NUXT_DATABASE: database, NUXT_UPDATE_CHECK: 'false', PORT: String(port), NITRO_HOST: '127.0.0.1', NUXT_API_BIN: process.env.NUXT_API_BIN},
        url: `http://localhost:${port}/api/settings`,
        reuseExistingServer: false,
        timeout: serverTimeout(600_000),
        stdout: 'pipe',
    },
})
