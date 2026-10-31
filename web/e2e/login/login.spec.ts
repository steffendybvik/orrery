import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import type {Page} from '@playwright/test'
import {expect, test} from '@playwright/test'

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
    await expect(page.getByText('pnpm orrery:claim')).toBeHidden()
    await refusedAtTheDoor(page, NOT_A_KEY)
})

test('a person key reaches the board, and writes work from there', async ({page}) => {
    await signedIn(page)
    await page.getByRole('button', {name: 'New project'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New project'})
    await dialog.getByLabel('Name').fill('Greenhouse')
    await dialog.getByRole('button', {name: /Create project/}).click()
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
