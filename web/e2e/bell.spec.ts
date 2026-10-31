import {expect, test} from '@playwright/test'
import {OWNER, makeProject, projectApi} from './support'

// An agent's question waits in the bell until the owner answers it.

const api = projectApi('porch')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Porch', key: 'POR'})
})

test("an agent's question waits in the bell until the owner answers it", async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Pick a hinge', status: 'todo'})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Oak or pine for the hinges?', asks: 'decision'})
    await page.goto('/mine')
    const bell = page.getByRole('link', {name: /waiting on you/})
    await expect(bell).toBeVisible()
    await bell.click()
    await expect(page).toHaveURL(/\/notifications/)
    await expect(page.getByRole('button', {name: `${issue.id}: Pick a hinge`}).or(page.getByRole('link', {name: `${issue.id}: Pick a hinge`})).first()).toBeVisible()

    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Oak.'}, OWNER)
    await page.goto('/mine')
    await expect(page.getByRole('link', {name: /waiting on you/})).toBeHidden()
})

test("clearing an agent's proposal takes it out of the bell and leaves it pending", async ({page, request}) => {
    const proposal = await api(request, 'post', '/issues', {title: 'Paint the porch', notes: 'Grey, to match the steps.', proposal: 'pending'})
    await page.goto('/notifications')
    const row = page.getByRole('listitem').filter({has: page.getByRole('button', {name: `${proposal.id}: Paint the porch`})})
    await expect(row).toBeVisible()
    await row.hover()
    await row.getByRole('button', {name: 'Clear this notice'}).click()
    await expect(row).toBeHidden()
    expect((await api(request, 'get', `/issues/${proposal.id}`)).proposal).toBe('pending')
})

test('Notifications is a list and a reading pane: a line says what happened and opens beside it, read only then (ORR-785, ORR-803)', async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Sand the rail', status: 'todo'})
    const other = await api(request, 'post', '/issues', {title: 'Oil the rail', status: 'todo'})
    for (const body of ['First coat is on.', 'Second coat is on.']) await api(request, 'post', `/issues/${issue.id}/comments`, {body})
    await api(request, 'post', `/issues/${other.id}/comments`, {body: 'Oiled, see [the tin](https://example.com/tin).'})
    await api(request, 'patch', `/issues/${issue.id}`, {status: 'in-progress'})

    await page.goto('/notifications')
    const today = page.locator('section').filter({has: page.getByRole('heading', {level: 2, name: /^Today/})})
    await expect(today.getByRole('heading', {level: 2})).toContainText('unread')
    const line = (id: string, title: string) => today.getByRole('listitem').filter({has: page.getByRole('button', {name: `${id}: ${title}`})})
    const sand = line(issue.id, 'Sand the rail')
    const oil = line(other.id, 'Oil the rail')
    const toggle = sand.getByRole('button', {name: `${issue.id}: Sand the rail`})
    // One line for the two comments, saying what happened; with no change, its comment's first line, without Markdown.
    await expect(sand).toContainText('Todo')
    await expect(sand).toContainText('In progress')
    await expect(oil).toContainText('Oiled, see the tin.')
    const state = (row: typeof sand) => row.locator('[data-state]').getAttribute('data-state')
    expect(await state(sand)).toBe('unread')
    await page.reload()
    await expect(toggle).toBeVisible()
    expect(await state(sand)).toBe('unread')

    // Choosing it shows both comments and the change beside the list, with a link to the issue, and it's read, on the server too.
    const pane = page.getByRole('article')
    await expect(pane).toBeHidden()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-current', 'true')
    await expect(toggle).toBeVisible()
    await expect(pane.getByText('First coat is on.')).toBeVisible()
    await expect(pane.getByText('Second coat is on.')).toBeVisible()
    await expect(pane.getByRole('listitem').filter({hasText: 'Todo'})).toContainText('In progress')
    await expect(pane.getByRole('link', {name: `Open ${issue.id}`})).toBeVisible()
    await expect.poll(() => state(sand)).toBe('read')
    expect(await state(oil)).toBe('unread')
    await expect.poll(async () => (await (await request.get('/api/notices?list=inbox')).json() as {issue: string, read?: boolean}[]).filter(n => n.issue === issue.id).every(n => n.read)).toBe(true)
    await page.reload()
    await expect(pane.getByText('First coat is on.')).toBeVisible()
    expect(await state(sand)).toBe('read')

    // Clear read takes that one and leaves the unread.
    await page.getByRole('button', {name: 'Clear read', exact: true}).click()
    await expect(sand).toBeHidden()
    await expect(pane).toBeHidden()
    await expect(oil).toBeVisible()
})

test('Notifications leads with what waits on you, each line showing its question (ORR-803)', async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Stain the door', status: 'todo'})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: '**Where it stands:** primed.\n\n**Walnut or oak?**', asks: 'decision'})
    await page.goto('/notifications')
    const waiting = page.getByRole('region', {name: 'Waiting on you'})
    const line = waiting.getByRole('listitem').filter({has: page.getByRole('button', {name: `${issue.id}: Stain the door`})})
    await expect(line).toContainText('Walnut or oak?')
    expect(await line.locator('[data-state]').getAttribute('data-state')).toBe('waiting')
})

test('On a narrow window a chosen line takes the list\'s place, and Back returns to it (ORR-803)', async ({page, request}) => {
    await page.setViewportSize({width: 390, height: 844})
    const issue = await api(request, 'post', '/issues', {title: 'Hang the gate', status: 'todo'})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Hung.'})
    await page.goto('/notifications')
    const toggle = page.getByRole('button', {name: `${issue.id}: Hang the gate`})
    await toggle.click()
    await expect(page.getByRole('article').getByText('Hung.')).toBeVisible()
    await expect(toggle).toBeHidden()
    await page.goBack()
    await expect(toggle).toBeVisible()
    await expect(page.getByRole('article')).toBeHidden()
})
