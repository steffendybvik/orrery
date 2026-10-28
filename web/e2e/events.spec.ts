import {expect, test} from '@playwright/test'
import {OWNER, makeProject, projectApi} from './support'

// The Events page kept to a kind (ORR-401): a family picked shows every kind in it, one kind only itself, and the
// choice is in the URL, with the project's, so it's there again after a reload.
// And its lines link the issue they name, and their project, from the line itself (ORR-403).
const api = projectApi('ledger')
let advanced = false

test.beforeAll(async ({request}) => {
    advanced = !!(await (await request.get('/api/settings')).json()).advanced
    const on = await request.patch('/api/settings', {data: {advanced: true}, headers: OWNER})
    expect(on.ok(), await on.text()).toBeTruthy()
    if (!(await request.get('/api/projects/ledger')).ok()) await makeProject(request, {name: 'Ledger', key: 'LDG'})
    const issue = await api(request, 'post', '/issues', {title: 'Balance the books'})
    await api(request, 'patch', `/issues/${issue.id}`, {status: 'in-progress'})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Two columns off.'})
})

test.afterAll(async ({request}) => {
    await request.patch('/api/settings', {data: {advanced}, headers: OWNER})
})

test('keeps to a family of kinds or to one kind', async ({page}) => {
    await page.goto('/events?project=ledger')
    const lines = page.locator('[aria-expanded]')
    await expect(lines.filter({hasText: 'issue.created'})).not.toHaveCount(0)
    await expect(lines.filter({hasText: 'comment.added'})).not.toHaveCount(0)

    // A family: every issue.* and nothing else.
    await page.getByRole('button', {name: 'Kind'}).click()
    await page.getByRole('option', {name: 'issue.* (all)'}).click()
    await expect(page).toHaveURL(/kind=issue(&|$)/)
    await expect(lines.filter({hasText: 'issue.status'})).not.toHaveCount(0)
    await expect(lines.filter({hasText: 'issue.created'})).not.toHaveCount(0)
    await expect(lines.filter({hasText: 'comment.added'})).toHaveCount(0)

    // One kind, still in the project, after a reload too.
    await page.getByRole('button', {name: 'Kind'}).click()
    await page.getByRole('option', {name: 'issue.status', exact: true}).click()
    await expect(page).toHaveURL(/kind=issue\.status/)
    await page.reload()
    await expect(page.getByRole('button', {name: 'Kind'})).toHaveText('issue.status')
    await expect(lines.filter({hasText: 'issue.status'})).not.toHaveCount(0)
    await expect(lines.filter({hasText: 'issue.created'})).toHaveCount(0)
    expect(new URL(page.url()).searchParams.get('project')).toBe('ledger')

    // None of a kind says which.
    await page.goto('/events?project=ledger&kind=backup.made')
    await expect(page.getByText('Nothing logged of backup.made in Ledger yet.')).toBeVisible()
})

test("an issue event's line links the issue, and following it opens the issue", async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Carry the one'})
    await page.goto('/events?project=ledger')
    // The line, not its Copy button, which names it too once it's open.
    const line = page.locator('[role=button][aria-expanded]').filter({hasText: new RegExp(`issue\\.created.*made ${issue.id}`)})
    await expect(line).toBeVisible()
    await expect(line.getByRole('link', {name: '[ledger]'})).toHaveAttribute('href', '/p/ledger')
    const link = line.getByRole('link', {name: issue.id})
    await expect(link).toHaveAttribute('href', `/p/ledger/issues/${issue.id}`)

    // The line still opens its details by keyboard; the link opens the issue, not them.
    await line.focus()
    await page.keyboard.press('Enter')
    await expect(line).toHaveAttribute('aria-expanded', 'true')
    await link.click()
    await expect(page).toHaveURL(new RegExp(`/p/ledger/issues/${issue.id}$`))
    await expect(page.getByText('Carry the one').first()).toBeVisible()
})
