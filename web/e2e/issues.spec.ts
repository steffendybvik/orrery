import {expect, test} from '@playwright/test'
import {AGENT, makeProject, newIssue, projectApi} from './support'

// Issues on a project of their own: made from the page and moved on the board, the board leaving out the columns
// the filter does, sub-issues, ⌘K, a change showing live in another tab, the open ones first, what changed
// since the owner last looked, and double-clicking a description to edit it.
test.describe.configure({mode: 'serial'})

const api = projectApi('scullery')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Scullery', key: 'SCU'})
})

test('adds issues and moves one on the board', async ({page, request}) => {
    await page.goto('/p/scullery')
    await newIssue(page, 'scullery', 'Shelves you can reorder', 'todo')
    await newIssue(page, 'scullery', 'Expiry badges', 'backlog')
    // A new issue opens its page; back to the project, as a board.
    await page.goto('/p/scullery')
    await page.getByRole('radio', {name: /Board/}).or(page.getByRole('button', {name: /Board/})).first().click()
    const card = page.locator('[data-issue="SCU-1"]')
    await expect(card.getByRole('img', {name: 'Todo'})).toBeVisible()
    // The chunk's name is plain text: the whole card opens the issue.
    await expect(card.getByRole('link')).toHaveCount(0)
    await card.click({button: 'right'})
    await page.getByRole('menu').getByRole('button', {name: 'Move to In progress'}).click()
    await expect(card.getByRole('img', {name: 'In progress'})).toBeVisible()
    expect(await api(request, 'get', '/issues/SCU-1')).toMatchObject({status: 'in-progress', kind: 'started'})
})

test('the board leaves out the columns of statuses the filter leaves out', async ({page}) => {
    await page.goto('/p/scullery?view=board')
    const column = (name: string) => page.getByRole('heading', {level: 2, name, exact: true})
    await expect(column('Backlog')).toBeVisible()
    // Closed statuses aren't ticked to begin with, so their columns aren't there either.
    await expect(column('Done')).toBeHidden()
    await page.getByRole('button', {name: /^Column/}).click()
    const menu = page.locator('.glass')
    await menu.getByRole('option', {name: 'Backlog'}).click()
    await expect(column('Backlog')).toBeHidden()
    await expect(page.getByText('Expiry badges')).toBeHidden()
    await expect(column('In progress')).toBeVisible()
    await menu.getByRole('button', {name: 'Clear'}).click()
    await expect(column('Backlog')).toBeVisible()
    await expect(column('Done')).toBeVisible()
})

test('shows sub-issues and their progress on the parent', async ({page, request}) => {
    const one = await api(request, 'post', '/issues', {title: 'Drag to reorder', parent: 'SCU-1'})
    await api(request, 'post', '/issues', {title: 'Reorder with the keyboard', parent: 'SCU-1'})
    await api(request, 'patch', `/issues/${one.id}`, {status: 'done'})
    await page.goto('/p/scullery/issues/SCU-1')
    const subs = page.getByRole('heading', {name: /Sub-issues/})
    await expect(subs).toContainText('1/2')
    await expect(page.getByText('Reorder with the keyboard')).toBeVisible()
})

test('⌘K finds an issue and opens it', async ({page}) => {
    await page.goto('/p/scullery')
    await expect(page.getByText('Expiry badges')).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog', {name: 'Commands'})
    await palette.getByLabel('Type a command or search').fill('expiry')
    await expect(palette.getByRole('option', {name: /Expiry badges/})).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/p\/scullery\/issues\/SCU-2/)
})

test('a change shows up live in another tab', async ({page, context, request}) => {
    await page.goto('/p/scullery')
    const other = await context.newPage()
    await other.goto('/p/scullery')
    await expect(other.getByText('Expiry badges')).toBeVisible()
    await api(request, 'patch', '/issues/SCU-2', {title: 'Expiry badges: soon and gone'})
    await expect(page.getByText('Expiry badges: soon and gone')).toBeVisible()
    await expect(other.getByText('Expiry badges: soon and gone')).toBeVisible()
})

