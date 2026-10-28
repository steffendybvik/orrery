import {expect, test} from '@playwright/test'
import {makeProject, projectApi} from './support'

// A schedule made on its project, kept to it, paused and removed.
test.describe.configure({mode: 'serial'})

const api = projectApi('vineyard')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Vineyard', key: 'VIN'})
    await makeProject(request, {name: 'Cottage', key: 'COT'})
})

test('makes a schedule, keeps to its project, pauses and removes it', async ({page, request}) => {
    await page.goto('/schedules?project=vineyard')
    await page.getByRole('button', {name: 'New schedule in Vineyard'}).click()
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
    // The same big button now offers to resume it.
    await expect(page.getByRole('button', {name: 'Resume Groom the backlog', exact: true})).toBeVisible()
    // Kept to another project, it isn't there; the old tab comes here kept to vineyard.
    await page.getByRole('button', {name: 'Project', exact: true}).click()
    await page.getByRole('option', {name: 'Cottage'}).click()
    await expect(page.getByText('Groom the backlog')).toBeHidden()
    await page.goto('/p/vineyard/schedules')
    await expect(page).toHaveURL(/\/schedules\?project=vineyard/)

    await page.getByText('Groom the backlog').click({button: 'right'})
    await page.getByRole('menu').getByRole('button', {name: /Remove/}).click()
    await page.getByRole('menu').getByRole('button', {name: /Remove/}).last().click()
    await expect.poll(async () => (await api(request, 'get', '/schedules')).length).toBe(0)
})

test('runs a schedule now instead of its next run, which it skips', async ({page, request}) => {
    const made = await api(request, 'post', '/schedules', {title: 'Water the vines', cron: '0 9 * * *', timezone: 'UTC'})
    await page.goto('/schedules?project=vineyard')
    await page.getByText('Water the vines').click({button: 'right'})
    await page.getByRole('menu').getByRole('button', {name: /Run now instead of/}).click()
    await expect(page.getByRole('menu')).toBeHidden()
    await expect.poll(async () => (await api(request, 'get', `/schedules/${made.id}`)).runs[0]?.outcome).toBe('made')
    const after = await api(request, 'get', `/schedules/${made.id}`)
    expect(new Date(after.next_run).getTime() - new Date(made.next_run).getTime()).toBe(86_400_000)
    expect(after.runs[0].note).toMatch(/^instead of \w{3} \d+ \w{3} 09:00$/)
})

test("a suggested schedule opens filled in, and leaves the list once it's made", async ({page, request}) => {
    await page.goto('/schedules?project=cottage')
    const suggested = page.locator('section', {has: page.getByRole('heading', {name: 'Suggested for Cottage'})})
    await expect(suggested.getByRole('button', {name: /^Add /})).toHaveCount(4)
    await suggested.getByRole('button', {name: 'Add Review an issue in review'}).click()
    const dialog = page.getByRole('dialog', {name: 'New schedule'})
    await expect(dialog.getByLabel('Title')).toHaveValue('Review an issue in review')
    await expect(dialog.getByRole('button', {name: /Review/, pressed: true})).toBeVisible()
    await dialog.getByRole('button', {name: /Create schedule/}).click()
    await expect(dialog).toBeHidden()

    const cottage = projectApi('cottage')
    const [made] = await cottage(request, 'get', '/schedules')
    expect(made).toMatchObject({kind: 'session', on: 'issue.status', on_filter: {to: 'in-review'}, enabled: true})
    expect(made.presets).toHaveLength(1)
    await expect(suggested.getByRole('button', {name: 'Add Review an issue in review'})).toBeHidden()
    await expect(suggested.getByRole('button', {name: /^Add /})).toHaveCount(3)
})

test("says an agent's schedule is the agent's, and runs it only once the owner makes it theirs (ORR-456)", async ({page, request}) => {
    // Open first: what was there before the first visit counts as seen. `api` sends as an agent.
    await page.goto('/schedules?project=vineyard')
    await expect(page.getByRole('button', {name: 'New schedule in Vineyard'})).toBeVisible()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('orrery-seen'))).not.toBeNull()
    const made = await api(request, 'post', '/schedules', {kind: 'message', title: 'Nudge the sessions', notes: 'Pick up Todo.', cron: '0 9 * * *', timezone: 'UTC'})
    expect(made).toMatchObject({protected: false})
    const row = page.getByRole('button', {name: /Nudge the sessions/}).first()
    await expect(row).toContainText('not running until you make it yours')
    await expect(row.locator('.unseen-dot')).toBeVisible()
    await row.click()
    const dialog = page.getByRole('dialog', {name: 'Edit schedule'})
    await expect(dialog.getByRole('note')).toContainText("Its message doesn't reach the sessions until you make it yours")
    await dialog.getByRole('button', {name: 'Make it mine'}).click()
    await expect(dialog.getByRole('note')).toBeHidden()
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await api(request, 'get', `/schedules/${made.id}`)).protected).toBe(true)
    await expect(row).not.toContainText('not running')
    await expect(row.locator('.unseen-dot')).toBeHidden()
})
