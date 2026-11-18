import type {APIRequestContext, Page} from '@playwright/test'
import {expect, test} from './test'

// On a phone: the sidebar is a drawer behind the menu button that closes once a page is picked, and the
// project and an issue's page fit the screen's width. A project of its own; the owner named if no one has yet.
test.use({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true})

const api = (request: APIRequestContext, method: 'get' | 'post' | 'put', path: string, data?: object) =>
    request[method](`/api${path}`, {data}).then(async r => {
        expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy()
        return r.json()
    })

/** Whether the page scrolls sideways, which on a phone means something doesn't fit. */
const scrollsSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)

let id = ''

test.beforeAll(async ({request}) => {
    if (!(await api(request, 'get', '/owner')).named) await api(request, 'put', '/owner', {name: 'Ada Lovelace'})
    await api(request, 'post', '/projects', {name: 'Pocket', key: 'POC'})
    id = (await api(request, 'post', '/projects/pocket/issues', {
        title: 'A title long enough that it has to wrap, or be cut short, on the narrow screen of a phone',
        status: 'todo',
        labels: ['bug', 'feature request'],
    })).id
})

test('the sidebar is a drawer behind the menu button, gone again once a page is picked', async ({page}) => {
    await page.goto('/mine')
    const drawer = page.locator('aside')
    await expect(drawer).not.toBeInViewport()
    await page.getByRole('button', {name: 'Open the sidebar'}).tap()
    await expect(drawer).toBeInViewport()
    await drawer.getByRole('link', {name: 'Pocket'}).tap()
    await expect(page).toHaveURL(/\/pocket/)
    await expect(drawer).not.toBeInViewport()
    // Its own button closes it too.
    await page.getByRole('button', {name: 'Open the sidebar'}).tap()
    await expect(drawer).toBeInViewport()
    await drawer.getByRole('button', {name: 'Close the menu'}).tap()
    await expect(drawer).not.toBeInViewport()
})

test("the drawer's foot has GitHub and, beside it, orrery's releases (ORR-609)", async ({page}) => {
    await page.goto('/mine')
    await page.getByRole('button', {name: 'Open the sidebar'}).tap()
    const drawer = page.locator('aside')
    const github = drawer.getByRole('link', {name: 'GitHub', exact: true})
    const releases = drawer.getByRole('link', {name: 'orrery releases'})
    await expect(github).toHaveAttribute('href', 'https://github.com/steffendybvik/orrery')
    await expect(releases).toHaveAttribute('href', 'https://github.com/steffendybvik/orrery/releases')
    await expect(releases).toHaveAttribute('target', '_blank')
    await expect(releases).toBeInViewport({ratio: 1})
    // One row: orrery's releases to GitHub's right.
    const [g, r] = [await github.boundingBox(), await releases.boundingBox()]
    expect(r!.x).toBeGreaterThanOrEqual(g!.x + g!.width)
    expect(Math.abs(r!.y - g!.y)).toBeLessThan(4)
    expect(await scrollsSideways(page)).toBe(false)
})

test("the project and an issue's page fit the screen", async ({page}) => {
    await page.goto('/p/pocket?view=list')
    const row = page.locator(`[data-issue="${id}"]`)
    await expect(row).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
    await row.tap()
    await expect(page).toHaveURL(`/w/default/pocket/issues/${id}`)
    await expect(page.getByRole('heading', {name: /A title long enough/})).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
})

test("a row's title wraps to two lines, its id small under it rather than a column of its own (ORR-1218)", async ({page}) => {
    await page.goto('/p/pocket?view=list')
    const row = page.locator(`[data-issue="${id}"]`)
    const title = row.getByText(/A title long enough/)
    const under = row.getByText(id, {exact: true}).filter({visible: true})
    // The id is drawn once: the desktop column is hidden.
    await expect(under).toHaveCount(1)
    const [t, u] = [await title.boundingBox(), await under.boundingBox()]
    // Two lines of the title, and the id below them, starting where the title does.
    expect(t!.height).toBeGreaterThan(30)
    expect(u!.y).toBeGreaterThanOrEqual(t!.y + t!.height - 1)
    expect(Math.abs(u!.x - t!.x)).toBeLessThan(2)
})

test('key hints aren\'t drawn on a touch screen, which has no keys to press (ORR-817)', async ({page}) => {
    await page.goto('/mine')
    await page.getByRole('button', {name: 'Open the sidebar'}).tap()
    const drawer = page.locator('aside')
    await expect(drawer.getByRole('button', {name: /Jump to/})).toBeVisible()
    await expect(drawer.locator('kbd')).not.toHaveCount(0)
    for (const hint of await drawer.locator('kbd').all()) await expect(hint).toBeHidden()
})

