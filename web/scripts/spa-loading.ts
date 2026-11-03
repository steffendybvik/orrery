// The start-up screen (ORR-815): what a fresh open or a refresh shows until the app has started, as `spaLoadingTemplate`
// (nuxt.config.ts). It's plain HTML and CSS, as there's no Vue yet: the logo, inlined from public/favicon.svg so it's
// there with the first paint and follows the logo when it changes, and the braille spinner under it, drawn from the same
// frames as `ui/Spinner` (shared/spinner.ts) at the size and colour `ui/Loading` gives it. It comes in a moment late, as
// `ui/Loading` does, so a quick start shows nothing, and the theme is the one the head's script set on <html>.
import {readFileSync, writeFileSync} from 'node:fs'
import {SPINNER_DOT_RADIUS, SPINNER_DOTS, SPINNER_FRAMES, SPINNER_VIEWBOX} from '../shared/spinner'

/** The screen's HTML, with `favicon` (the SVG's source) as its logo. */
export function spaLoadingHtml(favicon: string): string {
    const logo = favicon.trim().replace('<svg ', '<svg class="orrery-start-logo" aria-hidden="true" ')
    const dots = SPINNER_DOTS.map(d => `<circle cx="${d.x}" cy="${d.y}" r="${SPINNER_DOT_RADIUS}"/>`).join('')
    // The canvas and faint colours of main.css, which may not have loaded yet; the spinner's 0.8s in 10 steps and 1em
    // tall by 0.72em, at ui/Loading's text-lg.
    const style = `html{background:#fafafa}html.dark{background:#09090b}`
        + `.orrery-start{position:fixed;inset:0;display:grid;place-content:center;justify-items:center;gap:20px;color:#66666e;animation:orrery-start-appear .2s .15s both}`
        + `html.dark .orrery-start{color:#8b8b94}`
        + `.orrery-start-logo{display:block;width:64px;height:64px}`
        + `.orrery-start-spin{display:block;height:18px;width:12.96px;overflow:hidden}`
        + `.orrery-start-spin svg{display:block;width:100%;height:${SPINNER_FRAMES.length * 100}%;animation:orrery-start-spin .8s steps(${SPINNER_FRAMES.length}) infinite}`
        + `@keyframes orrery-start-appear{from{opacity:0}}@keyframes orrery-start-spin{to{transform:translateY(-100%)}}`
        + `@media (prefers-reduced-motion:reduce){.orrery-start-spin svg{animation:none}}`
    return `<style>${style}</style>`
        + `<div class="orrery-start" role="status" aria-label="Loading orrery">${logo}`
        + `<span class="orrery-start-spin" aria-hidden="true"><svg viewBox="${SPINNER_VIEWBOX}" fill="currentColor">${dots}</svg></span></div>\n`
}

/** Writes the screen to `out` from `favicon` (a path), and gives back `out`. */
export function writeSpaLoading(out: string, favicon: string): string {
    writeFileSync(out, spaLoadingHtml(readFileSync(favicon, 'utf8')))
    return out
}
