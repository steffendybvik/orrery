// Signing up with login on (ORR-1221), run by `pnpm test:e2e:login` after the login spec: an orrery of its own, as a
// login provider takes the key box off the login page (ORR-1185), with a database made fresh for each run and a provider
// of the spec's own (scripts/e2e-oidc.mjs). Sign-up is open, as it is unless ORRERY_SIGN_UP=invite (ORR-1180).
import {defineConfig, devices} from '@playwright/test'
import {e2ePort} from './e2e-port'
import {apiBuild, serverTimeout} from './e2e-api'

const port = e2ePort(4000)
const providerPort = port + 300

export default defineConfig({
    testDir: 'e2e/signup',
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: 'list',
    outputDir: 'test-results-signup',
    use: {baseURL: `http://localhost:${port}`, trace: 'retain-on-failure', ...devices['Desktop Chrome']},
    webServer: [
        {
            command: `node scripts/e2e-oidc.mjs ${providerPort}`,
            url: `http://localhost:${providerPort}/.well-known/openid-configuration`,
            reuseExistingServer: false,
        },
        {
            command: `rm -f node_modules/.cache/nuxt/dev-server.json .data/e2e-signup.db .data/e2e-signup.db-* && ${apiBuild}nuxt dev --port ${port}`,
            env: {
                NUXT_DATABASE: '.data/e2e-signup.db', NUXT_UPDATE_CHECK: 'false', ORRERY_AUTH: 'on',
                NUXT_OIDC_ISSUER: `http://localhost:${providerPort}`, NUXT_OIDC_CLIENT_ID: 'orrery-e2e', NUXT_OIDC_CLIENT_SECRET: 'e2e-secret',
            },
            url: `http://localhost:${port}/api/auth/status`,
            reuseExistingServer: false,
            timeout: serverTimeout(180_000),
        },
    ],
})
