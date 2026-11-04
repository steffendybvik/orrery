import type {Page} from '@playwright/test'
import {expect, test} from '@playwright/test'
import {makeProject} from './support'

// A read a page waits on that fails says so, with the server's reason and a Try again, in place of a spinner that never
// stops, or of an empty page that says there's nothing there (ORR-854).
test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Scree', key: 'SCR'})
})

/** Answers the reads at `path` (and its query) with a 500 until the returned function is called. */
async function failing(page: Page, path: RegExp) {
    let failing = true
    await page.route('**/api/**', route => {
        const url = new URL(route.request().url())
        if (failing && route.request().method() === 'GET' && path.test(url.pathname + url.search))
            return route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({statusCode: 500, message: 'The database is locked'})})
        return route.continue()
    })
    return () => { failing = false }
}

for (const colorScheme of ['light', 'dark'] as const) {
    test(`the projects failing to load says so on every page, and Try again reads them (${colorScheme})`, async ({page}) => {
        await page.emulateMedia({colorScheme})
        const recover = await failing(page, /^\/api\/projects\?/)
        await page.goto('/mine')
        const alert = page.getByRole('alert')
        await expect(alert).toContainText("Couldn't load the projects")
        await expect(alert).toContainText('The database is locked')
        // Not "make your first project": there may well be some.
        await expect(page.getByText('Make a project')).toHaveCount(0)
        await page.goto('/p/scree')
        await expect(alert).toContainText("Couldn't load the projects")
        await expect(page.getByText('No project “scree”')).toHaveCount(0)
        recover()
        await alert.getByRole('button', {name: 'Try again'}).click()
        await expect(page.getByRole('heading', {name: 'Scree'})).toBeVisible()
        await expect(alert).toHaveCount(0)
    })
}

test('a page whose own read fails names it, and Try again reads it', async ({page}) => {
    const recover = await failing(page, /^\/api\/(schedules|releases|notices\?)/)
    await page.goto('/schedules')
    const alert = page.getByRole('alert')
    await expect(alert).toContainText("Couldn't load the schedules")
    // It doesn't claim there's nothing scheduled while it doesn't know.
    await expect(page.getByText('Nothing scheduled')).toHaveCount(0)
    await page.goto('/releases')
    await expect(alert).toContainText("Couldn't load the releases")
    await page.goto('/notifications')
    await expect(alert).toContainText("Couldn't load the notifications")
    recover()
    await alert.getByRole('button', {name: 'Try again'}).click()
    await expect(alert).toHaveCount(0)
    await expect(page.getByRole('status', {name: 'Loading'})).toHaveCount(0)
})
