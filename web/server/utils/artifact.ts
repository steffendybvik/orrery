// An artifact as served (ORR-677): the author's HTML, stored as they wrote it, with Tailwind's browser build and the app's
// theme put in front of it, so ordinary Tailwind classes work with no build step and match the app. All of it inline.

/** Scripts and styles of its own and nothing else: no request leaves it, and `sandbox` gives it no origin, so it can't
 * reach orrery's API, the page around it, a popup, a form or the top tab. */
export const ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; sandbox allow-scripts"

/** The top-level rules of the app's stylesheet whose selector this picks, whole, with nested braces. */
export function cssRules(css: string, wanted: (selector: string) => boolean): string[] {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const rules: string[] = []
    let start = 0
    let depth = 0
    for (let at = 0; at < source.length; at++) {
        const char = source[at]
        if (char === '{') depth++
        if (char === ';' && !depth) {
            const rule = source.slice(start, at + 1).trim()
            if (wanted(rule)) rules.push(rule)
            start = at + 1
        }
        if (char === '}' && !--depth) {
            const rule = source.slice(start, at + 1).trim()
            if (wanted(rule.slice(0, rule.indexOf('{')).trim())) rules.push(rule)
            start = at + 1
        }
    }
    return rules
}

/** What Tailwind compiles in the frame: its own defaults, then the app's theme and dark variant, read from the one
 * stylesheet so they can't drift. Not its tint, or its components: those are the app's own. */
export function artifactTheme(appCss: string): string {
    const rules = cssRules(appCss, s => /^@theme\b/.test(s) || s.startsWith('@custom-variant dark') || s === ':root' || s === '.dark')
    return `@import "tailwindcss";\n${rules.join('\n')}\nbody { color: var(--fg); font-family: var(--font-sans); font-size: 13px; }`
}

let parts: Promise<{tailwind: string, theme: string}> | undefined

/** Read once, as the build and the theme don't change while orrery runs. */
function artifactParts() {
    return parts ??= (async () => ({
        // It sits in a <script>, so nothing in it may read as that tag's end.
        tailwind: String(await useStorage('assets:tailwind-browser').getItem('index.global.js') ?? '').replaceAll('</script', '<\\/script'),
        theme: artifactTheme(String(await useStorage('assets:app-css').getItem('main.css') ?? '')).replaceAll('</style', '<\\/style'),
    }))()
}

/** The page for `html`. It goes after what's put in front, so a whole document of its own parses too: the browser folds
 * its `<html>` and `<head>` into these. */
export async function artifactPage(html: string, dark: boolean): Promise<string> {
    const {tailwind, theme} = await artifactParts()
    return `<!doctype html><html lang="en"${dark ? ' class="dark"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
        + `<script>${tailwind}</script><style type="text/tailwindcss">${theme}</style></head>\n${html}`
}
