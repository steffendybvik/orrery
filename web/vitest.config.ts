import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vitest/config'
import {defineVitestProject} from '@nuxt/test-utils/config'

export default defineConfig({
    test: {
        projects: [
            {
                resolve: {alias: {'#shared': fileURLToPath(new URL('./shared', import.meta.url)), '#channel': fileURLToPath(new URL('../channel', import.meta.url))}},
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
        // `pnpm test:coverage`: the server's logic, its store, its routes and middleware, what it shares with the page, the
        // page's components and composables, and the channel, hook and launcher (`../channel`, outside this folder, hence
        // `allowExternal`). The routes count too, so the headline number doesn't hide the ones no test runs (ORR-584); CI's
        // summary splits it by area.
        coverage: {
            provider: 'v8',
            include: ['server/utils/**', 'server/store/**', 'server/api/**', 'server/middleware/**', 'shared/**', 'app/components/**', 'app/composables/**', 'app/utils/**', '../channel/**/*.mjs'],
            allowExternal: true,
            // `json` is what `pnpm test:report` adds other runs' lines to (ORR-745).
            reporter: ['text', 'json-summary', 'json'],
        },
    },
})
