import type {Browser, Page} from '@playwright/test'
import {expect, test} from '@playwright/test'

// Someone new signs up into a workspace of their own (ORR-1180, ORR-1221), on an orrery with login on and a login
// provider, through the real path: the login page, the provider, the callback, the first route, the sidebar and the
// event stream. The unit and cargo tests stub the credential, so this is where holding workspaces apart is checked
// whole (ORR-1104). In order: the first account in becomes the owner (ORR-1185), then a second signs up, so the tests
// share one server's state and run in turn.
test.describe.configure({mode: 'serial'})

let ownerPage: Page
let newPage: Page

/** Signs a fresh browser in as `name` at the provider, as a person picks their account there, from the login page. */
async function logIn(browser: Browser, baseURL: string, sub: string, name: string): Promise<Page> {
    const status = await (await fetch(`${baseURL}/api/auth/status`)).json() as {oidc: boolean}
    expect(status.oidc).toBe(true)
    const provider = await providerOf(baseURL)
    expect((await fetch(`${provider}/next`, {method: 'POST', body: JSON.stringify({sub, name})})).ok).toBe(true)
    const page = await (await browser.newContext()).newPage()
    await page.goto('/')
    await expect(page).toHaveURL(/\/login$/)
    await page.getByRole('link', {name: 'Sign in or sign up'}).click()
    await expect(page).not.toHaveURL(/\/login/)
    return page
}

/** Where the server sends a browser to log in: the provider's address, read from the way out as a browser follows it. */
async function providerOf(baseURL: string): Promise<string> {
    const start = await fetch(`${baseURL}/api/auth/oidc/start`, {redirect: 'manual'})
    return new URL(start.headers.get('location')!).origin
}

/** The welcome's last step makes the first project, as a new person with none is walked through it (ORR-1194). */
async function makeFirstProject(page: Page, name: string) {
    const welcome = page.getByRole('dialog', {name: 'Welcome'})
    await expect(welcome).toBeVisible()
    while (!await welcome.getByLabel('Project name').isVisible()) await welcome.getByRole('button', {name: 'Skip', exact: true}).click()
    await welcome.getByLabel('Project name').fill(name)
    await welcome.getByRole('button', {name: 'Make it'}).click()
    await expect(page.getByRole('heading', {name}).first()).toBeVisible()
}

/** What `page`'s own event stream hears, as the page's plugin opens it (`/api/events?patch=1`), kept on the window. */
async function listen(page: Page) {
    await page.evaluate(() => new Promise<void>(resolve => {
        const heard: {event: string, data: string}[] = []
        Object.assign(window, {heard})
        const events = new EventSource('/api/events?patch=1')
        for (const name of ['patch', 'project', 'removed']) events.addEventListener(name, e => heard.push({event: name, data: (e as MessageEvent).data}))
        events.addEventListener('ready', () => resolve())
    }))
}

const heard = (page: Page) => page.evaluate(() => (window as unknown as {heard: {event: string, data: string}[]}).heard.map(h => h.data).join('\n'))

const switcherNames = async (page: Page) => {
    await page.getByTestId('workspace-switcher').getByRole('button').first().click()
    const names = await page.getByRole('menuitem').allInnerTexts()
    await page.keyboard.press('Escape')
    return names.join('\n')
}

test.afterAll(async () => {
    await ownerPage?.context().close()
    await newPage?.context().close()
})

test('the first account in becomes the owner, and makes a project', async ({browser, baseURL}) => {
    ownerPage = await logIn(browser, baseURL!, 'ada', 'Ada Lovelace')
    await makeFirstProject(ownerPage, 'Greenhouse')
    await expect(ownerPage).toHaveURL(/\/greenhouse/)
})

test('someone new signs up into a workspace of their own, with the welcome', async ({browser, baseURL}) => {
    newPage = await logIn(browser, baseURL!, 'grace', 'Grace Hopper')
    await makeFirstProject(newPage, 'Rockets')
    await expect(newPage).toHaveURL(/\/rockets/)
    await expect(newPage.getByTestId('workspace-switcher').getByRole('button').first()).toContainText('Grace Hopper')
})

test("their sidebar, /projects and the switcher list nothing of the owner's", async () => {
    await newPage.goto('/projects')
    await expect(newPage.getByRole('link', {name: 'Rockets'}).first()).toBeVisible()
    await expect(newPage.getByText('Greenhouse')).toHaveCount(0)
    const names = await switcherNames(newPage)
    expect(names).toContain('Grace Hopper')
    expect(names).not.toContain('Ada Lovelace')
    const projects = await newPage.evaluate(async () => (await (await fetch('/api/projects')).json() as {id: string}[]).map(p => p.id))
    expect(projects).toEqual(['rockets'])
    const workspaces = await newPage.evaluate(async () => (await (await fetch('/api/workspaces')).json() as {name: string}[]).map(w => w.name))
    expect(workspaces).toEqual(['Grace Hopper'])
})

