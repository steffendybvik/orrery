import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vitest/config'
import {defineVitestProject} from '@nuxt/test-utils/config'

export default defineConfig({
    test: {
        projects: [
            {
                resolve: {alias: {'#shared': fileURLToPath(new URL('./shared', import.meta.url))}},
                // On Postgres (TEST_POSTGRES_URL) each test lays down a schema of its own, every file at once, so a
                // test can take longer than the 5s default without anything being wrong.
                test: {name: 'unit', include: ['test/**/*.test.ts'], exclude: ['test/components/**'], testTimeout: process.env.TEST_POSTGRES_URL ? 15000 : undefined},
            },
            // The components, mounted in a Nuxt app in happy-dom (auto-imports, `#shared` and all). Mounting is slow
            // under coverage on CI, so a test gets longer than the 5s its own waits may take.
            await defineVitestProject({
                test: {name: 'components', include: ['test/components/**/*.test.ts'], environment: 'nuxt', environmentOptions: {nuxt: {domEnvironment: 'happy-dom'}}, testTimeout: 15000},
            }),
        ],
        // `pnpm test:coverage`: the server's logic, what it shares with the page, and the page's components and
        // composables (the routes are thin handlers over the store).
        coverage: {provider: 'v8', include: ['server/utils/**', 'shared/**', 'app/components/**', 'app/composables/**', 'app/utils/**'], reporter: ['text', 'json-summary']},
    },
})
