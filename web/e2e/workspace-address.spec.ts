import {expect, test} from './test'
import {makeProject} from './support'

// A page's workspace is in its address (ORR-1108): every page is also at `/w/<workspace>/…`, and the calls a page makes
// carry the workspace from its own address, so two windows can sit in different workspaces at once.

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Lanterns', key: 'LAN'})
})

test('serves each page under /w/<workspace>/, and each window asks in its own', async ({page, context}) => {
    const asked = (on: typeof page) => on.waitForRequest(r => new URL(r.url()).pathname === '/api/epics')

    const inDefault = asked(page)
    await page.goto('/w/default/epics')
    expect((await inDefault).headers()['orrery-workspace']).toBe('default')
    await expect(page.getByRole('button', {name: 'New epic'})).toBeVisible()

    const other = await context.newPage()
    const plain = asked(other)
    await other.goto('/epics')
    expect((await plain).headers()['orrery-workspace']).toBeUndefined()

    // The first window is still in its own after the second opened.
    const again = asked(page)
    await page.reload()
    expect((await again).headers()['orrery-workspace']).toBe('default')

    await page.goto('/w/default/p/lanterns')
    await expect(page).toHaveURL(/\/w\/default\/p\/lanterns$/)
    await expect(page.getByRole('heading', {name: 'Lanterns'}).first()).toBeVisible()
})

test('the switcher makes a workspace and moves this tab into it, and links stay there', async ({page, context}) => {
    await page.goto('/mine')
    const switcher = page.getByTestId('workspace-switcher')
    await switcher.getByRole('button').first().click()
    await page.getByRole('menuitem', {name: /New workspace/}).click()
    const name = `Lighthouse ${Date.now().toString(36)}`
    await page.getByTestId('workspace-name').fill(name)
    await page.getByRole('button', {name: 'teal'}).click()
    await page.getByRole('button', {name: 'Make it'}).click()

    await expect(page).toHaveURL(/\/w\/lighthouse[^/]*\/mine$/)
    const workspace = /\/w\/([^/]+)\//.exec(new URL(page.url()).pathname)![1]!
    await expect(switcher.getByRole('button').first()).toContainText(name)
    await expect(page.getByTestId('workspace-edge')).toBeVisible()
    await expect(page).toHaveTitle(new RegExp(name))
    // The tab's icon is the logo on the workspace's teal, in place of both orange ones (ORR-1104).
    const icons = (on: typeof page) => on.locator('head link[rel="icon"]').evaluateAll(links => links.map(l => (l as HTMLLinkElement).href))
    await expect.poll(async () => (await icons(page)).map(href => href.startsWith('data:image/svg+xml,') && decodeURIComponent(href).includes('fill="#14b8a6"'))).toEqual([true, true])

    // A link from a page in it stays in it.
    await page.goto(`/w/${workspace}/epics`)
    await page.getByRole('link', {name: 'My issues'}).first().click()
    await expect(page).toHaveURL(new RegExp(`/w/${workspace}/mine$`))

    // Another tab is where its own address says.
    const other = await context.newPage()
    await other.goto('/mine')
    await expect(other.getByTestId('workspace-switcher').getByRole('button').first()).not.toContainText(name)
    expect((await icons(other)).map(href => new URL(href).pathname)).toEqual(['/favicon.ico', '/favicon.svg'])
})
