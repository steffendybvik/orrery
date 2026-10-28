import {expect, test} from '@playwright/test'
import {OWNER, makeProject, projectApi} from './support'

// The Events page kept to a kind (ORR-401): a family picked shows every kind in it, one kind only itself, and the
// choice is in the URL, with the project's, so it's there again after a reload.
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
