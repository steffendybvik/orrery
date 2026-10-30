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
    // Under Changes, as it has no label that puts it in another group (ORR-516).
    await expect(page.locator('pre', {hasText: `## 1.0.0 (unreleased)`})).toContainText(`### Changes\n\n- Label the jars (${issue.id})`)
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

test('the Releases page lists every project, a shared release once, and follows one to its page (ORR-671)', async ({page, request}) => {
    await page.goto('/releases')
    const bakery = page.getByRole('list', {name: 'Releases of Bakery'})
    await expect(page.getByRole('link', {name: 'Bakery', exact: true}).last()).toBeVisible()
    // Mill takes its releases from Bakery, so it's on Bakery's card and has none of its own.
    await expect(page.getByText('shared with Mill')).toBeVisible()
    await expect(page.getByRole('list', {name: 'Releases of Mill'})).toHaveCount(0)
    await expect(bakery.getByRole('link')).toHaveCount(1)
    await expect(bakery.getByRole('link')).toContainText('1.0.0')
    await expect(bakery.getByRole('link')).toContainText('Mill')

    // Live: a release made through the API shows without a reload, being prepared, on top of the shipped one.
    await api(request, 'post', '/releases', {version: '1.1.0', branch: 'v1.1.0'})
    await expect(bakery.getByRole('link')).toHaveCount(2)
    await expect(bakery.getByRole('link').first()).toContainText('1.1.0')
    await expect(bakery.getByRole('link').first()).toContainText('Preparing')

    // The older ones fold away: once 1.1.0 ships after it, 1.0.0 goes under them.
    await api(request, 'patch', '/releases/1.1.0', {shipped_on: '2999-01-01'})
    await expect(bakery.getByRole('link')).toHaveCount(1)
    await page.getByText('1 older').first().click()
    await expect(page.getByRole('list', {name: 'Older releases of Bakery'}).getByRole('link')).toContainText('1.0.0')

    // Kept to a project sharing them, in the address, its card is still Bakery's.
    await page.goto('/releases?project=mill')
    await expect(bakery.getByRole('link')).toContainText('1.1.0')
    await bakery.getByRole('link').click()
    await expect(page).toHaveURL(/\/p\/bakery\/releases\/1\.1\.0$/)
})