test("the sidebar's small buttons are at least 24px to tap, WCAG 2.2's minimum (ORR-816)", async ({page}) => {
    await page.goto('/mine')
    await page.getByRole('button', {name: 'Open the sidebar'}).tap()
    const drawer = page.locator('aside')
    await expect(drawer).toBeInViewport()
    const small = [
        drawer.getByRole('button', {name: /^(Open|Fold) every project$/}),
        drawer.getByRole('button', {name: 'New project'}),
        drawer.getByRole('button', {name: /^(Open|Fold) Pocket$/}),
    ]
    const start = drawer.getByRole('button', {name: 'Start a session'})
    if (await start.count()) small.push(start)
    for (const button of small) {
        const box = (await button.boundingBox())!
        expect(box.width, await button.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(24)
        expect(box.height, await button.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(24)
    }
})

/** The text size of each field on the page a person can type in, by its label or placeholder. */
const fieldSizes = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('input, textarea, select')]
    .filter(f => !['checkbox', 'radio', 'hidden', 'range', 'color', 'file'].includes((f as HTMLInputElement).type) && f.getClientRects().length)
    .map(f => ({field: f.getAttribute('aria-label') || f.getAttribute('placeholder') || f.tagName, size: parseFloat(getComputedStyle(f).fontSize)})))

test("a field's text is 16px on a touch screen, so iOS doesn't zoom in as it takes the focus (ORR-843)", async ({page}) => {
    await page.goto(`/p/pocket/issues/${id}`)
    await expect(page.getByRole('heading', {level: 1})).toBeVisible()
    const sizes = await fieldSizes(page)
    expect(sizes.length).toBeGreaterThan(0)
    for (const {field, size} of sizes) expect(size, field).toBeGreaterThanOrEqual(16)
})

// The Agent button sits over the right of each row on a phone, where its assignee is: it tucks away while the page
// scrolls down, and is back on scrolling up and at the page's end, which has room for it (ORR-1282).
test('the Agent button tucks away while the page scrolls down, and is back on scrolling up or at the end', async ({page, request}) => {
    await api(request, 'post', '/projects', {name: 'Tall', key: 'TAL'})
    for (let i = 1; i <= 30; i++) await api(request, 'post', '/projects/tall/issues', {title: `Row ${i}`, status: 'todo'})
    await page.goto('/p/tall?view=list')
    await expect(page.getByText('Row 30')).toBeVisible()
    const agent = page.getByRole('button', {name: 'Agent', exact: true})
    await expect(agent).toBeInViewport()
    const scroller = page.locator('main .clear-agent').first()
    const scrollBy = (y: number) => scroller.evaluate((el, by) => el.scrollBy(0, by), y)
    await scrollBy(200)
    await expect(agent).toHaveAttribute('data-tucked')
    await expect(agent).not.toBeInViewport()
    await scrollBy(-100)
    await expect(agent).not.toHaveAttribute('data-tucked')
    await expect(agent).toBeInViewport()
    await scrollBy(200)
    await expect(agent).toHaveAttribute('data-tucked')
    // At the end it's back, and clear of the last row.
    await scroller.evaluate(el => el.scrollTo(0, el.scrollHeight))
    await expect(agent).not.toHaveAttribute('data-tucked')
    const last = await scroller.locator('[data-issue]').last().boundingBox()
    const button = await agent.boundingBox()
    expect(last!.y + last!.height).toBeLessThanOrEqual(button!.y)
})

test.describe('on a desktop', () => {
    test.use({viewport: {width: 1280, height: 800}, isMobile: false, hasTouch: false})

    test("a field's text stays as small as its class says (ORR-843)", async ({page}) => {
        await page.goto(`/p/pocket/issues/${id}`)
        await expect(page.getByRole('heading', {level: 1})).toBeVisible()
        const sizes = await fieldSizes(page)
        expect(sizes.some(({size}) => size < 16), JSON.stringify(sizes)).toBe(true)
    })
})

// Below `sm` the filters other than the text box fold into a Filters button (ORR-1281), which opens them in a list
// and counts the ones narrowing what shows.
test('the filters sit behind a Filters button that counts the ones set', async ({page}) => {
    await page.goto('/p/pocket')
    const button = page.getByRole('button', {name: 'Filters', exact: true})
    await expect(button).toBeVisible()
    await expect(page.getByRole('button', {name: /^Priority/})).toBeHidden()
    await button.tap()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('button', {name: /^Priority/}).tap()
    await page.getByRole('option', {name: /P1 · High/}).tap()
    await expect(page.getByRole('button', {name: 'Filters · 1'})).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
    // A tap outside closes the list; the count stays, and Clear goes back.
    await page.getByRole('heading', {level: 1}).first().tap()
    await expect(page.getByRole('button', {name: /^Priority/})).toBeHidden()
    await page.getByRole('button', {name: 'Clear'}).tap()
    await expect(page.getByRole('button', {name: 'Filters', exact: true})).toBeVisible()
})
