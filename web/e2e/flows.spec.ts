import type {APIRequestContext, Page} from '@playwright/test'
import {expect, test} from '@playwright/test'

// The main flows, in order, on one fresh Orrery: name the owner, make a project, add issues and move
// them, sub-issues, ⌘K, a proposal the owner approves, a change showing up live in another tab, and the
// issues starting on the open ones, what changed since the owner looked, and ticked issues changed
// together; then a chunk made, edited and removed from its page, an image in a new issue and a comment,
// and the owner editing and deleting their own comment; then a changed doc and what changed in it; then a release, and a project drawing on it;
// then the session side, with a fake channel and launcher on the API where Claude would be: starting sessions turned on,
// a session's card and a message to it alone, Focus on this starting one, a preset, a schedule, the bell, and the
// pages that span projects.
test.describe.configure({mode: 'serial'})

const AGENT = {'Orrery-Actor': 'claude'}
const api = (request: APIRequestContext, method: 'get' | 'post' | 'patch', path: string, data?: object, headers = AGENT) =>
    request[method](`/api/projects/larder${path}`, {data, headers}).then(async r => {
        expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy()
        return r.json()
    })

/** A stream held open the way a channel or launcher holds it, keeping what arrives; `stop` lets it go. */
function hold(baseURL: string, path: string) {
    const controller = new AbortController()
    const said = {text: ''}
    fetch(`${baseURL}${path}`, {signal: controller.signal}).then(async response => {
        const reader = response.body!.getReader()
        for (;;) {
            const {done, value} = await reader.read()
            if (done) return
            said.text += new TextDecoder().decode(value)
        }
    }).catch(() => {})
    return {said, stop: () => controller.abort()}
}

async function newIssue(page: Page, title: string, where: string) {
    await page.goto('/p/larder')
    await page.getByRole('button', {name: 'New issue'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New issue'})
    await dialog.getByLabel('Title').fill(title)
    await dialog.getByRole('button', {name: 'Where'}).click()
    await dialog.getByRole('option', {name: new RegExp(`^${where}\\b`, 'i')}).click()
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
    // A new Orrery opens on Getting started: the owner's step ticked, a project the one to do.
    await expect(page.getByRole('heading', {name: 'Getting started'})).toBeVisible()
    await expect(page.getByRole('progressbar', {name: 'Steps done'})).toHaveAttribute('aria-valuenow', '1')
    await expect(page.getByRole('button', {name: 'Try it with a demo project'})).toBeVisible()
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
    // Approving puts it on the roadmap: committed, in Todo, keeping who approved it.
    await expect.poll(async () => (await api(request, 'get', `/issues/${proposal.id}`)).column).toBe('todo')
    const approved = await api(request, 'get', `/issues/${proposal.id}`)
    expect(approved.proposal).toBeFalsy()
    expect(approved.decided_by).toBe('ada_lovelace')
    expect((await api(request, 'get', `/issues/${proposal.id}/comments`)).at(-1)).toMatchObject({body: 'Approved this proposal.', created_by: 'ada_lovelace'})
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
    // A done or canceled issue is never news, whatever happens to it.
    await api(request, 'patch', `/issues/${issue.id}`, {status: 'done'})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'All labelled'})
    await page.waitForTimeout(500)
    await expect(page.getByRole('button', {name: /Mark \d+ seen/})).toBeHidden()
    await expect(page.getByTitle(/changed since you last looked/)).toBeHidden()
})

