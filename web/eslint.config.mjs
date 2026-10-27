// Lint rules for the app and the server: Nuxt's recommended set, without its formatting rules (the code
// keeps its own style). Non-null assertions are flagged outside the tests, to be worked down (ORR-267).
import {createConfigForNuxt} from '@nuxt/eslint-config/flat'

export default createConfigForNuxt({features: {stylistic: false}}, {
    ignores: ['.nuxt', '.output', 'coverage', 'test-results', 'playwright-report'],
}).append({
    rules: {
        '@typescript-eslint/no-non-null-assertion': 'warn',
        '@typescript-eslint/no-dynamic-delete': 'off',
        'vue/no-multiple-template-root': 'off',
        'vue/attributes-order': 'off',
        'vue/require-default-prop': 'off',
    },
}, {
    files: ['test/**', 'e2e/**'],
    rules: {'@typescript-eslint/no-non-null-assertion': 'off'},
})
