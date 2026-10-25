import type {APIRequestContext, Page} from '@playwright/test'
import {expect, test} from '@playwright/test'

// The main flows, in order, on one fresh Orrery: name the owner, make a project, add issues and move
// them, sub-issues, ⌘K, a proposal the owner approves, and a change showing up live in another tab.
test.describe.configure({mode: 'serial'})

const AGENT = {'Orrery-Actor': 'claude'}
const api = (request: APIRequestContext, method: 'get' | 'post' | 'patch', path: string, data?: object, headers = AGENT) =>
    request[method](`/api/projects/larder${path}`, {data, headers}).then(async r => {
        expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy()
        return r.json()
    })

async function newIssue(page: Page, title: string, where: string) {
    await page.goto('/p/larder')
    await page.getByRole('button', {name: 'New issue'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New issue'})
    await dialog.getByLabel('Title').fill(title)
    await dialog.getByLabel('Where').selectOption(where)
    await dialog.getByRole('button', {name: /Create issue/}).click()
    await expect(dialog).toBeHidden()
}

test('asks the owner their name on first open', async ({page, request}) => {
    await page.goto('/')
    const dialog = page.getByRole('dialog', {name: 'Your name'})
    await dialog.getByLabel('Your name').fill('Ada Lovelace')
    await dialog.getByRole('button').last().click()
    await expect(dialog).toBeHidden()
    expect(await (await request.get('/api/owner')).json()).toMatchObject({name: 'ada_lovelace', named: true})
})

test('makes a project', async ({page}) => {
    await page.goto('/')
    await page.getByRole('button', {name: 'New project'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New project'})
    await dialog.getByLabel('Name').fill('Larder')
    await dialog.getByRole('button', {name: /Create project/}).click()
    await expect(page).toHaveURL(/\/p\/larder/)
    await expect(page.getByRole('heading', {name: 'Larder'})).toBeVisible()
})

test('adds issues and moves one on the board', async ({page, request}) => {
    await page.goto('/p/larder')
    await newIssue(page, 'Shelves you can reorder', 'todo')
    await newIssue(page, 'Expiry badges', 'backlog')
    // A new issue opens its page; back to the project, as a board.
    await page.goto('/p/larder')
    await page.getByRole('radio', {name: /Board/}).or(page.getByRole('button', {name: /Board/})).first().click()
    const card = page.locator('[data-issue="LAR-1"]')
    await expect(card.getByRole('img', {name: 'Todo'})).toBeVisible()
    await card.click({button: 'right'})
    await page.getByRole('menu').getByRole('button', {name: 'Move to In progress'}).click()
    await expect(card.getByRole('img', {name: 'In progress'})).toBeVisible()
    expect(await api(request, 'get', '/issues/LAR-1')).toMatchObject({status: 'in-progress', kind: 'started'})
})

test('shows sub-issues and their progress on the parent', async ({page, request}) => {
    const one = await api(request, 'post', '/issues', {title: 'Drag to reorder', parent: 'LAR-1'})
    await api(request, 'post', '/issues', {title: 'Reorder with the keyboard', parent: 'LAR-1'})
    await api(request, 'patch', `/issues/${one.id}`, {status: 'done'})
    await page.goto('/p/larder/issues/LAR-1')
    const subs = page.getByRole('heading', {name: /Sub-issues/})
    await expect(subs).toContainText('1/2')
    await expect(page.getByText('Reorder with the keyboard')).toBeVisible()
})

test('⌘K finds an issue and opens it', async ({page}) => {
    await page.goto('/p/larder')
    await expect(page.getByText('Expiry badges')).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog', {name: 'Commands'})
    await palette.getByLabel('Type a command or search').fill('expiry')
    await expect(palette.getByRole('option', {name: /Expiry badges/})).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/p\/larder\/issues\/LAR-2/)
})

test("an agent's proposal waits until the owner approves it", async ({page, request}) => {
    const proposal = await api(request, 'post', '/issues', {title: 'Plan from what expires soonest', proposal: 'pending'})
    expect(proposal).toMatchObject({column: 'proposed', assignee: 'ada_lovelace'})
    await page.goto(`/p/larder/issues/${proposal.id}`)
    await page.getByRole('button', {name: 'Approve'}).click()
    await expect.poll(async () => (await api(request, 'get', `/issues/${proposal.id}`)).proposal).toBe('approved')
    expect((await api(request, 'get', `/issues/${proposal.id}/comments`)).at(-1)).toMatchObject({body: 'Approved this proposal.', createdBy: 'ada_lovelace'})
})

test('a change shows up live in another tab', async ({page, context, request}) => {
    await page.goto('/p/larder')
    const other = await context.newPage()
    await other.goto('/p/larder')
    await expect(other.getByText('Expiry badges')).toBeVisible()
    await api(request, 'patch', '/issues/LAR-2', {title: 'Expiry badges: soon and gone'})
    await expect(page.getByText('Expiry badges: soon and gone')).toBeVisible()
    await expect(other.getByText('Expiry badges: soon and gone')).toBeVisible()
})
