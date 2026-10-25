// The main flows in a real browser (`pnpm test:e2e`): `nuxt dev` on a port of its own, with a database
// made fresh for each run, so the tests start from an empty Orrery whose owner has no name yet.
import {defineConfig, devices} from '@playwright/test'

const port = 3199

export default defineConfig({
    testDir: 'e2e',
    // One Orrery, one story: the flows build on each other.
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', {open: 'never'}]] : 'list',
    use: {baseURL: `http://localhost:${port}`, trace: 'retain-on-failure'},
    projects: [{name: 'chromium', use: devices['Desktop Chrome']}],
    webServer: {
        command: `rm -f .data/e2e.db .data/e2e.db-* && nuxt dev --port ${port}`,
        env: {NUXT_DATABASE: '.data/e2e.db', NUXT_BACKUP_DIR: ''},
        url: `http://localhost:${port}/api/settings`,
        reuseExistingServer: false,
        timeout: 180_000,
    },
})
