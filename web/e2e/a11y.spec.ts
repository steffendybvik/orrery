import AxeBuilder from '@axe-core/playwright'
import type {Page} from '@playwright/test'
import {expect, test} from './test'
import {AGENT} from './support'
import type {Walked} from './pages'
import {ROUTES, heading, walkProject} from './pages'

// The slow walks over every page that only read (ORR-920): WCAG in light and dark, a phone's scrolling boxes, and what
// sits under the Agent button. Split from navigation.spec.ts, whose tests change the shared Advanced setting and so take
// turns with the other specs that do. These change nothing shared: Advanced (and the tint) is this page's alone, set on
// what the page reads of the settings, and the pages are a project of their own, so they run beside anything.

// What the page walk already finds, for ORR-724 to fix: each comes off this list as it's fixed, and until then a new
// case of one of these isn't caught. Any other rule fails the walk.
const A11Y_KNOWN = ['nested-interactive']

let w: Walked

test.beforeAll(async ({request}) => {
    w = await walkProject(request, 'Globe', 'GLO')
})

/** The settings as this page reads them, with `changes` over what the server says: the setting is shared, and other
 * specs change it while this one walks. */
async function withSettings(page: Page, changes: () => Record<string, unknown>) {
    await page.route(/\/api\/settings$/, async route => {
        const response = await route.fetch()
        if (route.request().method() !== 'GET') return route.fulfill({response})
        await route.fulfill({response, json: {...await response.json(), ...changes()}})
    })
}

test('no page breaks a WCAG A or AA rule, beyond those the UI/UX audit has (ORR-735)', async ({page}) => {
    test.setTimeout(240_000)
    // A tint takes contrast away on a light page, so the light pass has the harshest named one. In dark it lightens the faint
    // grey, so the dark pass has none (ORR-855). On this page only, as the setting is shared: chat.spec.ts changes it.
    let tint: string | null = null
    await withSettings(page, () => ({advanced: true, tint}))
    for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({colorScheme})
        tint = colorScheme === 'light' ? 'violet' : null
        for (const route of ROUTES(w)) {
            await test.step(`${route.path}, ${colorScheme}`, async () => {
                await page.goto(route.path)
                await expect(heading(page, route.heading)).toBeVisible()
                // A fade still running reads as low contrast, and differently each time.
                await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))))
                const {violations} = await new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).disableRules(A11Y_KNOWN).analyze()
                expect.soft(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), `${route.path}, ${colorScheme}`).toEqual([])
            })
        }
    }
})

// At 390 px a box can scroll sideways that doesn't on a desktop, and a keyboard has to be able to scroll it (ORR-859). One
// rule only: the full pass above is the desktop's.
test('on a phone, every box that scrolls takes focus, so a keyboard can scroll it (ORR-859)', async ({page, request}) => {
    test.setTimeout(240_000)
    const wide = `${'long_name_that_runs_on_'.repeat(6)}end`
    await request.put(`/api/projects/${w.id}/docs/wide-code`, {headers: AGENT, data: {
        title: 'Wide code',
        body: `\`\`\`sh\ncurl -fsSL http://localhost:9000/${wide} | sh\n\`\`\`\n\n| ${wide} | b | c | d | e |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |\n`,
    }}).then(r => expect(r.ok(), 'the doc').toBeTruthy())
    await page.setViewportSize({width: 390, height: 800})
    await withSettings(page, () => ({advanced: true}))
    for (const route of [...ROUTES(w), {path: `/p/${w.id}/docs/wide-code`, heading: 'Wide code'}]) {
        await test.step(route.path, async () => {
            await page.goto(route.path)
            await expect(heading(page, route.heading)).toBeVisible()
            const {violations} = await new AxeBuilder({page}).withRules(['scrollable-region-focusable']).analyze()
            expect.soft(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), route.path).toEqual([])
        })
    }
})

test('every page, scrolled to the end, leaves nothing under the Agent button (ORR-796)', async ({page}) => {
    test.setTimeout(120_000)
    await withSettings(page, () => ({advanced: true}))
    // Short enough that each page has to scroll, and wide enough for a phone's layout not to apply.
    await page.setViewportSize({width: 1280, height: 320})
    for (const route of ROUTES(w)) {
        await test.step(route.path, async () => {
            await page.goto(route.path)
            await expect(heading(page, route.heading)).toBeVisible()
            const button = page.getByRole('button', {name: 'Agent', exact: true})
            await expect(button).toBeVisible()
            // Its data comes after its heading.
            await page.waitForTimeout(300)
            const under = await button.evaluate((agent) => {
                const clear = agent.getBoundingClientRect()
                const over = (r: DOMRect) => r.width > 0 && r.height > 0 && r.left < clear.right && r.right > clear.left && r.top < clear.bottom && r.bottom > clear.top
                const inside = [...document.querySelectorAll('main *')] as HTMLElement[]
                for (const el of inside) {
                    if (['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.tagName !== 'PRE') el.scrollTop = el.scrollHeight
                }
                // What can be seen or used: anything without elements inside it, or with words of its own.
                const shows = (el: HTMLElement) => !el.children.length || [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())
                return inside
                    .filter(el => shows(el) && el.checkVisibility({visibilityProperty: true}) && over(el.getBoundingClientRect()))
                    .map(el => el.outerHTML.slice(0, 90))
            })
            expect.soft(under, route.path).toEqual([])
        })
    }
})
