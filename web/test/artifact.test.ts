// What an artifact is served with (ORR-677): the lock, and the theme read from the app's one stylesheet. That the lock
// holds is for a real browser: e2e/artifacts.spec.ts.
import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {ARTIFACT_CSP, artifactTheme, cssRules} from '../server/utils/artifact'

describe('an artifact', () => {
    it('is served with no way out', () => {
        expect(ARTIFACT_CSP).toContain("default-src 'none'")
        expect(ARTIFACT_CSP).toMatch(/sandbox allow-scripts$/)
        expect(ARTIFACT_CSP).not.toContain('allow-same-origin')
        expect(ARTIFACT_CSP).not.toContain('unsafe-eval')
    })

    it('picks whole rules out of a stylesheet, nested braces and comments and all', () => {
        const css = '@import "x";\n/* a } comment */\n@theme { --a: 1; @keyframes k { from { top: 0 } } }\n.other { top: 0 }\n:root { --b: 2; }'
        expect(cssRules(css, s => s.startsWith('@theme'))).toEqual(['@theme { --a: 1; @keyframes k { from { top: 0 } } }'])
        expect(cssRules(css, s => s === ':root')).toEqual([':root { --b: 2; }'])
        expect(cssRules(css, s => s.startsWith('@import'))).toEqual(['@import "x";'])
    })

    it("takes the app's theme and dark variant from its stylesheet, and none of its components", () => {
        const css = readFileSync('app/assets/css/main.css', 'utf8')
        const theme = artifactTheme(css)
        expect(theme).toContain('@import "tailwindcss"')
        expect(theme).toContain('--color-accent-500')
        expect(theme).toContain('--color-fg: var(--fg)')
        expect(theme).toContain('@custom-variant dark')
        expect(theme).toMatch(/\.dark \{[^}]*--fg:/)
        expect(theme).not.toContain('data-tint')
        expect(theme).not.toContain('@utility')
        expect(theme).not.toContain('.unseen-row')
    })

    it("has Tailwind's browser build at the version the app is built with", () => {
        const version = (name: string) => (JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')) as {version: string}).version
        expect(version('@tailwindcss/browser')).toBe(version('tailwindcss'))
    })
})
