import AxeBuilder from '@axe-core/playwright'
import type {Page} from '@playwright/test'
import {expect, test} from '@playwright/test'
import {AGENT, OWNER, makeProject, projectApi} from './support'

// The navigation as a whole (ORR-580): every page opens and renders its heading with no page or console error, each
// sidebar entry goes to its page and shows as active there, and the ⌘K palette and App settings → Advanced still lead
// to theirs. The pages are one list, so a new page is a line here.
const api = projectApi('atlas')
const made = {chunk: '', doc: '', issue: ''}

interface Route {
    path: string
    heading: string
    /** The sidebar entry that leads here and is active on it, by its link's text. */
    sidebar?: string
    /** The ⌘K palette's entry for it: in Go to, or found by typing it. */
    palette?: string
    /** Its sidebar entry shows only while Advanced is on (ORR-578). */
    advanced?: true
}

const ROUTES = (): Route[] => [
    {path: '/mine', heading: 'My issues', sidebar: 'My issues', palette: 'My issues and urgent'},
    {path: '/projects', heading: 'Projects', sidebar: 'Projects', palette: 'Projects'},
    {path: '/connect', heading: 'Connect an agent', sidebar: 'Connect an agent', palette: 'Connect an agent'},
    {path: '/sessions', heading: 'Sessions', sidebar: 'Sessions', palette: 'Sessions'},
    {path: '/schedules', heading: 'Schedules', sidebar: 'Schedules', palette: 'Schedules'},
    {path: '/releases', heading: 'Releases', sidebar: 'Releases', palette: 'Releases'},
    {path: '/events', heading: 'Events', sidebar: 'Events', palette: 'Events', advanced: true},
    {path: '/context', heading: 'Context', sidebar: 'Context', palette: 'Context', advanced: true},
    {path: '/pulls', heading: 'Pull requests', sidebar: 'Pull requests', palette: 'Pull requests', advanced: true},
    {path: '/notifications', heading: 'Notifications', palette: 'Notifications'},
    {path: '/getting-started', heading: 'Getting started', palette: 'Getting started'},
    {path: '/settings', heading: 'Your name', palette: 'App settings'},
    {path: '/settings?tab=issues', heading: 'Team tracker'},
    {path: '/settings?tab=orrery', heading: 'Background tint'},
    {path: '/settings?tab=advanced', heading: 'Pull requests'},
    {path: '/p/atlas', heading: 'Atlas', sidebar: 'Issues', palette: 'Atlas'},
    {path: '/p/atlas?view=board', heading: 'Atlas', sidebar: 'Issues'},
    {path: '/p/atlas/roadmap', heading: 'Atlas', sidebar: 'Roadmap', palette: 'Atlas roadmap'},
    {path: `/p/atlas/roadmap/${made.chunk}`, heading: 'Coastlines', sidebar: 'Roadmap', palette: 'Coastlines'},
    {path: '/p/atlas/releases', heading: 'Atlas', sidebar: 'Releases', palette: 'Atlas releases'},
    {path: '/p/atlas/releases/2.0.0', heading: '2.0.0', sidebar: 'Releases'},
    // Docs opens on the first doc, whose title is the page's h1 (ORR-623).
    {path: '/p/atlas/docs', heading: 'Projections', sidebar: 'Docs', palette: 'Atlas docs'},
    {path: `/p/atlas/docs/${made.doc}`, heading: 'Projections', sidebar: 'Docs', palette: 'Projections'},
    {path: '/p/atlas/settings', heading: 'Atlas', sidebar: 'Settings', palette: 'Atlas settings'},
    {path: `/p/atlas/issues/${made.issue}`, heading: 'Chart the fjords', sidebar: 'Issues', palette: 'Chart the fjords'},
]

// Addresses that only go on to a page, from old links and bookmarks. test/page-specs.test.ts holds every page to these lists.
const REDIRECTS = [
    {from: '/', to: /\/mine$/},
    {from: '/now', to: /\/mine$/},
    {from: '/urgent', to: /\/mine$/},
    {from: '/p/atlas/schedules', to: /\/schedules\?project=atlas$/},
]

// What the page walk already finds, for ORR-724 to fix: each comes off this list as it's fixed, and until then a new
// case of one of these isn't caught. Any other rule fails the walk.
const A11Y_KNOWN = ['label-content-name-mismatch', 'nested-interactive']

