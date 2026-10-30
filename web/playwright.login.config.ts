// With login on (`pnpm test:e2e:login`): an orrery of its own, as `pnpm test:e2e`'s stays one person's, with `ORRERY_AUTH=on`
// and a database made fresh for each run. The login page, signing in with a key, Settings' keys and logging out (ORR-699).
import {defineConfig, devices} from '@playwright/test'
import {e2ePort} from './e2e-port'

const port = e2ePort(3600)

export default defineConfig({
    testDir: 'e2e/login',
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: 'list',
    outputDir: 'test-results-login',
    use: {baseURL: `http://localhost:${port}`, trace: 'retain-on-failure', ...devices['Desktop Chrome']},
    webServer: {
        command: `rm -f .data/e2e-login.db .data/e2e-login.db-* .data/e2e-login.db.backups.json && nuxt dev --port ${port}`,
        env: {NUXT_DATABASE: '.data/e2e-login.db', NUXT_BACKUP_DIR: '', NUXT_UPDATE_CHECK: 'false', ORRERY_AUTH: 'on'},
        // Not a route that asks for a login, which answers 503 until someone claims the server.
        url: `http://localhost:${port}/api/auth/status`,
        reuseExistingServer: false,
        timeout: 180_000,
    },
})
