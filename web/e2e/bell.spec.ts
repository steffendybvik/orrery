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

test('Notifications is a timeline by day: an issue is one line, which opens in place and is read only then (ORR-785)', async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Sand the rail', status: 'todo'})
    const other = await api(request, 'post', '/issues', {title: 'Oil the rail', status: 'todo'})
    for (const body of ['First coat is on.', 'Second coat is on.']) await api(request, 'post', `/issues/${issue.id}/comments`, {body})
    await api(request, 'post', `/issues/${other.id}/comments`, {body: 'Oiled.'})

    await page.goto('/notifications')
    const today = page.locator('div').filter({has: page.getByRole('heading', {level: 2, name: /^Today/})}).last()
    await expect(today.getByRole('heading', {level: 2})).toContainText('unread')
    const line = (id: string, title: string) => today.getByRole('listitem').filter({has: page.getByRole('button', {name: `${id}: ${title}`})})
    const sand = line(issue.id, 'Sand the rail')
    const toggle = sand.getByRole('button', {name: `${issue.id}: Sand the rail`})
    // Two comments, one line, with the newest's first line; opening the page marks nothing read.
    await expect(sand).toContainText('2 comments')
    await expect(sand).toContainText('Second coat is on.')
    const state = (row: typeof sand) => row.locator('[data-state]').getAttribute('data-state')
    expect(await state(sand)).toBe('unread')
    await page.reload()
    await expect(toggle).toBeVisible()
    expect(await state(sand)).toBe('unread')

    // Opening it shows both in full, with a link to the issue, and it's read, on the server too.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(sand.getByText('First coat is on.')).toBeVisible()
    await expect(sand.getByRole('link', {name: `Open ${issue.id}`})).toBeVisible()
    await expect.poll(() => state(sand)).toBe('read')
    expect(await state(line(other.id, 'Oil the rail'))).toBe('unread')
    await expect.poll(async () => (await (await request.get('/api/notices?list=inbox')).json() as {issue: string, read?: boolean}[]).filter(n => n.issue === issue.id).every(n => n.read)).toBe(true)
    await page.reload()
    await expect(toggle).toBeVisible()
    expect(await state(sand)).toBe('read')

    // Clear read takes that one and leaves the unread.
    await page.getByRole('button', {name: 'Clear read', exact: true}).click()
    await expect(sand).toBeHidden()
    await expect(line(other.id, 'Oil the rail')).toBeVisible()
})