test('ticks issues and changes them together', async ({page, request}) => {
    const a = await api(request, 'post', '/issues', {title: 'Sort the spices'})
    const b = await api(request, 'post', '/issues', {title: 'Date the flour'})
    await page.goto('/p/larder?view=list')
    await page.getByRole('checkbox', {name: `Select ${a.id}`}).click()
    // A click that just misses the box, at the row's edge beside it, ticks too instead of opening the issue.
    const row = (await page.locator(`[data-issue="${b.id}"]`).boundingBox())!
    const box = (await page.getByRole('checkbox', {name: `Select ${b.id}`}).locator('span').boundingBox())!
    await page.mouse.click(box.x - 4, row.y + 2)
    await expect(page.getByRole('checkbox', {name: `Select ${b.id}`})).toHaveAttribute('aria-checked', 'true')
    await expect(page).toHaveURL(/\/p\/larder\?view=list$/)
    const bar = page.getByRole('toolbar', {name: 'Change the ticked issues'})
    await expect(bar.getByText('2 selected')).toBeVisible()
    await bar.getByRole('button', {name: 'Priority'}).click()
    await page.getByRole('option', {name: 'High'}).click()
    await expect(bar.getByRole('status')).toHaveText('Changed 2 issues')
    for (const {id} of [a, b]) expect((await api(request, 'get', `/issues/${id}`)).priority).toBe('P1')
    await page.keyboard.press('Escape')
    await expect(bar.getByText('2 selected')).toBeHidden()
})