test("going straight to the owner's board gets the not-found page, not the board", async () => {
    const owners = await ownerPage.evaluate(async () => (await (await fetch('/api/workspaces')).json() as {id: string}[]).map(w => w.id))
    expect(owners).toHaveLength(1)
    for (const path of [`/w/${owners[0]}/p/greenhouse`, '/p/greenhouse']) {
        await newPage.goto(path)
        await expect(newPage.getByRole('heading', {name: 'Greenhouse'})).toHaveCount(0)
        await expect(newPage.getByText(/not found|nothing at/i).first()).toBeVisible()
    }
    expect((await newPage.request.get('/api/projects/greenhouse')).status()).toBe(404)
})

test("an issue the owner makes reaches the owner's stream and never the new person's", async () => {
    for (const [page, name] of [[ownerPage, 'Greenhouse'], [newPage, 'Rockets']] as const) {
        await page.goto(`/p/${name.toLowerCase()}`)
        await expect(page.getByRole('heading', {name}).first()).toBeVisible()
        await page.waitForLoadState('networkidle')
    }
    await listen(ownerPage)
    await listen(newPage)
    const made = await ownerPage.evaluate(async () => {
        const response = await fetch('/api/projects/greenhouse/issues', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({title: 'Water the tomatoes'})})
        return response.status
    })
    expect(made).toBe(201)
    // The owner's stream hears it: what the new person's must not.
    await expect.poll(() => heard(ownerPage)).toContain('Water the tomatoes')
    await newPage.waitForTimeout(1_000)
    expect(await heard(newPage)).not.toMatch(/greenhouse|Water the tomatoes/i)
})

test("in turn, the owner sees nothing of the new workspace's", async () => {
    const projects = await ownerPage.evaluate(async () => (await (await fetch('/api/projects')).json() as {id: string}[]).map(p => p.id))
    expect(projects).toEqual(['greenhouse'])
    expect(await switcherNames(ownerPage)).not.toContain('Grace Hopper')
    expect((await ownerPage.request.get('/api/projects/rockets')).status()).toBe(404)
    await ownerPage.goto('/p/rockets')
    await expect(ownerPage.getByRole('heading', {name: 'Rockets'})).toHaveCount(0)
})

test('they delete a workspace of theirs on its own from Settings, once its name is typed (ORR-1203)', async () => {
    const made = await newPage.evaluate(async () => (await fetch('/api/workspaces', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'Scratch'})})).status)
    expect(made).toBe(201)
    await newPage.goto('/settings#account')
    const spaces = newPage.getByRole('list', {name: 'Your workspaces'})
    await expect(spaces.getByRole('listitem')).toHaveCount(2)
    await spaces.getByRole('listitem').filter({hasText: 'Scratch'}).getByRole('button', {name: 'Delete'}).click()
    const go = newPage.getByRole('button', {name: 'Delete workspace'})
    await expect(go).toBeDisabled()
    await newPage.getByLabel('Type its name, Scratch, to confirm').fill('scratch')
    await go.click()
    await expect(spaces.getByRole('listitem')).toHaveCount(1)
    await expect(spaces).toContainText('Grace Hopper')
    const workspaces = await newPage.evaluate(async () => (await (await fetch('/api/workspaces')).json() as {name: string}[]).map(w => w.name))
    expect(workspaces).toEqual(['Grace Hopper'])
})

test('they delete their account, with their workspace, and are signed out; the owner keeps theirs (ORR-1203)', async () => {
    await newPage.goto('/settings#account')
    const account = newPage.getByRole('group', {name: 'Delete my account'})
    await expect(account).toContainText('Goes with it: Grace Hopper')
    const go = account.getByRole('button', {name: 'Delete my account'})
    await expect(go).toBeDisabled()
    await account.getByLabel('Type your name, Grace Hopper, to confirm').fill('grace hopper')
    await go.click()
    await expect(newPage).toHaveURL(/\/login$/)
    expect((await newPage.request.get('/api/me')).status()).toBe(401)
    // Her workspace and its board are gone; the owner's is as it was, and she's no longer among the people.
    const people = await ownerPage.evaluate(async () => (await (await fetch('/api/people')).json() as {id: string, name: string}[]))
    expect(JSON.stringify(people)).not.toMatch(/grace/i)
    expect(await ownerPage.evaluate(async () => (await fetch('/api/projects/greenhouse')).status)).toBe(200)
    expect(await ownerPage.evaluate(async () => (await fetch('/api/projects/rockets')).status)).toBe(404)
})

