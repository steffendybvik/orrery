// The main flows in a real browser (`pnpm test:e2e`): `nuxt dev` on a port of its own (one per checkout, e2e-port.ts),
// with a database made fresh for each run, so the tests start from an empty orrery whose owner has no name yet. A SQLite
// file by default; with E2E_POSTGRES_URL (a database named for it, `orrery_e2e`), that Postgres, emptied first.
// Chrome by default; E2E_BROWSER=webkit or firefox runs them in that one. One at a time, as each needs an orrery of its own.
import {readdirSync, readFileSync} from 'node:fs'
import {defineConfig, devices} from '@playwright/test'
import {e2ePort} from './e2e-port'
import type {Group} from './e2e-shards'
import {shardSetting, shards} from './e2e-shards'

const port = e2ePort(3100)
const postgres = process.env.E2E_POSTGRES_URL
// The browser it runs in: Chrome, or `E2E_BROWSER=webkit` or `firefox` (ORR-734).
const chrome = devices[{webkit: 'Desktop Safari', firefox: 'Desktop Firefox'}[process.env.E2E_BROWSER ?? ''] ?? 'Desktop Chrome']
// The whole suite (`pnpm test:e2e`), or a spec on its own (`pnpm exec playwright test e2e/x.spec.ts`), which stays one at a
// time: a project's dependencies run whatever the filter says, so these groups would run the whole suite first.
const whole = process.env.E2E_WHOLE

// Who shares what on the one orrery. These change a thing other specs read, so each group takes turns inside itself,
// and a spec that changes something shared goes in a group here. What's in neither group runs side by side.
const SESSIONS = ['chat', 'sessions', 'sessions-across', 'sessions-tabs', 'session-claims', 'pick-next', 'permission-prompt', 'whole-session']
const SETTINGS = ['navigation', 'events', 'context', 'settings-tabs', 'settings-tracker', 'secrets', 'pickers', 'routes', 'schedules', 'schedule-project', 'schedule-remove', 'unique-ids']
// A second person refuses other specs' writes, and moving the database takes it from under them: these run with nothing
// else, last, with the visual spec, as its images show the whole sidebar.
const ALONE = ['people', 'settings-database', 'visual']
const specs = (names: string[]) => names.map(name => `${name}.spec.ts`)
const shared = [...SESSIONS, ...SETTINGS, ...ALONE]
const beforeLast = ['free', 'sessions', 'settings']

// One shard of the whole suite (`E2E_SHARD=2/3`, ORR-920): first-run, then its share of each group as above, on a server
// of its own. CI runs each browser's suite as shards side by side; e2e-shards.ts says which spec goes where.
const shard = whole ? shardSetting(process.env.E2E_SHARD) : null
// The page walks, which load every page in turn: no two in one shard where it can be helped.
const WALKS = specs(['navigation', 'a11y', 'wcag-light', 'wcag-dark'])
const groupOf = (file: string): Group => {
    const name = file.replace(/\.spec\.ts$/, '')
    return SESSIONS.includes(name) ? 'sessions' : SETTINGS.includes(name) ? 'settings' : ALONE.includes(name) ? 'alone' : 'free'
}
const mine = shard ? (shards(
    readdirSync(new URL('./e2e', import.meta.url)).filter(f => f.endsWith('.spec.ts') && f !== 'first-run.spec.ts').sort().map(name => ({name, group: groupOf(name), heavy: WALKS.includes(name)})),
    shard.total, JSON.parse(readFileSync(new URL('./e2e/durations.json', import.meta.url), 'utf8')) as Record<string, number>,
)[shard.index - 1]?.map(s => s.name) ?? []) : null
/** A group's specs: all of them, or this shard's share. */
const share = (group: Group, names: string[]) => mine ? mine.filter(f => groupOf(f) === group && (group === 'free' || names.includes(f.replace(/\.spec\.ts$/, '')))) : specs(names)

export default defineConfig({
    testDir: 'e2e',
    // Named for the browser, not the group a spec runs in, so the visual spec finds its images on the whole suite too.
    snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-chromium-{platform}{ext}',
    // What `pnpm test:report` keeps with a run's numbers, so a change to how this runs isn't taken for a speedup.
    // A sharded run is another way of running it, so it's kept apart from the runs before (ORR-920).
    metadata: {server: shard ? `dev, in ${shard.total} shards` : 'dev'},
    // One orrery for every file. first-run.spec.ts opens it fresh, with an owner who has no name yet, so it runs first,
    // as a Playwright project the rest depend on; each of them then makes an orrery project of its own.
    workers: whole ? 4 : 1,
    retries: process.env.CI ? 1 : 0,
    // On CI a page under `nuxt dev` can take seconds to hydrate, four workers to a runner and the server's coverage on
    // besides, so an expect gets longer there than its 5s here (ORR-912).
    expect: {timeout: process.env.CI ? 15_000 : 5_000},
    // And a whole test, so a few slow expects in one fit: 30s held only while each took 5 (ORR-912).
    timeout: process.env.CI ? 60_000 : 30_000,
    // A shard's blob is merged with the others' after them (`playwright merge-reports`, CI's e2e-report job).
    reporter: process.env.CI ? [['list'], ['html', {open: 'never'}], ['json', {outputFile: 'e2e-results.json'}], ...shard ? [['blob', {fileName: `report-${shard.index}.zip`}] as ['blob', {fileName: string}]] : []] : 'list',
    use: {baseURL: `http://localhost:${port}`, trace: 'retain-on-failure'},
    projects: [
        {name: 'first-run', testMatch: 'first-run.spec.ts', use: chrome},
        ...whole
            ? [
                mine
                    ? {name: 'free', testMatch: share('free', []), dependencies: ['first-run'], use: chrome}
                    : {name: 'free', testIgnore: ['first-run.spec.ts', 'perf/**', 'login/**', 'readme/**', 'restart/**', ...specs(shared)], dependencies: ['first-run'], use: chrome},
                {name: 'sessions', testMatch: share('sessions', SESSIONS), dependencies: ['first-run'], workers: 1, use: chrome},
                {name: 'settings', testMatch: share('settings', SETTINGS), dependencies: ['first-run'], workers: 1, use: chrome},
                {name: 'alone', testMatch: share('alone', ALONE), dependencies: beforeLast, workers: 1, use: chrome},
            ]
            : [{name: process.env.E2E_BROWSER || 'chromium', testIgnore: ['first-run.spec.ts', 'perf/**', 'login/**', 'readme/**', 'restart/**'], dependencies: ['first-run'], use: chrome}],
    ],
    webServer: {
        command: `rm -f node_modules/.cache/nuxt/dev-server.json && ${postgres ? 'jiti scripts/e2e-postgres.ts' : 'rm -f .data/e2e.db .data/e2e.db-* .data/e2e.db.backups.json .data/e2e-moved-*.db'} && nuxt dev --port ${port}`,
        // Postgres has no folder beside it to keep the secrets' key in, so it's given one, as its owner would.
        env: {NUXT_DATABASE: postgres || '.data/e2e.db', NUXT_BACKUP_DIR: '', NUXT_UPDATE_CHECK: 'false', ORRERY_AUTH: 'off', ...postgres ? {NUXT_SECRET_KEY: 'e2e-postgres-secret-key'} : {}},
        url: `http://localhost:${port}/api/settings`,
        reuseExistingServer: false,
        // V8 writes its coverage as a process exits, so a run that collects it has to let the server stop by itself (ORR-745).
        ...process.env.NODE_V8_COVERAGE ? {gracefulShutdown: {signal: 'SIGTERM' as const, timeout: 15_000}} : {},
        timeout: 180_000,
    },
})
