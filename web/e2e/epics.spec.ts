import {expect, test} from './test'
import {AGENT, makeProject, projectApi} from './support'

// An epic (ORR-895) made on the Epics page, picked on issues in two projects, and its page showing each project's part,
// with progress counted across both. Removing it leaves the issues where they are.

const front = projectApi('storefront')
const back = projectApi('tannery')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Storefront', key: 'STF'})
    await makeProject(request, {name: 'Tannery', key: 'TAN'})
})

test('makes an epic, picks it on issues in two projects, and shows each part on its page', async ({page, request}) => {
    const shown = await front(request, 'post', '/issues', {title: 'Track the basket', status: 'todo'})
    const stored = await back(request, 'post', '/issues', {title: 'Store the campaign', status: 'done'})

    await page.goto('/epics')
    await page.getByRole('button', {name: 'New epic'}).click()
    await page.getByLabel("The new epic's title").fill('Campaign attribution')
    await page.getByRole('button', {name: 'Add'}).click()
    await expect(page).toHaveURL(/\/epics\/\d+$/)
    const id = Number(new URL(page.url()).pathname.split('/').pop())
    await expect(page.getByText('No issues in this epic yet.')).toBeVisible()

    // One from its page, the other as a session would.
    await page.goto(`/p/storefront/issues/${shown.id}`)
    await page.getByRole('button', {name: 'Epic'}).click()
    await page.getByRole('option', {name: 'Campaign attribution'}).click()
    await expect.poll(async () => (await front(request, 'get', `/issues/${shown.id}`)).epic).toBe(id)
    await expect(page.getByText('put it in the epic Campaign attribution')).toBeVisible()
    await back(request, 'patch', `/issues/${stored.id}`, {epic: id})

    await page.getByRole('link', {name: 'Open the epic'}).click()
    await expect(page).toHaveURL(new RegExp(`/epics/${id}$`))
    await expect(page.getByText('2 issues in 2 projects')).toBeVisible()
    await expect(page.getByRole('main').getByRole('link', {name: 'Storefront'})).toBeVisible()
    await expect(page.getByRole('main').getByRole('link', {name: 'Tannery'})).toBeVisible()
    await expect(page.getByText('Track the basket')).toBeVisible()
    await expect(page.getByText('Store the campaign')).toBeVisible()

    await page.goto('/epics')
    const row = page.getByRole('list', {name: 'Epics'}).getByRole('link').filter({hasText: 'Campaign attribution'})
    await expect(row).toContainText('2 issues')
    await expect(row).toContainText('Storefront')
    await expect(row).toContainText('Tannery')

    await row.click()
    await page.getByRole('button', {name: 'Remove this epic'}).click()
    await page.getByRole('button', {name: 'Remove'}).click()
    await expect(page).toHaveURL(/\/epics$/)
    await expect.poll(async () => (await front(request, 'get', `/issues/${shown.id}`)).epic).toBeUndefined()
    expect((await request.get(`/api/epics/${id}`, {headers: AGENT})).status()).toBe(404)
})
