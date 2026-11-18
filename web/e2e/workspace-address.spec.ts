import {expect, test} from './test'
import {makeProject} from './support'

// A page's workspace is in its address (ORR-1108): every page is at `/w/<workspace>/…` (ORR-1275), and the calls a
// page makes carry the workspace from its own address, so two windows can sit in different workspaces at once.

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Lanterns', key: 'LAN'})
})

test('serves each page under /w/<workspace>/, and each window asks in its own', async ({page, context}) => {
    const asked = (on: typeof page) => on.waitForRequest(r => new URL(r.url()).pathname === '/api/epics')

    const inDefault = asked(page)
    await page.goto('/w/default/epics')
    expect((await inDefault).headers()['orrery-workspace']).toBe('default')
    await expect(page.getByRole('button', {name: 'New epic'})).toBeVisible()

    // An old address goes on to its workspace's (ORR-1275), and asks there.
    const other = await context.newPage()
    const plain = asked(other)
    await other.goto('/epics')
    await expect(other).toHaveURL(/\/w\/default\/epics$/)
    expect((await plain).headers()['orrery-workspace']).toBe('default')

    // The first window is still in its own after the second opened.
    const again = asked(page)
    await page.reload()
    expect((await again).headers()['orrery-workspace']).toBe('default')

    await page.goto('/w/default/lanterns')
    await expect(page.getByRole('heading', {name: 'Lanterns'}).first()).toBeVisible()
    // A link's own address is in the workspace, so one opened in a new tab is too.
    await expect(page.locator('aside nav a', {hasText: 'My issues'}).first()).toHaveAttribute('href', '/w/default/mine')
})

// Every page is under its workspace (ORR-1275): an old `/p/…` link, or a project's page under another workspace than
// its own, goes to the project's, as project ids are unique across the orrery.
test("an old link to a project's page goes to the project's own workspace", async ({page, request}) => {
    const suffix = Date.now().toString(36)
    const made = await request.post('/api/workspaces', {data: {name: `Quay ${suffix}`}, headers: {'Orrery-Actor': 'owner'}})
    expect(made.ok(), await made.text()).toBeTruthy()
    const quay = (await made.json()).id as string
    const boat = await request.post('/api/projects', {data: {name: `Ferries ${suffix}`}, headers: {'Orrery-Actor': 'claude', 'Orrery-Workspace': quay}})
    expect(boat.ok(), await boat.text()).toBeTruthy()
    const {id, name} = await boat.json() as {id: string, name: string}

    await page.goto(`/p/${id}`)
    await expect(page).toHaveURL(new RegExp(`/w/${quay}/${id}$`))
    await expect(page.getByRole('heading', {name}).first()).toBeVisible()

    await page.goto(`/w/default/${id}/roadmap`)
    await expect(page).toHaveURL(new RegExp(`/w/${quay}/${id}/roadmap$`))

    // A project can't take a workspace's own page's name.
    const taken = await request.post('/api/projects', {data: {name: 'Settings'}, headers: {'Orrery-Actor': 'claude'}})
    expect(taken.status()).toBe(400)
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
    // Each carries a hash of what's in it (ORR-1255), so an old copy kept at the bare address is never shown, and is served.
    for (const href of await icons(other)) {
        expect(new URL(href).search).toMatch(/^\?v=[0-9a-f]{8}$/)
        expect((await other.request.get(href)).ok(), href).toBe(true)
    }
})

// Neither workspace's projects show in the other's sidebar or Projects page (ORR-1251), and a page with no `/w/` in
// its address shows `default`'s alone, the one it says it's in, not every workspace mixed together.
test("each workspace's sidebar and Projects page list its own projects alone", async ({page, request}) => {
    const suffix = Date.now().toString(36)
    const made = await request.post('/api/workspaces', {data: {name: `Harbour ${suffix}`}, headers: {'Orrery-Actor': 'owner'}})
    expect(made.ok(), await made.text()).toBeTruthy()
    const harbour = (await made.json()).id as string
    const boat = await request.post('/api/projects', {data: {name: `Boats ${suffix}`}, headers: {'Orrery-Actor': 'claude', 'Orrery-Workspace': harbour}})
    expect(boat.ok(), await boat.text()).toBeTruthy()
    const boats = (await boat.json()).name as string

    const sidebar = page.locator('aside').first()
    for (const at of ['/projects', '/w/default/projects']) {
        await page.goto(at)
        await expect(page.getByRole('link', {name: 'Lanterns'}).first()).toBeVisible()
        await expect(page.getByRole('link', {name: boats})).toHaveCount(0)
        await expect(sidebar.getByText(boats)).toHaveCount(0)
    }

    await page.goto(`/w/${harbour}/projects`)
    await expect(page.getByRole('link', {name: boats}).first()).toBeVisible()
    await expect(page.getByRole('link', {name: 'Lanterns'})).toHaveCount(0)
    await expect(sidebar.getByText('Lanterns')).toHaveCount(0)
})
