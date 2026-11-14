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
