// The main flows in a real browser (`pnpm test:e2e`): `nuxt dev` on a port of its own (one per checkout, e2e-port.ts),
// with a database made fresh for each run, so the tests start from an empty orrery whose owner has no name yet. A SQLite
// file by default; with E2E_POSTGRES_URL (a database named for it, `orrery_e2e`), that Postgres, emptied first.
import {defineConfig, devices} from '@playwright/test'
import {e2ePort} from './e2e-port'

const port = e2ePort(3100)
const postgres = process.env.E2E_POSTGRES_URL
const chrome = devices['Desktop Chrome']
// The whole suite (`pnpm test:e2e`), or a spec on its own (`pnpm exec playwright test e2e/x.spec.ts`), which stays one at a
// time: a project's dependencies run whatever the filter says, so these groups would run the whole suite first.
const whole = process.env.E2E_WHOLE

// Who shares what on the one orrery. These change a thing other specs read, so each group takes turns inside itself,
// and a spec that changes something shared goes in a group here. What's in neither group runs side by side.
const SESSIONS = ['chat', 'sessions', 'sessions-across', 'sessions-tabs', 'session-claims', 'pick-next', 'permission-prompt']
const SETTINGS = ['navigation', 'events', 'context', 'settings-tabs', 'settings-tracker', 'pickers', 'routes', 'schedules', 'schedule-project', 'schedule-remove', 'unique-ids']
// A second person refuses other specs' writes, and moving the database takes it from under them: these run with nothing
// else, last, with the visual spec, as its images show the whole sidebar.
const ALONE = ['people', 'settings-database', 'visual']
const specs = (names: string[]) => names.map(name => `${name}.spec.ts`)
const shared = [...SESSIONS, ...SETTINGS, ...ALONE]
const beforeLast = ['free', 'sessions', 'settings']

export default defineConfig({
    testDir: 'e2e',
    // Named for the browser, not the group a spec runs in, so the visual spec finds its images on the whole suite too.
    snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-chromium-{platform}{ext}',
    // What `pnpm test:report` keeps with a run's numbers, so a change to how this runs isn't taken for a speedup.
    metadata: {server: 'dev'},
    // One orrery for every file. first-run.spec.ts opens it fresh, with an owner who has no name yet, so it runs first,
    // as a Playwright project the rest depend on; each of them then makes an orrery project of its own.
    workers: whole ? 4 : 1,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', {open: 'never'}], ['json', {outputFile: 'e2e-results.json'}]] : 'list',
    use: {baseURL: `http://localhost:${port}`, trace: 'retain-on-failure'},
    projects: [
        {name: 'first-run', testMatch: 'first-run.spec.ts', use: chrome},
        ...whole
            ? [
                {name: 'free', testIgnore: ['first-run.spec.ts', 'perf/**', 'login/**', 'readme/**', ...specs(shared)], dependencies: ['first-run'], use: chrome},
                {name: 'sessions', testMatch: specs(SESSIONS), dependencies: ['first-run'], workers: 1, use: chrome},
                {name: 'settings', testMatch: specs(SETTINGS), dependencies: ['first-run'], workers: 1, use: chrome},
                {name: 'alone', testMatch: specs(ALONE), dependencies: beforeLast, workers: 1, use: chrome},
            ]
            : [{name: 'chromium', testIgnore: ['first-run.spec.ts', 'perf/**', 'login/**', 'readme/**'], dependencies: ['first-run'], use: chrome}],
    ],
    webServer: {
        command: `${postgres ? 'jiti scripts/e2e-postgres.ts' : 'rm -f .data/e2e.db .data/e2e.db-* .data/e2e.db.backups.json .data/e2e-moved-*.db'} && nuxt dev --port ${port}`,
        env: {NUXT_DATABASE: postgres || '.data/e2e.db', NUXT_BACKUP_DIR: '', NUXT_UPDATE_CHECK: 'false', ORRERY_AUTH: 'off'},
        url: `http://localhost:${port}/api/settings`,
        reuseExistingServer: false,
        // V8 writes its coverage as a process exits, so a run that collects it has to let the server stop by itself (ORR-745).
        ...process.env.NODE_V8_COVERAGE ? {gracefulShutdown: {signal: 'SIGTERM' as const, timeout: 15_000}} : {},
        timeout: 180_000,
    },
})