test('the issues start on the open ones, Done and Canceled a tick away', async ({page, request}) => {
    await api(request, 'post', '/issues', {title: 'Shipped pantry export', status: 'done'})
    await api(request, 'post', '/issues', {title: 'Dropped barcode idea', status: 'canceled'})
    await page.goto('/p/scullery?view=list')
    await expect(page.getByText('Expiry badges: soon and gone')).toBeVisible()
    await expect(page.getByText('Shipped pantry export')).toBeHidden()
    await expect(page.getByText('Dropped barcode idea')).toBeHidden()
    await expect(page.getByRole('button', {name: 'Clear'})).toBeHidden()

    await page.getByRole('button', {name: /^Column/}).click()
    await page.getByRole('option').filter({hasText: /^Done$/}).click()
    await expect(page.getByText('Shipped pantry export')).toBeVisible()
    await expect(page.getByText('Dropped barcode idea')).toBeHidden()

    await page.keyboard.press('Escape')
    await page.getByRole('button', {name: 'Clear'}).click()
    await expect(page.getByText('Shipped pantry export')).toBeHidden()
})

test("marks what changed since the owner last looked, but not the owner's own changes", async ({page, request}) => {
    const unseen = (title: string) => page.locator('[data-issue]', {hasText: title}).getByTitle('Changed since you last opened it')
    // What was there before the first visit counts as seen; an agent's issue arriving live doesn't.
    await page.goto('/p/scullery?view=list')
    await expect(page.getByText('Connected', {exact: true})).toBeVisible()
    const issue = await api(request, 'post', '/issues', {title: 'Label the jars'})
    await expect(unseen('Label the jars')).toBeVisible()
    // Opening it is seeing it.
    await page.locator('[data-issue]', {hasText: 'Label the jars'}).click()
    await expect(page).toHaveURL(new RegExp(`/issues/${issue.id}$`))
    await page.goBack()
    await expect(page.locator('[data-issue]', {hasText: 'Label the jars'})).toBeVisible()
    await expect(unseen('Label the jars')).toBeHidden()
    // The owner's own change from the page stays seen; an agent's comment is news again.
    await page.evaluate(id => $fetch(`/api/projects/scullery/issues/${id}`, {method: 'PATCH', body: {priority: 'P1'}, headers: {'Orrery-Actor': 'ada_lovelace'}}), issue.id)
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

test('double-clicking a description opens its editor, unless it was a link, a picture or a drag', async ({page, request}) => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const upload = await (await request.post('/api/uploads', {data: {data: png, name: 'shelf'}, headers: AGENT})).json()
    const notes = `Top shelf first, then the rest\n\n![The shelf](${upload.url})\n\n[The plan](/p/scullery)`
    const issue = await api(request, 'post', '/issues', {title: 'Sort the shelves', notes})
    await page.goto(`/p/scullery/issues/${issue.id}`)
    const text = page.locator('.doc p', {hasText: 'Top shelf first'})
    const editor = page.getByRole('textbox', {name: 'Description'})
    await expect(text).toBeVisible()

    // A drag selects, and the editor stays shut; so does a double-click dragged across words.
    const box = (await text.boundingBox())!
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + 2, y)
    await page.mouse.down()
    await page.mouse.move(box.x + 120, y, {steps: 5})
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toContain('Top')
    await page.mouse.click(box.x + 2, y)
    await page.mouse.down()
    await page.mouse.up()
    await page.mouse.down({clickCount: 2})
    await page.mouse.move(box.x + 120, y, {steps: 5})
    await page.mouse.up({clickCount: 2})
    await expect(editor).toBeHidden()

    await text.dblclick()
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue(notes)
    // Esc leaves it as it was.
    await page.keyboard.press('Escape')
    await expect(text).toBeVisible()
    expect((await api(request, 'get', `/issues/${issue.id}`)).notes).toBe(notes)

    // A picture and a link keep their own click.
    // The picture opens larger on the first click, and the second closes it again.
    await page.locator('.doc img[alt="The shelf"]').dblclick()
    await expect(page.getByRole('dialog', {name: 'The shelf'})).toBeHidden()
    await expect(editor).toBeHidden()
    await page.locator('.doc a', {hasText: 'The plan'}).dblclick()
    await expect(page).toHaveURL(/\/p\/scullery(\?.*)?$/)
    await page.goto(`/p/scullery/issues/${issue.id}`)
    await expect(text).toBeVisible()
    await expect(editor).toBeHidden()

    // The Edit button stays.
    await text.hover()
    await page.getByRole('button', {name: 'Edit'}).first().click()
    await expect(editor).toBeFocused()
})