let advanced = false

test.beforeAll(async ({request}) => {
    advanced = !!(await (await request.get('/api/settings')).json()).advanced
    // Once a test fails, the next starts on a fresh worker, which runs this again on the same orrery.
    if ((await request.get('/api/projects/atlas')).ok()) {
        made.chunk = String((await api(request, 'get', '/chunks') as {id: number, title: string}[]).find(c => c.title === 'Coastlines')!.id)
        made.doc = (await api(request, 'get', '/docs') as {id: string, title: string}[]).find(d => d.title === 'Projections')!.id
        made.issue = (await api(request, 'get', '/issues?q=fjords') as {id: string}[])[0]!.id
        return
    }
    await makeProject(request, {name: 'Atlas', key: 'ATL', release_mode: 'own'})
    made.chunk = String((await api(request, 'post', '/chunks', {title: 'Coastlines'})).id)
    made.doc = (await api(request, 'post', '/docs', {title: 'Projections', body: 'Mercator, mostly.'})).id
    await api(request, 'post', '/releases', {version: '2.0.0'})
    made.issue = (await api(request, 'post', '/issues', {title: 'Chart the fjords', chunk: made.chunk})).id
    // What the contrast pass has to see (ORR-855): a row waiting on a decision, a schedule that has run and one paused.
    const waiting = (await api(request, 'post', '/issues', {title: 'Pick a projection', chunk: made.chunk, status: 'in-progress'})).id
    await api(request, 'post', `/issues/${waiting}/comments`, {body: 'Mercator or Robinson?', asks: 'decision'})
    const ran = await api(request, 'post', '/schedules', {title: 'Survey the coast', cron: '0 9 * * *', timezone: 'UTC'})
    await api(request, 'post', `/schedules/${ran.id}/run`)
    await api(request, 'post', '/schedules', {title: 'Redraw the borders', cron: '0 9 * * 1', timezone: 'UTC', enabled: false})
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

const heading = (page: Page, name: string) => page.getByRole('heading', {name, exact: true}).first()

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
    for (const {from, to} of REDIRECTS) {
        await test.step(from, async () => {
            await page.goto(from)
            await expect(page).toHaveURL(to)
        })
    }
})

test('no page breaks a WCAG A or AA rule, beyond those the UI/UX audit has (ORR-735)', async ({page}) => {
    test.setTimeout(240_000)
    // A tint takes contrast away on a light page, so the light pass has the harshest named one. In dark it lightens the faint
    // grey, so the dark pass has none (ORR-855). On this page only, as the setting is shared: chat.spec.ts changes it.
    let tint: string | null = null
    await page.route(/\/api\/settings$/, async route => {
        const response = await route.fetch()
        if (route.request().method() !== 'GET') return route.fulfill({response})
        await route.fulfill({response, json: {...await response.json(), tint}})
    })
    await setAdvanced(page, true)
    for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({colorScheme})
        tint = colorScheme === 'light' ? 'violet' : null
        for (const route of ROUTES()) {
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
    await request.put('/api/projects/atlas/docs/wide-code', {headers: AGENT, data: {
        title: 'Wide code',
        body: `\`\`\`sh\ncurl -fsSL http://localhost:9000/${wide} | sh\n\`\`\`\n\n| ${wide} | b | c | d | e |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |\n`,
    }}).then(r => expect(r.ok(), 'the doc').toBeTruthy())
    await page.setViewportSize({width: 390, height: 800})
    await setAdvanced(page, true)
    for (const route of [...ROUTES(), {path: '/p/atlas/docs/wide-code', heading: 'Wide code'}]) {
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
    await setAdvanced(page, true)
    // Short enough that each page has to scroll, and wide enough for a phone's layout not to apply.
    await page.setViewportSize({width: 1280, height: 320})
    for (const route of ROUTES()) {
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
            const elsewhere = route.path === '/mine' ? '/connect' : !route.path.startsWith('/p/') ? '/mine' : route.path === '/p/atlas/settings' ? '/p/atlas' : '/p/atlas/settings'
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
    const section = path.match(/^\/p\/atlas\/(roadmap|releases|docs|settings|issues)/)?.[1]
    if (!section) return path
    return section === 'issues' ? '/p/atlas' : `/p/atlas/${section}`
}
