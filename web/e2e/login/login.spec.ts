import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import type {Page} from '@playwright/test'
import {devices, expect, test} from '@playwright/test'

// The story of a new server with login on (ORR-699), in order: nobody can log in, it's claimed, and the owner signs in, makes
// keys and logs out. So the tests share one server's state, and run in turn.
test.describe.configure({mode: 'serial'})

const WEB = fileURLToPath(new URL('../..', import.meta.url))
const NOT_A_KEY = 'orrery_person_not-a-key'

let personKey = ''
let agentKey = ''

/** Runs what the owner runs on the server, and gives back the key it prints. */
function claim(): string {
    const said = execFileSync('node', ['scripts/claim.mjs', '--name', 'Ada Lovelace'], {cwd: WEB, encoding: 'utf8', env: {...process.env, NUXT_DATABASE: '.data/e2e-login.db'}})
    const key = /orrery_person_\S+/.exec(said)?.[0]
    expect(key, said).toBeTruthy()
    return key!
}

async function signIn(page: Page, key: string) {
    await page.goto('/login')
    await page.getByLabel('Person key').fill(key)
    await page.getByRole('button', {name: 'Sign in with a key'}).click()
}

const signedIn = async (page: Page) => {
    await signIn(page, personKey)
    await expect(page).not.toHaveURL(/\/login/)
}

