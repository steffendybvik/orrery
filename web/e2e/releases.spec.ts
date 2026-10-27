import {expect, test} from '@playwright/test'
import {AGENT, makeProject, projectApi} from './support'

// A release made, an issue set for it from its page, its changelog drafted and it shipped; and a project drawing on
// its releases showing in it, in a section of its own.
test.describe.configure({mode: 'serial'})

const api = projectApi('bakery')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Bakery', key: 'BAK'})
})

test('makes a release, sets an issue for it from its page, and drafts its changelog', async ({page, request}) => {
    await api(request, 'patch', '', {repo: 'https://github.com/you/bakery', release_mode: 'own'})
    const issue = await api(request, 'post', '/issues', {title: 'Label the jars', status: 'done'})
    await page.goto('/p/bakery/releases')
    await page.getByRole('button', {name: 'New release'}).click()
    await page.getByLabel('Version').fill('1.0.0')
    await expect(page.getByLabel('Branch its work gathers on')).toHaveValue('v1.0.0')
    await page.getByRole('button', {name: 'Make it'}).click()
    await expect(page).toHaveURL(/\/p\/bakery\/releases\/1\.0\.0$/)
    await expect(page.getByRole('link', {name: 'PRs into it'})).toHaveAttribute('href', 'https://github.com/you/bakery/pulls?q=is%3Apr%20base%3Av1.0.0')

    await page.goto(`/p/bakery/issues/${issue.id}`)
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
    const made = await request.post('/api/projects', {data: {name: 'Mill', key: 'MIL', release_mode: 'shared', releases_from: 'bakery'}, headers: AGENT})
    expect(made.ok(), await made.text()).toBeTruthy()
    const added = await request.post('/api/projects/mill/issues', {data: {title: 'Stock the shelves', status: 'done', release: '1.0.0'}, headers: AGENT})
    expect(added.ok(), await added.text()).toBeTruthy()
    await page.goto('/p/bakery/releases/1.0.0')
    await expect(page.getByRole('main').getByRole('link', {name: 'Mill', exact: true})).toBeVisible()
    await expect(page.locator('[data-issue]', {hasText: 'Stock the shelves'})).toBeVisible()
    await expect(page.locator('[data-issue]', {hasText: 'Label the jars'})).toBeVisible()
})
