import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {spaLoadingHtml} from '../scripts/spa-loading'
import {SPINNER_DOTS} from '../shared/spinner'

// The start-up screen (ORR-815): the logo as public/favicon.svg draws it, and ui/Spinner's frames, before Vue exists.
const favicon = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8')
const html = spaLoadingHtml(favicon)

describe('the start-up screen', () => {
    it('inlines the logo from favicon.svg, so it follows a change to it', () => {
        expect(html).toContain(favicon.trim().slice('<svg '.length))
        expect(html).not.toContain('<img')
    })

    it("draws ui/Spinner's dots, 0.8s in 10 steps, and holds a frame with reduced motion", () => {
        expect(html.match(/ r="1.4"/g)).toHaveLength(SPINNER_DOTS.length)
        expect(html).toContain('.8s steps(10) infinite')
        expect(html).toMatch(/prefers-reduced-motion:reduce\)\{\.orrery-start-spin svg\{animation:none\}/)
    })

    it('says it is loading, with the logo and braille hidden from screen readers', () => {
        expect(html).toContain('role="status" aria-label="Loading orrery"')
        expect(html).toContain('class="orrery-start-logo" aria-hidden="true"')
        expect(html).toContain('class="orrery-start-spin" aria-hidden="true"')
    })

    it("comes in late, as ui/Loading does, on the theme's own background", () => {
        expect(html).toContain('animation:orrery-start-appear .2s .15s both')
        expect(html).toContain('html.dark{background:#09090b}')
    })
})
