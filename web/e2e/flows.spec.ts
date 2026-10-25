import type {APIRequestContext, Page} from '@playwright/test'
import {expect, test} from '@playwright/test'

// The main flows, in order, on one fresh Orrery: name the owner, make a project, add issues and move
// them, sub-issues, ⌘K, a proposal the owner approves, a change showing up live in another tab, and the
// issues starting on the open ones; then a chunk made, edited and removed from its page, and an image
// in a new issue and a comment; then a changed doc and what changed in it.
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

test("the owner's picks on a proposal survive a live update before they approve", async ({page, request}) => {
    const choices = [{key: 'store', question: 'Where do the dates live?', pick: 'one', recommended: ['jar'], options: [{key: 'jar', title: 'On each jar'}, {key: 'sheet', title: 'On one sheet'}]}]
    const proposal = await api(request, 'post', '/issues', {title: 'Track expiry dates', proposal: 'pending', choices})
    const other = await api(request, 'post', '/issues', {title: 'Restock flour'})
    await page.goto(`/p/larder/issues/${proposal.id}`)
    await page.getByLabel('On one sheet').check()
    // An agent's comment elsewhere in the project brings a new copy of the proposal down the live stream.
    await api(request, 'post', `/issues/${other.id}/comments`, {body: 'Ordered two bags'})
    await page.waitForTimeout(500)
    await expect(page.getByLabel('On one sheet')).toBeChecked()
    await page.getByRole('button', {name: 'Approve'}).click()
    await expect.poll(async () => (await api(request, 'get', `/issues/${proposal.id}`)).picks).toEqual({store: ['sheet']})
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

test('the issues start on the open ones, Done and Canceled a tick away', async ({page, request}) => {
    await api(request, 'post', '/issues', {title: 'Shipped pantry export', status: 'done'})
    await api(request, 'post', '/issues', {title: 'Dropped barcode idea', status: 'canceled'})
    await page.goto('/p/larder?view=list')
    await expect(page.getByText('Expiry badges: soon and gone')).toBeVisible()
    await expect(page.getByText('Shipped pantry export')).toBeHidden()
    await expect(page.getByText('Dropped barcode idea')).toBeHidden()
    await expect(page.getByRole('button', {name: 'Clear'})).toBeHidden()

    await page.getByRole('button', {name: /^Column/}).click()
    await page.getByRole('button').filter({hasText: /^Done$/}).click()
    await expect(page.getByText('Shipped pantry export')).toBeVisible()
    await expect(page.getByText('Dropped barcode idea')).toBeHidden()

    await page.keyboard.press('Escape')
    await page.getByRole('button', {name: 'Clear'}).click()
    await expect(page.getByText('Shipped pantry export')).toBeHidden()
})

test("marks what changed since the owner last looked, but not the owner's own changes", async ({page, request}) => {
    const unseen = (title: string) => page.locator('[data-issue]', {hasText: title}).getByTitle('Changed since you last opened it')
    // What was there before the first visit counts as seen; an agent's issue arriving live doesn't.
    await page.goto('/p/larder?view=list')
    await expect(page.getByText('Live', {exact: true})).toBeVisible()
    const issue = await api(request, 'post', '/issues', {title: 'Label the jars'})
    await expect(unseen('Label the jars')).toBeVisible()
    // Opening it is seeing it.
    await page.locator('[data-issue]', {hasText: 'Label the jars'}).click()
    await expect(page).toHaveURL(new RegExp(`/issues/${issue.id}$`))
    await page.goBack()
    await expect(page.locator('[data-issue]', {hasText: 'Label the jars'})).toBeVisible()
    await expect(unseen('Label the jars')).toBeHidden()
    // The owner's own change from the page stays seen; an agent's comment is news again.
    await page.evaluate(id => $fetch(`/api/projects/larder/issues/${id}`, {method: 'PATCH', body: {priority: 'P1'}, headers: {'Orrery-Actor': 'ada_lovelace'}}), issue.id)
    await expect.poll(async () => (await api(request, 'get', `/issues/${issue.id}`)).priority).toBe('P1')
    await page.waitForTimeout(500)
    await expect(unseen('Label the jars')).toBeHidden()
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Done the top shelf'})
    await expect(unseen('Label the jars')).toBeVisible()
    await page.getByRole('button', {name: /Mark \d+ seen/}).click()
    await expect(unseen('Label the jars')).toBeHidden()
})

test('makes a chunk from the roadmap, renames it, gives it a summary and removes it', async ({page, request}) => {
    await page.goto('/p/larder/roadmap')
    await page.getByRole('button', {name: 'New chunk'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New chunk'})
    await dialog.getByLabel('Title').fill('Shelves')
    await dialog.getByLabel('Summary').fill('Where things go')
    await dialog.getByRole('button', {name: /Create chunk/}).click()
    await expect(page).toHaveURL(/\/p\/larder\/roadmap\/\d+$/)
    const id = page.url().split('/').at(-1)!
    expect(await api(request, 'get', `/chunks/${id}`)).toMatchObject({title: 'Shelves', summary: 'Where things go', createdBy: 'ada_lovelace'})

    await page.getByRole('heading', {name: 'Shelves'}).click()
    await page.getByLabel('Title', {exact: true}).fill('Shelving')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', {name: 'Shelving'})).toBeVisible()

    await page.getByRole('button', {name: 'Edit'}).click()
    await page.getByLabel('Summary', {exact: true}).fill('Where **everything** goes')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.locator('.doc strong', {hasText: 'everything'})).toBeVisible()
    expect(await api(request, 'get', `/chunks/${id}`)).toMatchObject({title: 'Shelving', summary: 'Where **everything** goes'})

    await page.getByRole('button', {name: 'Remove this chunk'}).click()
    await page.getByRole('button', {name: 'Remove', exact: true}).click()
    await expect(page).toHaveURL(/\/p\/larder\/roadmap$/)
    expect((await request.get(`/api/projects/larder/chunks/${id}`)).status()).toBe(404)
})

test('puts a picked image in a new issue, and in a comment on it', async ({page, request}) => {
    // A 1×1 PNG.
    const png = {name: 'shelf.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')}
    await page.goto('/p/larder')
    await page.getByRole('button', {name: 'New issue'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New issue'})
    await dialog.getByLabel('Title').fill('Label the top shelf')
    await dialog.locator('input[type="file"]').setInputFiles(png)
    await expect(dialog.getByLabel('Description')).toHaveValue(/^!\[shelf\]\(\/api\/uploads\/[0-9a-f]{24}\)\n$/)
    await dialog.getByRole('button', {name: /Create issue/}).click()
    await expect(page).toHaveURL(/\/p\/larder\/issues\/LAR-\d+/)
    const id = page.url().split('/').at(-1)!
    const image = page.locator('.doc img[alt="shelf"]').first()
    await expect(image).toBeVisible()
    expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)

    await page.locator('form').filter({has: page.getByRole('textbox', {name: 'Comment'})}).locator('input[type="file"]').setInputFiles(png)
    await expect(page.getByRole('textbox', {name: 'Comment'})).toHaveValue(/!\[shelf\]/)
    await page.getByRole('button', {name: 'Comment', exact: true}).click()
    await expect.poll(async () => (await api(request, 'get', `/issues/${id}/comments`)).at(-1)?.body).toMatch(/^!\[shelf\]\(\/api\/uploads\//)
})

test('turns a Before and an After picture into a slider between them', async ({page, request}) => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const [before, after] = await Promise.all(['before', 'after'].map(name => request.post('/api/uploads', {data: {data: png, name}, headers: AGENT}).then(r => r.json())))
    const {id} = await api(request, 'post', '/issues', {title: 'Relabel the jars'})
    await api(request, 'post', `/issues/${id}/comments`, {body: `The jars:\n\n![Before: the jars](${before.url})\n![After: the jars](${after.url})\n\n![A lone picture](${after.url})`})
    await page.goto(`/p/larder/issues/${id}`)
    const slider = page.locator('.doc .compare')
    await expect(slider).toHaveCount(1)
    await expect(slider.getByRole('link', {name: 'Before'})).toHaveAttribute('href', before.url)
    await expect(slider.getByRole('link', {name: 'After'})).toHaveAttribute('href', after.url)
    // A picture on its own stays one.
    await expect(page.locator('.doc a > img[alt="A lone picture"]')).toBeVisible()
    const range = slider.getByRole('slider', {name: /Before: the jars/})
    await range.focus()
    await page.keyboard.press('ArrowRight')
    await expect(slider).toHaveAttribute('style', /--split: 51%/)
})

test("tints a doc an agent changed, and in it the parts that changed since the owner read it", async ({page, request}) => {
    const put = (id: string, body: string) => request.put(`/api/projects/larder/docs/${id}`, {data: {title: id === 'pantry' ? 'Pantry' : 'Shelves', body}, headers: AGENT})
        .then(r => expect(r.ok()).toBeTruthy())
    await put('pantry', 'Keep flour dry.\n\nLabel the jars.')
    await put('shelves', 'Top shelf for tins.')
    await page.goto('/p/larder/docs/pantry')
    await expect(page.getByText('Label the jars.')).toBeVisible()
    await expect(page.locator('.doc .changed')).toHaveCount(0)

    // Reading another doc while an agent changes this one.
    await page.goto('/p/larder/docs/shelves')
    await expect(page.getByText('Top shelf for tins.')).toBeVisible()
    await put('pantry', 'Keep flour dry.\n\nLabel every jar with its date.\n\nRestock on Fridays.')
    const row = page.getByRole('link', {name: /^Pantry/})
    await expect(row).toHaveClass(/unseen-row/)
    await row.click()
    await expect(page.locator('.doc .changed')).toHaveText(['Label every jar with its date.', 'Restock on Fridays.'])
    await expect(page.getByText('2 parts changed since you last read it, tinted below')).toBeVisible()
})