/** Who the page's browser is signed in as, by the server's word. */
const whoIs = async (page: Page) => (await (await page.request.get('/api/auth/status')).json() as {person?: string}).person

test("signing out ends the provider's session too, so the next sign-in can be someone else (ORR-1319)", async ({baseURL}) => {
    const provider = await providerOf(baseURL!)
    await ownerPage.goto('/')
    expect(await whoIs(ownerPage)).toBe('ada_lovelace')
    // What the browser keeps is Ada's (ORR-1391), and the API's answers aren't kept in its cache.
    expect((await ownerPage.request.get('/api/auth/status')).headers()['cache-control']).toBe('no-store')
    const kept = (key: string) => ownerPage.evaluate(k => localStorage.getItem(k), key)
    expect(await kept('orrery-storage-person')).toBe('ada_lovelace')
    await ownerPage.evaluate(() => {
        localStorage.setItem('orrery-read-docs', '{"rockets/plan":"Ada\'s private doc"}')
        localStorage.setItem('orrery-theme', 'dark')
    })
    await ownerPage.getByRole('complementary').first().getByRole('button', {name: 'Sign out'}).click()
    await expect(ownerPage).toHaveURL(/\/login(\?state=.+)?$/)
    // Signing out leaves nothing of hers in the browser but how it's laid out.
    expect(await kept('orrery-read-docs')).toBeNull()
    expect(await kept('orrery-storage-person')).toBeNull()
    expect(await kept('orrery-theme')).toBe('dark')
    const {logout} = await (await fetch(`${provider}/seen`)).json() as {logout: Record<string, string>}
    expect(logout.post_logout_redirect_uri).toBe(`${baseURL}/login`)
    expect(logout.client_id).toBe('orrery-e2e')
    expect(logout.id_token_hint?.split('.')).toHaveLength(3)
    // The provider's session is gone: signing in again is whoever signs in there now, not Ada straight back.
    expect((await fetch(`${provider}/next`, {method: 'POST', body: JSON.stringify({sub: 'alan', name: 'Alan Turing'})})).ok).toBe(true)
    await ownerPage.getByRole('link', {name: 'Sign in or sign up'}).click()
    await expect(ownerPage).not.toHaveURL(/\/login/)
    expect(await whoIs(ownerPage)).toBe('alan_turing')
    await expect.poll(() => ownerPage.evaluate(() => localStorage.getItem('orrery-storage-person'))).toBe('alan_turing')
})

test("“Sign in as someone else” shows the provider's form, though it's still signed in there (ORR-1319)", async ({baseURL}) => {
    const provider = await providerOf(baseURL!)
    // Alan's marks, which signing out of orrery alone (below) doesn't clear: Ada signing in next does (ORR-1391).
    await ownerPage.evaluate(() => localStorage.setItem('orrery-seen', '{"alan/ALN-1":"2026-11-23"}'))
    // Out of orrery alone, as a session that ran out is: the provider still has Alan. Off the app first, as its own
    // next fetch would meet the 401 and send it to /login itself, aborting the goto below (ORR-1419).
    await ownerPage.goto('about:blank')
    expect((await ownerPage.request.post('/api/auth/logout', {headers: {'Orrery-Sent-Origin': baseURL!}})).ok()).toBe(true)
    await ownerPage.goto('/login')
    const forms = (await (await fetch(`${provider}/seen`)).json() as {forms: number}).forms
    expect((await fetch(`${provider}/next`, {method: 'POST', body: JSON.stringify({sub: 'ada', name: 'Ada Lovelace'})})).ok).toBe(true)
    await ownerPage.getByRole('link', {name: 'Sign in as someone else'}).click()
    await expect(ownerPage.getByRole('heading', {name: 'Sign in at the test provider'})).toBeVisible()
    await expect(ownerPage.getByText('Signed in here as Alan Turing')).toBeVisible()
    expect((await (await fetch(`${provider}/seen`)).json() as {forms: number}).forms).toBe(forms + 1)
    await ownerPage.getByRole('link', {name: 'Continue as Ada Lovelace'}).click()
    await expect(ownerPage).not.toHaveURL(/\/login|\/authorize/)
    expect(await whoIs(ownerPage)).toBe('ada_lovelace')
    await expect.poll(() => ownerPage.evaluate(() => localStorage.getItem('orrery-storage-person'))).toBe('ada_lovelace')
    expect(await ownerPage.evaluate(() => localStorage.getItem('orrery-seen') ?? '')).not.toContain('ALN-1')
})
