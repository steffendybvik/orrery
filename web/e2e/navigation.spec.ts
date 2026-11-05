import type {Page} from '@playwright/test'
import {expect, test} from './test'
import {OWNER} from './support'
import type {Route, Walked} from './pages'
import {REDIRECTS as REDIRECTS_OF, ROUTES as ROUTES_OF, heading, walkProject} from './pages'

// The navigation as a whole (ORR-580): every page opens and renders its heading with no page or console error, each
// sidebar entry goes to its page and shows as active there, and the ⌘K palette and App settings → Advanced still lead
// to theirs. The pages are one list, in pages.ts; the slow read-only walks over them (WCAG, a phone's scrolling, the
// Agent button) are in a11y.spec.ts, which needn't wait its turn with the specs that change the settings (ORR-920).
let advanced = false

let w: Walked
const ROUTES = () => ROUTES_OF(w)

test.beforeAll(async ({request}) => {
    advanced = !!(await (await request.get('/api/settings')).json()).advanced
    w = await walkProject(request, 'Atlas', 'ATL')
})

test.afterAll(async ({request}) => {
    await request.patch('/api/settings', {data: {advanced}, headers: OWNER})
})

/** Advanced on or off, as the owner. */
async function setAdvanced(page: Page, on: boolean) {
    const set = await page.request.patch('/api/settings', {data: {advanced: on}, headers: OWNER})
    expect(set.ok(), await set.text()).toBeTruthy()
}

/** The page errors and console errors seen from here on. */
function watchErrors(page: Page) {
    const errors: string[] = []
    // What Safari says of a request or a script the next `goto` cut short. Nothing here goes to another site, and a
    // script really missing leaves its page without its heading.
    page.on('pageerror', error => {
        if (!/due to access control checks|Importing a module script failed/.test(error.message)) errors.push(`page error: ${error.message}`)
    })
    page.on('console', message => {
        if (message.type() === 'error') errors.push(`console: ${message.text()}`)
    })
    return errors
}

/** The sidebar's link to `path` (its own, not the sessions list under it), by its text: a project's name and its
 * Issues both go to the project. */
const sidebarLink = (page: Page, path: string, text: string) => page.locator('aside nav').locator(`a[href="${path.split('?')[0]}"]`).filter({hasText: text})

/** Where going to `path` ends up: Docs opens on the first doc. */
const landsOn = (path: string) => new RegExp(`${path.split('?')[0]}${path.endsWith('/docs') ? '(/[^/]+)?' : ''}(\\?.*)?$`)

/** The requests seen from here on that went to a host other than the page's own (ORR-846). */
function watchOtherHosts(page: Page, origin: string) {
    const elsewhere: string[] = []
    page.on('request', request => {
        const url = new URL(request.url())
        if (/^(https?|wss?):$/.test(url.protocol) && url.host !== new URL(origin).host) elsewhere.push(request.url())
    })
    return elsewhere
}

/** A Content-Security-Policy's directives, by name. */
const directives = (csp = '') => Object.fromEntries(csp.split(';').map(d => d.trim().split(/\s+/)).filter(d => d[0]).map(([name, ...values]) => [name, values.join(' ')]))

test('every page renders its heading, with no page or console error, and loads nothing from another host', async ({page, baseURL}) => {
    test.setTimeout(120_000)
    await setAdvanced(page, true)
    const errors = watchErrors(page)
    // orrery serves its own fonts and styles (ORR-766), and SECURITY.md says a page loads nothing from elsewhere.
    const elsewhere = watchOtherHosts(page, baseURL!)
    for (const route of ROUTES()) {
        await test.step(route.path, async () => {
            await page.goto(route.path)
            await expect(heading(page, route.heading)).toBeVisible()
            await expect(page.getByRole('heading', {name: /^Nothing at /})).toHaveCount(0)
            expect(errors, route.path).toEqual([])
        })
    }
    await page.waitForLoadState('networkidle')
    expect(elsewhere).toEqual([])
})

test("a page's CSP lets fonts and styles come from orrery alone (ORR-846)", async ({page}) => {
    const answer = await page.goto('/mine')
    const csp = directives(answer?.headers()['content-security-policy'])
    expect(csp['font-src']).toBe("'self' data:")
    expect(csp['style-src']).toBe("'self' 'unsafe-inline'")
})

