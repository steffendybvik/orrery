import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vitest/config'

export default defineConfig({
    resolve: {alias: {'#shared': fileURLToPath(new URL('./shared', import.meta.url))}},
    test: {
        include: ['test/**/*.test.ts'],
        // `pnpm test:coverage`: the server's logic and what it shares with the page (the routes are thin
        // handlers over the store, the page is the page).
        coverage: {provider: 'v8', include: ['server/utils/**', 'shared/**'], reporter: ['text', 'json-summary']},
    },
})
