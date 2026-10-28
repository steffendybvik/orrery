import type {APIRequestContext, Page} from '@playwright/test'
import {expect, test} from '@playwright/test'

// On a phone: the sidebar is a drawer behind the menu button that closes once a page is picked, and the
// project and an issue's page fit the screen's width. A project of its own; the owner named if no one has yet.
test.describe.configure({mode: 'serial'})
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
    await expect(page).toHaveURL(/\/p\/pocket/)
    await expect(drawer).not.toBeInViewport()
    // Its own button closes it too.
    await page.getByRole('button', {name: 'Open the sidebar'}).tap()
    await expect(drawer).toBeInViewport()
    await drawer.getByRole('button', {name: 'Close the menu'}).tap()
    await expect(drawer).not.toBeInViewport()
})

test("the project and an issue's page fit the screen", async ({page}) => {
    await page.goto('/p/pocket?view=list')
    const row = page.locator(`[data-issue="${id}"]`)
    await expect(row).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
    await row.tap()
    await expect(page).toHaveURL(`/p/pocket/issues/${id}`)
    await expect(page.getByRole('heading', {name: /A title long enough/})).toBeVisible()
    expect(await scrollsSideways(page)).toBe(false)
})