test('ticks a run by dragging over the ticks, and a whole group from its header', async ({page, request}) => {
    const made = [await api(request, 'post', '/issues', {title: 'Wipe the shelves'}), await api(request, 'post', '/issues', {title: 'Toss the stale crackers'}), await api(request, 'post', '/issues', {title: 'Refill the salt'})]
    await page.goto('/p/larder?view=list')
    const tick = (id: string) => page.getByRole('checkbox', {name: `Select ${id}`})
    const centres = await Promise.all(made.map(async ({id}) => {
        const box = (await tick(id).boundingBox())!
        return {x: box.x + box.width / 2, y: box.y + box.height / 2}
    }))
    const [top, bottom] = [centres.reduce((a, b) => a.y < b.y ? a : b), centres.reduce((a, b) => a.y > b.y ? a : b)]
    // Pressing one tick and dragging over the others ticks them all, and doesn't open the one it's let go on.
    await page.mouse.move(top.x, top.y)
    await page.mouse.down()
    await page.mouse.move(bottom.x, bottom.y, {steps: 8})
    await page.mouse.up()
    for (const {id} of made) await expect(tick(id)).toHaveAttribute('aria-checked', 'true')
    await expect(page).toHaveURL(/\/p\/larder\?view=list$/)
    const bar = page.getByRole('toolbar', {name: 'Change the ticked issues'})
    await expect(bar.getByText(/Drag over the ticks/)).toBeVisible()
    // Dragging back from a ticked one unticks them.
    await page.mouse.move(bottom.x, bottom.y)
    await page.mouse.down()
    await page.mouse.move(top.x, top.y, {steps: 8})
    await page.mouse.up()
    for (const {id} of made) await expect(tick(id)).toHaveAttribute('aria-checked', 'false')
    // A group's tick ticks every row in it, and a second click unticks them.
    const group = page.getByRole('checkbox', {name: /^Select all in /}).first()
    await group.click()
    await expect(group).toHaveAttribute('aria-checked', 'true')
    await expect(bar.getByText(/\d+ selected/)).toBeVisible()
    await group.click()
    await expect(bar).toBeHidden()
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
    expect(await api(request, 'get', `/chunks/${id}`)).toMatchObject({title: 'Shelves', summary: 'Where things go', created_by: 'ada_lovelace'})

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

test("edits and deletes the owner's own comment, but not an agent's", async ({page, request}) => {
    const {id} = await api(request, 'post', '/issues', {title: 'Oil the hinges'})
    await api(request, 'post', `/issues/${id}/comments`, {body: 'Bought the oil'})
    await page.goto(`/p/larder/issues/${id}`)
    await page.getByRole('textbox', {name: 'Comment'}).fill('Use the thin oil')
    await page.getByRole('button', {name: 'Comment', exact: true}).click()
    const mine = page.locator('li').filter({hasText: 'Use the thin oil'})
    await expect(mine).toBeVisible()
    await expect(page.locator('li').filter({hasText: 'Bought the oil'}).getByRole('button', {name: 'Edit'})).toHaveCount(0)

    await mine.hover()
    await mine.getByRole('button', {name: 'Edit'}).click()
    const field = page.getByRole('textbox', {name: 'Edit comment'})
    await expect(field).toHaveValue('Use the thin oil')
    await field.fill('Use the thick oil')
    await field.press('Meta+Enter')
    await expect(page.locator('li').filter({hasText: 'Use the thick oil'})).toContainText('edited')
    expect((await api(request, 'get', `/issues/${id}/comments`)).at(-1)).toMatchObject({body: 'Use the thick oil'})

    const edited = page.locator('li').filter({hasText: 'Use the thick oil'})
    await edited.hover()
    await edited.getByRole('button', {name: 'Delete'}).click()
    await edited.getByRole('button', {name: 'Delete', exact: true}).click()
    await expect(edited).toHaveCount(0)
    expect((await api(request, 'get', `/issues/${id}/comments`)).map((c: {body: string}) => c.body)).toEqual(['Bought the oil'])
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

test('makes a release, sets an issue for it from its page, and drafts its changelog', async ({page, request}) => {
    await api(request, 'patch', '', {repo: 'https://github.com/you/larder', release_mode: 'own'})
    const issue = await api(request, 'post', '/issues', {title: 'Label the jars', status: 'done'})
    await page.goto('/p/larder/releases')
    await page.getByRole('button', {name: 'New release'}).click()
    await page.getByLabel('Version').fill('1.0.0')
    await expect(page.getByLabel('Branch its work gathers on')).toHaveValue('v1.0.0')
    await page.getByRole('button', {name: 'Make it'}).click()
    await expect(page).toHaveURL(/\/p\/larder\/releases\/1\.0\.0$/)
    await expect(page.getByRole('link', {name: 'PRs into it'})).toHaveAttribute('href', 'https://github.com/you/larder/pulls?q=is%3Apr%20base%3Av1.0.0')

    await page.goto(`/p/larder/issues/${issue.id}`)
    await page.getByRole('button', {name: 'Release'}).click()
    await page.getByRole('option', {name: '1.0.0'}).click()
    await expect.poll(async () => (await api(request, 'get', `/issues/${issue.id}`)).release).toBe('1.0.0')

    await page.getByRole('link', {name: 'Open the release'}).click()
    // Exact: the changelog draft, folded away but in the page once the release counts the issue, has its title too.
    await expect(page.getByText('Label the jars', {exact: true})).toBeVisible()
    await page.getByText('Changelog draft').click()
    await expect(page.locator('pre', {hasText: `## 1.0.0 (unreleased)`})).toContainText(`- Label the jars (${issue.id})`)
    await page.getByRole('button', {name: 'Mark shipped today'}).click()
    await expect(page.getByText(/^Shipped \d{4}-\d{2}-\d{2}$/)).toBeVisible()
})

test("a project drawing on another's releases shows in its release, in a section of its own", async ({page, request}) => {
    const made = await request.post('/api/projects', {data: {name: 'Pantry', id: 'pantry', release_mode: 'shared', releases_from: 'larder'}, headers: AGENT})
    expect(made.ok(), await made.text()).toBeTruthy()
    const added = await request.post('/api/projects/pantry/issues', {data: {title: 'Stock the shelves', status: 'done', release: '1.0.0'}, headers: AGENT})
    expect(added.ok(), await added.text()).toBeTruthy()
    await page.goto('/p/larder/releases/1.0.0')
    await expect(page.getByRole('main').getByRole('link', {name: 'Pantry', exact: true})).toBeVisible()
    await expect(page.locator('[data-issue]', {hasText: 'Stock the shelves'})).toBeVisible()
    await expect(page.locator('[data-issue]', {hasText: 'Label the jars'})).toBeVisible()
})

const OWNER = {'Orrery-Actor': 'ada_lovelace'}

test('lets Orrery start sessions once, for every project, on the Sessions page', async ({page, request}) => {
    await page.goto('/sessions#starts')
    const starts = page.locator('#starts')
    await starts.getByRole('checkbox', {name: 'Let Orrery start sessions'}).check()
    await starts.getByLabel('Sessions at once').fill('2')
    await starts.getByLabel('Sessions at once').blur()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).starts).toEqual({limit: 2})
    // A project shows it as its own.
    expect((await api(request, 'get', '')).starts).toEqual({limit: 2})
})

test("shows a listening session on the Sessions page, and sends it a message only it hears", async ({page, request, baseURL}) => {
    const hello = await request.post('/api/sessions', {data: {id: 'e2e-1', project: 'larder', event: 'UserPromptSubmit', name: 'larder shelves', cwd: '/code/larder'}})
    expect(hello.ok(), await hello.text()).toBeTruthy()
    const channel = hold(baseURL!, '/api/projects/larder/signals/stream?session=e2e-1&name=larder%20shelves&format=text')
    try {
        await page.goto('/sessions')
        const card = page.locator('#session-e2e-1')
        await expect(card).toContainText('larder shelves')
        await expect(card.getByText('listening')).toBeVisible()
        await card.getByLabel('Message larder shelves').fill('Use the oak hinges, not pine.')
        await card.getByRole('button', {name: 'Send'}).click()
        await expect.poll(() => channel.said.text).toContain('ada_lovelace (to you): Use the oak hinges, not pine.')
        await expect(card.getByText(/message: Use the oak hinges/)).toBeVisible()

        // Kept to one project, and a project's old Sessions tab comes here.
        await page.getByRole('combobox', {name: 'Project', exact: true}).selectOption('pantry')
        await expect(page).toHaveURL(/\/sessions\?project=pantry/)
        await expect(page.locator('#session-e2e-1')).toBeHidden()
        await page.goto('/p/larder/sessions')
        await expect(page).toHaveURL(/\/sessions\?project=larder/)
        await expect(page.locator('#session-e2e-1')).toBeVisible()
    } finally {
        channel.stop()
    }
})

test('lists a session that hears two projects once, under its own', async ({page, request, baseURL}) => {
    const hello = await request.post('/api/sessions', {data: {id: 'e2e-2', project: 'larder', event: 'SessionStart', name: 'kitchen', cwd: '/code/kitchen'}})
    expect(hello.ok(), await hello.text()).toBeTruthy()
    const channels = ['larder', 'pantry'].map(p => hold(baseURL!, `/api/projects/${p}/signals/stream?session=e2e-2&name=kitchen&format=text`))
    try {
        await page.goto('/sessions')
        await expect(page.locator('#session-e2e-2')).toHaveCount(1)
        await expect(page.locator('#sessions-larder #session-e2e-2')).toContainText('also on Pantry')
        // The sidebar lists it once too.
        await expect(page.getByRole('link', {name: /kitchen/})).toHaveCount(1)
        // Kept to the other project, it's found there.
        await page.goto('/sessions?project=pantry')
        await expect(page.locator('#sessions-pantry #session-e2e-2')).toContainText('also on Larder')
    } finally {
        for (const channel of channels) channel.stop()
    }
})

test('with nobody listening and a launcher there, Focus on this starts a session', async ({page, request, baseURL}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Oil the hinges', status: 'todo'})
    // The session from before has gone: nobody listens on larder now.
    await expect.poll(async () => (await api(request, 'get', '/sessions')).some((s: {listening: boolean}) => s.listening)).toBe(false)
    const launcher = hold(baseURL!, '/api/projects/larder/launches/stream')
    try {
        await expect.poll(async () => (await api(request, 'get', '/launches')).launchers).toBe(1)
        await page.goto(`/p/larder/issues/${issue.id}`)
        await page.getByRole('button', {name: 'Focus on this (starts a session)'}).click()
        await expect.poll(() => launcher.said.text).toContain('event: launch')
    } finally {
        launcher.stop()
    }
})

test('keeps a preset on the Sessions page and offers it in Start session', async ({page}) => {
    await page.goto('/sessions#presets')
    await page.getByLabel('New preset name').fill('Review')
    await page.getByLabel('New preset text').fill("You're reviewing: read the diff and comment, don't change code.")
    await page.getByRole('button', {name: 'Add preset'}).click()
    await expect(page.getByLabel('Preset name', {exact: true})).toHaveValue('Review')
    await page.goto('/sessions')
    await page.getByRole('button', {name: 'Start session'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'Start session'})
    await expect(dialog).toBeVisible()
    // No launcher is running now, so larder can't be picked; the reason says so.
    await expect(dialog.getByRole('group', {name: 'Projects'})).toContainText('No launcher running')
    await page.keyboard.press('Escape')
})

test('makes a schedule, keeps to its project, pauses and removes it', async ({page, request}) => {
    await page.goto('/schedules?project=larder')
    await page.getByRole('button', {name: 'New schedule'}).click()
    const dialog = page.getByRole('dialog', {name: 'New schedule'})
    await dialog.getByLabel('Title').fill('Groom the backlog')
    await dialog.getByRole('button', {name: /Create schedule/}).click()
    await expect(dialog).toBeHidden()
    const row = page.getByRole('button', {name: /Groom the backlog/}).first()
    await expect(row).toBeVisible()
    const [made] = await api(request, 'get', '/schedules')
    expect(made).toMatchObject({title: 'Groom the backlog', enabled: true})

    await page.getByRole('button', {name: 'Pause Groom the backlog', exact: true}).click()
    await expect.poll(async () => (await api(request, 'get', '/schedules'))[0].enabled).toBe(false)
    // Kept to another project, it isn't there; the old tab comes here kept to larder.
    await page.getByRole('combobox', {name: 'Project', exact: true}).selectOption('pantry')
    await expect(page.getByText('Groom the backlog')).toBeHidden()
    await page.goto('/p/larder/schedules')
    await expect(page).toHaveURL(/\/schedules\?project=larder/)

    await page.getByText('Groom the backlog').click({button: 'right'})
    await page.getByRole('menu').getByRole('button', {name: /Remove/}).click()
    await page.getByRole('menu').getByRole('button', {name: /Remove/}).last().click()
    await expect.poll(async () => (await api(request, 'get', '/schedules')).length).toBe(0)
})

test("an agent's question waits in the bell until the owner answers it", async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Pick a hinge', status: 'todo'})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Oak or pine for the hinges?', asks: 'decision'})
    await page.goto('/now')
    const bell = page.getByRole('link', {name: /waiting on you/})
    await expect(bell).toBeVisible()
    await bell.click()
    await expect(page).toHaveURL(/\/notifications/)
    await expect(page.getByRole('button', {name: `${issue.id}: Pick a hinge`}).or(page.getByRole('link', {name: `${issue.id}: Pick a hinge`})).first()).toBeVisible()

    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Oak.'}, OWNER)
    await page.goto('/now')
    await expect(page.getByRole('link', {name: /waiting on you/})).toBeHidden()
})

test('Now, My issues and Connect show what they should', async ({page, request}) => {
    const urgent = await api(request, 'post', '/issues', {title: 'The shelf fell down', status: 'todo', priority: 'P0'})
    await page.goto('/now')
    await expect(page.getByText('The shelf fell down')).toBeVisible()
    await page.goto('/mine')
    await expect(page.getByText('The shelf fell down')).toBeVisible()
    // Getting started is a card on Now until it's done; someone only planning is set without the steps for Claude.
    const card = page.getByRole('region', {name: 'Getting started'})
    await page.goto('/now')
    await expect(card.getByText('Connect a folder', {exact: true})).toBeVisible()
    await card.getByRole('button', {name: "Just planning? You're set"}).click()
    await expect(card).toBeHidden()
    await page.goto('/getting-started')
    await page.getByRole('button', {name: 'Working with Claude after all?'}).click()
    await page.goto('/now')
    await expect(card).toBeVisible()
    await page.goto('/connect?project=larder')
    await expect(page.getByText(/Set this repo up for Orrery: read .*\/connect\/larder\.md/)).toBeVisible()
    await api(request, 'patch', `/issues/${urgent.id}`, {status: 'done'})
})