test('an old address goes on to the page that took it over', async ({page}) => {
    for (const {from, to} of REDIRECTS_OF(w)) {
        await test.step(from, async () => {
            await page.goto(from)
            await expect(page).toHaveURL(to)
        })
    }
})

test('each sidebar entry goes to its page and shows as active there', async ({page}) => {
    test.setTimeout(120_000)
    await setAdvanced(page, true)
    for (const route of ROUTES().filter(r => r.sidebar && !r.advanced)) {
        await test.step(route.path, async () => {
            await page.goto(route.path)
            const link = sidebarLink(page, entryPath(route), route.sidebar!)
            await expect(link).toHaveClass(/\bbg-active\b/)
        })
    }
    // And a click on each goes there, from a page that isn't it.
    for (const route of ROUTES().filter(r => r.sidebar && !r.advanced && r.path === entryPath(r))) {
        await test.step(`click ${route.sidebar}`, async () => {
            const elsewhere = route.path === '/mine' ? '/connect' : !route.path.startsWith('/p/') ? '/mine' : route.path === `/p/${w.id}/settings` ? `/p/${w.id}` : `/p/${w.id}/settings`
            await page.goto(elsewhere)
            await sidebarLink(page, route.path, route.sidebar!).click()
            await expect(page).toHaveURL(landsOn(route.path))
            await expect(sidebarLink(page, route.path, route.sidebar!)).toHaveClass(/\bbg-active\b/)
            await expect(heading(page, route.heading)).toBeVisible()
        })
    }
})

// The pages ORR-561 and ORR-565 moved to App settings → Advanced are back in the sidebar under Schedules (ORR-578).
test('Events, Context and Pull requests are in the sidebar only while Advanced is on', async ({page}) => {
    const entries = ROUTES().filter(r => r.advanced)
    await setAdvanced(page, true)
    for (const route of entries) {
        await page.goto(route.path)
        await expect(sidebarLink(page, route.path, route.sidebar!)).toHaveClass(/\bbg-active\b/)
    }
    await page.goto('/mine')
    await sidebarLink(page, '/events', 'Events').click()
    await expect(heading(page, 'Events')).toBeVisible()
    await setAdvanced(page, false)
    await page.goto('/mine')
    await expect(sidebarLink(page, '/schedules', 'Schedules')).toBeVisible()
    for (const route of entries) await expect(sidebarLink(page, route.path, route.sidebar!)).toHaveCount(0)
})

test('each page the ⌘K palette lists opens it', async ({page}) => {
    test.setTimeout(120_000)
    await setAdvanced(page, true)
    for (const route of ROUTES().filter(r => r.palette)) {
        await test.step(route.palette!, async () => {
            await page.goto(route.path === '/mine' ? '/connect' : '/mine')
            await expect(page.getByRole('heading', {level: 1}).first()).toBeVisible()
            await page.keyboard.press('ControlOrMeta+k')
            const palette = page.getByRole('dialog', {name: 'Commands'})
            const entry = (within: typeof palette) => within.getByRole('option').filter({has: page.getByText(route.palette!, {exact: true})})
            // The places in Go to are there with nothing typed; the rest (a project's pages, a doc, an issue) are found.
            if (!await entry(palette.getByRole('region', {name: 'Go to'})).count()) await palette.getByLabel('Type a command or search').fill(route.palette!)
            await entry(palette).first().click()
            await expect(page).toHaveURL(landsOn(route.path))
            await expect(heading(page, route.heading)).toBeVisible()
        })
    }
})

test('the links on App settings → Advanced lead to their pages, with Advanced off too', async ({page}) => {
    await setAdvanced(page, false)
    for (const [link, route] of [['Open the event log', '/events'], ['See what a session is sent', '/context'], ['Open pull requests', '/pulls']] as const) {
        await page.goto('/settings?tab=advanced')
        await page.getByRole('link', {name: link}).click()
        await expect(page).toHaveURL(new RegExp(`${route}$`))
        await expect(heading(page, ROUTES().find(r => r.path === route)!.heading)).toBeVisible()
    }
})

/** The sidebar link that's active on a route: a project's section is at the section's own address. */
function entryPath(route: Route) {
    const path = route.path.split('?')[0]!
    if (path.startsWith('/epics/')) return '/epics'
    const section = path.match(new RegExp(`^/p/${w.id}/(roadmap|releases|docs|settings|issues)`))?.[1]
    if (!section) return path
    return section === 'issues' ? `/p/${w.id}` : `/p/${w.id}/${section}`
}