async function refusedAtTheDoor(page: Page, key: string) {
    await signIn(page, key)
    await expect(page.locator('p.text-rose-700')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
}

const keyRow = (page: Page, name: string) => page.getByRole('listitem').filter({hasText: name})

test('a logged-out browser lands on the login page, reads nothing, and is told to claim the server', async ({page}) => {
    const read: string[] = []
    page.on('request', request => {
        const {pathname} = new URL(request.url())
        if (pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/')) read.push(pathname)
    })
    for (const path of ['/', '/sessions', '/p/anything']) {
        await page.goto(path)
        await expect(page).toHaveURL(/\/login$/)
        await expect(page.getByRole('heading', {name: 'Log in to this orrery'})).toBeVisible()
    }
    await expect(page.getByText('pnpm orrery:claim')).toBeVisible()
    expect(read).toEqual([])
})

test('a wrong key shows the error and stays on the page', async ({page}) => {
    personKey = claim()
    await page.goto('/login')
    await expect(page.getByRole('heading', {name: 'Log in to this orrery'})).toBeVisible()
    await expect(page.getByText('pnpm orrery:claim')).toBeHidden()
    await refusedAtTheDoor(page, NOT_A_KEY)
})

test('a person key reaches the board, and writes work from there', async ({page}) => {
    await signedIn(page)
    // A new owner with no project yet is walked through the welcome (ORR-1194): its last step makes the first one.
    const welcome = page.getByRole('dialog', {name: 'Welcome'})
    await expect(welcome).toBeVisible()
    while (!await welcome.getByLabel('Project name').isVisible()) await welcome.getByRole('button', {name: 'Skip', exact: true}).click()
    await welcome.getByLabel('Project name').fill('Greenhouse')
    await welcome.getByRole('button', {name: 'Make it'}).click()
    await expect(page).toHaveURL(/\/p\/greenhouse/)
    await expect(page.getByRole('heading', {name: 'Greenhouse'})).toBeVisible()
})

test('Settings shows a new key once, and revoking one marks it and stops it', async ({page}) => {
    await signedIn(page)
    await page.goto('/settings?tab=you')
    await expect(page.getByRole('heading', {name: 'Your keys'})).toBeVisible()

    await page.getByLabel('What the key is for').fill('this laptop')
    await page.getByRole('button', {name: 'Make a key'}).click()
    await expect(keyRow(page, 'this laptop')).toContainText('Agent key')
    agentKey = await page.locator('code.select-all').innerText()
    expect(agentKey).toMatch(/^orrery_agent_/)

    await page.getByLabel('What the key is for').fill('a spare')
    await page.getByLabel('Kind of key').selectOption('person')
    await page.getByRole('button', {name: 'Make a key'}).click()
    await expect(keyRow(page, 'a spare')).toContainText('Person key')
    const spare = await page.locator('code.select-all').innerText()
    expect(spare).toMatch(/^orrery_person_/)

    await page.reload()
    await expect(keyRow(page, 'a spare')).toBeVisible()
    await expect(page.locator('code.select-all')).toBeHidden()
    await expect(page.getByText(spare)).toBeHidden()

    await page.getByRole('button', {name: 'Revoke a spare'}).click()
    await expect(page.getByRole('button', {name: 'Revoke a spare'})).toBeHidden()
    await expect(keyRow(page, 'a spare')).toHaveClass(/line-through/)
    await page.context().clearCookies()
    await refusedAtTheDoor(page, spare)
})

test("an agent key can't sign in to the page", async ({page}) => {
    await refusedAtTheDoor(page, agentKey)
})

test("logging out returns to the login page, and going back doesn't reopen the board", async ({page}) => {
    await signedIn(page)
    await page.goto('/settings?tab=you')
    await page.getByRole('button', {name: 'Log out'}).click()
    await expect(page).toHaveURL(/\/login$/)
    await page.goBack()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', {name: 'Log in to this orrery'})).toBeVisible()
    expect((await page.request.get('/api/projects')).status()).toBe(401)
})

test('a login ended while the page is open goes back to the login page', async ({page, context}) => {
    await signedIn(page)
    const other = await context.newPage()
    await other.goto('/settings?tab=you')
    await other.getByRole('button', {name: 'Log out'}).click()
    await expect(other).toHaveURL(/\/login$/)
    await other.close()

    // The next thing the first tab asks for is refused.
    await page.getByRole('link', {name: 'Sessions'}).first().click()
    await expect(page).toHaveURL(/\/login$/)
})

// Signing a phone in by App settings' QR code (ORR-837, ORR-845), as the owner does: the code carries a one-time link to
// the phone's own port, read here from the request that makes it, as a camera reads it off the code. Under `nuxt dev` the
// phone's listener serves the server alone, not Vite's modules (a built orrery serves both), so the page can't start there:
// the phone sends what the login page sends on it, through its own port, whose login cookie is its own (named for the
// port, #889). The page's side of a link is checked below, on the sessions' address.
test("App settings' QR link signs a phone in on its own port, once, and lists its login", async ({page, browser}) => {
    await signedIn(page)
    const made = page.waitForResponse(response => response.url().endsWith('/api/phone/link') && response.request().method() === 'POST')
    await page.goto('/settings?tab=you#phone')
    const {token} = await (await made).json() as {token: string}
    const section = page.locator('#phone')
    const address = await section.getByRole('button', {name: /^Show the QR code for /}).first().innerText()
    // The phone port's address, not the sessions' one the page is on.
    expect(new URL(address).port).not.toBe(new URL(page.url()).port)
    await expect(section.getByRole('img', {name: `QR code for ${address}`})).toBeVisible()
    const path = `/login?t=${token}`

    const phone = await browser.newContext({...devices['iPhone 13']})
    expect((await phone.request.get(`${address}/api/projects`)).status()).toBe(401)
    // What login.vue sends with the link's `t`, on the port the code leads to.
    expect((await phone.request.post(`${address}/api/auth/link`, {data: {token}})).status()).toBe(201)
    // Signed in, the phone reads through its own port, which asked for a login a moment ago.
    expect((await phone.request.get(`${address}/api/projects`)).status()).toBe(200)
    await phone.close()

    // The list is read as the section shows, so it's opened afresh, as the owner coming back to it would.
    await page.goto('/settings?tab=you#logins')
    await page.reload()
    await expect(page.locator('#logins').getByRole('listitem').filter({hasText: 'Phone, signed in by QR code'})).toHaveCount(1)

    // Used once, the same link signs nobody else in, on either port.
    const another = await browser.newContext()
    expect((await another.request.post(`${address}/api/auth/link`, {data: {token}})).status()).toBe(401)
    const again = await another.newPage()
    await again.goto(new URL(path, page.url()).href)
    await expect(again.getByText(/used or has run out/)).toBeVisible()
    await expect(again).toHaveURL(/\/login$/)
    await another.close()
})

// The code under the QR (ORR-875), typed on the phone's login page, from an app on the home screen that has no camera
// and keeps cookies apart from the browser's: it signs the phone in on its own port, once, and uses up the QR's link.
test("App settings' code signs a phone in on its own port, once, in place of the QR", async ({page, browser}) => {
    await signedIn(page)
    const made = page.waitForResponse(response => response.url().endsWith('/api/phone/link') && response.request().method() === 'POST')
    await page.goto('/settings?tab=you#phone')
    const {token} = await (await made).json() as {token: string}
    const section = page.locator('#phone')
    const shown = await section.getByTestId('phone-code').innerText()
    expect(shown).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/)
    const address = await section.getByRole('button', {name: /^Show the QR code for /}).first().innerText()

    const phone = await browser.newContext({...devices['iPhone 13']})
    // What login.vue sends with a typed code, however it's typed.
    expect((await phone.request.post(`${address}/api/auth/link`, {data: {code: shown.toLowerCase()}})).status()).toBe(201)
    expect((await phone.request.get(`${address}/api/projects`)).status()).toBe(200)
    await phone.close()

    const another = await browser.newContext()
    expect((await another.request.post(`${address}/api/auth/link`, {data: {code: shown}})).status()).toBe(401)
    expect((await another.request.post(`${address}/api/auth/link`, {data: {token}})).status()).toBe(401)
    await another.close()
})

// Connecting a machine with no key to copy (ORR-1192), as the launcher does it from the install line. Run without a
// code, it asks, and the page it opens, signed in after a stop at the login page, shows the words the Terminal shows;
// Connect hands the waiting launcher an agent key. Copied from the signed-in page, the line's own code does it at once.
test('a machine connects from the install line, by the Connect page or the line\'s code', async ({page, browser}) => {
    const machine = await browser.newContext()
    const asked = await machine.request.post('/api/machines/connect', {data: {name: "Ada's MacBook"}})
    expect(asked.status()).toBe(201)
    const {request, secret, words, url} = await asked.json() as {request: string, secret: string, words: string, url: string}
    const claim = () => machine.request.post('/api/machines/claim', {data: {request, secret}})
    expect((await claim()).status()).toBe(202)

    // Logged out, the page goes by the login page and comes back.
    await page.context().clearCookies()
    expect(url).toMatch(new RegExp(`/connect-machine\\?request=${request}$`))
    await page.goto(`/connect-machine?request=${request}`)
    await expect(page).toHaveURL(/\/login$/)
    await signIn(page, personKey)
    await expect(page).toHaveURL(/\/connect-machine\?request=/)
    await expect(page.getByTestId('connect-machine-words')).toHaveText(words)
    await page.getByTestId('connect-machine-go').click()
    await expect(page.getByRole('heading', {name: 'Connected'})).toBeVisible()

    const claimed = await claim()
    expect(claimed.status()).toBe(201)
    const {key} = await claimed.json() as {key: string}
    expect(key).toMatch(/^orrery_agent_/)
    expect((await machine.request.get('/api/projects', {headers: {authorization: `Bearer ${key}`}})).status()).toBe(200)
    expect((await claim()).status()).toBe(410)

    // The line copied from the signed-in page carries a code, good once.
    const made = await page.evaluate(async () => (await fetch('/api/machines/code', {method: 'POST', headers: {'Content-Type': 'application/json'}})).json()) as {code: string}
    const byCode = await machine.request.post('/api/machines/connect', {data: {name: 'Rig', code: made.code}})
    expect(byCode.status()).toBe(201)
    expect((await byCode.json() as {key: string}).key).toMatch(/^orrery_agent_/)
    expect((await machine.request.post('/api/machines/connect', {data: {name: 'Rig', code: made.code}})).status()).toBe(401)
    await machine.close()

    // Both are listed as the owner's keys, by the machine's name, to disconnect from there.
    await page.goto('/settings?tab=you#keys')
    for (const name of ["Ada's MacBook", 'Rig']) await expect(keyRow(page, name)).toHaveCount(1)
})
