import {expect, test} from '@playwright/test'
import {makeProject, newIssue, projectApi} from './support'

// Issues on a project of their own: made from the page and moved on the board, the board leaving out the columns
// the filter does, sub-issues, ⌘K, a change showing live in another tab, the open ones first, and what changed
// since the owner last looked.
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
