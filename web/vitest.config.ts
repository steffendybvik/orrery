import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vitest/config'
import {defineVitestProject} from '@nuxt/test-utils/config'

export default defineConfig({
    test: {
        projects: [
            {
                resolve: {alias: {'#shared': fileURLToPath(new URL('./shared', import.meta.url))}},
                test: {name: 'unit', include: ['test/**/*.test.ts'], exclude: ['test/components/**']},
            },
            // The components, mounted in a Nuxt app in happy-dom (auto-imports, `#shared` and all).
            await defineVitestProject({
                test: {name: 'components', include: ['test/components/**/*.test.ts'], environment: 'nuxt', environmentOptions: {nuxt: {domEnvironment: 'happy-dom'}}},
            }),
        ],
        // `pnpm test:coverage`: the server's logic, what it shares with the page, and the page's components and
        // composables (the routes are thin handlers over the store).
        coverage: {provider: 'v8', include: ['server/utils/**', 'shared/**', 'app/components/**', 'app/composables/**', 'app/utils/**'], reporter: ['text', 'json-summary']},
    },
})
