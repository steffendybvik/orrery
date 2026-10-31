// The README's images (`pnpm images:readme`): the playground's demo on an orrery of its own, with a database made fresh
// for each run, so they come out the same size, of the same pages, each time (ORR-771).
import {defineConfig, devices} from '@playwright/test'
import {e2ePort} from './e2e-port'

const port = e2ePort(3800)

export default defineConfig({
    testDir: 'e2e/readme',
    workers: 1,
    reporter: 'list',
    outputDir: 'test-results-readme',
    use: {
        baseURL: `http://localhost:${port}`,
        ...devices['Desktop Chrome'],
        viewport: {width: 1440, height: 900},
        deviceScaleFactor: 1,
        colorScheme: 'light',
    },
    webServer: {
        command: `rm -f .data/readme.db .data/readme.db-* .data/readme.db.backups.json && nuxt dev --port ${port}`,
        env: {NUXT_DATABASE: '.data/readme.db', NUXT_BACKUP_DIR: '', NUXT_UPDATE_CHECK: 'false', ORRERY_AUTH: 'off'},
        url: `http://localhost:${port}/api/settings`,
        reuseExistingServer: false,
        timeout: 180_000,
    },
})
