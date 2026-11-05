import AxeBuilder from '@axe-core/playwright'
import {expect, test} from './test'
import {AGENT} from './support'
import type {Page} from '@playwright/test'
import type {Route, Walked} from './pages'
import {heading, walkProject} from './pages'
import {eachPage, withSettings} from './walks'

// The read-only walks over every page besides WCAG's (wcag-light.spec.ts, wcag-dark.spec.ts): a phone's scrolling boxes,
// and what sits under the Agent button (ORR-920). Split from navigation.spec.ts, whose tests change the shared Advanced
// setting and so take turns with the other specs that do. These change nothing shared: Advanced is this page's alone,
// set on what the page reads of the settings, and the pages are a project of their own, so they run beside anything.

let w: Walked

const wide = `${'long_name_that_runs_on_'.repeat(6)}end`

test.beforeAll(async ({request}) => {
    w = await walkProject(request, 'Sphere', 'SPH')
    // A doc whose code and table run wider than a phone, for the phone's pass.
    await request.put(`/api/projects/${w.id}/docs/wide-code`, {headers: AGENT, data: {
        title: 'Wide code',
        body: `\`\`\`sh\ncurl -fsSL http://localhost:9000/${wide} | sh\n\`\`\`\n\n| ${wide} | b | c | d | e |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |\n`,
    }}).then(r => expect(r.ok(), 'the doc').toBeTruthy())
})

// At 390 px a box can scroll sideways that doesn't on a desktop, and a keyboard has to be able to scroll it (ORR-859). One
// rule only: the full pass is WCAG's. A test for each page (ORR-916).
async function phoneScrolls(page: Page, route: Route) {
    await page.setViewportSize({width: 390, height: 800})
    await withSettings(page, () => ({advanced: true}))
    await page.goto(route.path)
    await expect(heading(page, route.heading)).toBeVisible()
    const {violations} = await new AxeBuilder({page}).withRules(['scrollable-region-focusable']).analyze()
    expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), route.path).toEqual([])
}
const PHONE = 'on a phone, every box that scrolls takes focus, so a keyboard can scroll it (ORR-859)'
eachPage(PHONE, () => w, phoneScrolls)
test(`${PHONE}: a doc wider than the phone`, async ({page}) => {
    await phoneScrolls(page, {path: `/p/${w.id}/docs/wide-code`, heading: 'Wide code'})
})

// A test for each page (ORR-916).
eachPage('every page, scrolled to the end, leaves nothing under the Agent button (ORR-796)', () => w, async (page, route) => {
    await withSettings(page, () => ({advanced: true}))
    // Short enough that each page has to scroll, and wide enough for a phone's layout not to apply.
    await page.setViewportSize({width: 1280, height: 320})
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
    expect(under, route.path).toEqual([])
})
