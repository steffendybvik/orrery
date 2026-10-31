import {expect, test} from '@playwright/test'
import {makeProject, projectApi} from './support'

// A schedule made on its project, kept to it, paused and removed.

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
    // It stays on the page, and says what it did (ORR-688).
    await expect(page.getByRole('status').getByText(/^Issue created: /)).toBeVisible()
    await expect(page).toHaveURL(/\/schedules\?project=vineyard/)
    const after = await api(request, 'get', `/schedules/${made.id}`)
    expect(new Date(after.next_run).getTime() - new Date(made.next_run).getTime()).toBe(86_400_000)
    expect(after.runs[0].note).toMatch(/^instead of \w{3} \d+ \w{3} 09:00$/)
})

test('runs a schedule from the issues page, and has no button with none to run (ORR-687)', async ({page, request}) => {
    const empty = await makeProject(request, {name: 'Hedgerow'})
    await page.goto(`/p/${empty.id}`)
    await expect(page.getByRole('button', {name: 'New issue'}).first()).toBeVisible()
    await expect(page.getByRole('button', {name: 'Run schedule'})).toBeHidden()

    await api(request, 'post', '/schedules', {title: 'Prune the vines', cron: '0 9 * * *', timezone: 'UTC'})
    await api(request, 'post', '/schedules', {title: 'Rest the vines', cron: '0 9 * * *', timezone: 'UTC', enabled: false})
    for (const view of ['board', 'list']) {
        await page.goto(`/p/vineyard?view=${view}`)
        await page.getByRole('button', {name: 'Run schedule'}).click()
        await expect(page.getByRole('button', {name: /Rest the vines.*Paused/})).toBeVisible()
        await expect(page.getByRole('button', {name: /Prune the vines.*Next /})).toBeVisible()
    }
    await page.getByRole('button', {name: /Prune the vines/}).click()
    const said = page.getByRole('status').getByRole('link', {name: /^Issue created: /})
    await expect(said).toBeVisible()
    await expect(page).toHaveURL(/\/p\/vineyard\?view=list/)
    await said.click()
    await expect(page).toHaveURL(/\/p\/vineyard\/issues\//)
})

test("a suggested schedule opens filled in, and leaves the list once it's made", async ({page, request}) => {
    await page.goto('/schedules?project=cottage')
    const suggested = page.locator('section', {has: page.getByRole('heading', {name: 'Suggested for Cottage'})})
    await expect(suggested.getByRole('button', {name: /^Add /})).toHaveCount(6)
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
    await expect(suggested.getByRole('button', {name: /^Add /})).toHaveCount(5)
})

test('a suggestion that moves issues is made paused (ORR-637)', async ({page, request}) => {
    await makeProject(request, {name: 'Arbour', key: 'ARB'})
    await page.goto('/schedules?project=arbour')
    const suggested = page.locator('section', {has: page.getByRole('heading', {name: 'Suggested for Arbour'})})
    await suggested.getByRole('button', {name: 'Add Merged PR closes its issue'}).click()
    const dialog = page.getByRole('dialog', {name: 'New schedule'})
    await expect(dialog.getByRole('radio', {name: 'Moves issues'})).toBeChecked()
    await expect(dialog.getByText("Paused: it won't run until you resume it")).toBeVisible()
    await dialog.getByRole('button', {name: /Create schedule/}).click()
    await expect(dialog).toBeHidden()
    const [made] = await projectApi('arbour')(request, 'get', '/schedules')
    expect(made).toMatchObject({kind: 'action', on: 'pr.merged', column: 'done', move_from: ['in-review'], enabled: false})
    await expect(suggested.getByRole('button', {name: 'Add Merged PR closes its issue'})).toBeHidden()
})

test('offers Review GitHub issues to a project on GitHub, every three hours (ORR-629)', async ({page, request}) => {
    await makeProject(request, {name: 'Quince', key: 'QUI', repo: 'https://github.com/you/quince.git'})
    await page.goto('/schedules?project=quince')
    const suggested = page.locator('section', {has: page.getByRole('heading', {name: 'Suggested for Quince'})})
    await expect(suggested).toContainText('Makes an issue')
    await expect(suggested).toContainText('Every 3 hours')
    await suggested.getByRole('button', {name: 'Add Review GitHub issues'}).click()
    const dialog = page.getByRole('dialog', {name: 'New schedule'})
    await expect(dialog.getByLabel('Title')).toHaveValue('Review GitHub issues')
    await expect(dialog.getByLabel('Instructions')).toHaveValue(/https:\/\/github\.com\/you\/quince\/issues/)
    await dialog.getByRole('button', {name: /Create schedule/}).click()
    await expect(dialog).toBeHidden()

    const [made] = await projectApi('quince')(request, 'get', '/schedules')
    expect(made).toMatchObject({kind: 'issue', title: 'Review GitHub issues', cron: '0 */3 * * *', skip_open: true, enabled: true})
    await expect(suggested.getByRole('button', {name: 'Add Review GitHub issues'})).toBeHidden()
})

test("says an agent's schedule is the agent's, and runs it only once the owner makes it theirs (ORR-456)", async ({page, request}) => {
    // Open first: what was there before the first visit counts as seen. `api` sends as an agent.
    await page.goto('/schedules?project=vineyard')
    await expect(page.getByRole('button', {name: 'New schedule in Vineyard'})).toBeVisible()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('orrery-seen'))).not.toBeNull()
    const made = await api(request, 'post', '/schedules', {kind: 'message', title: 'Nudge the sessions', notes: 'Pick up Todo.', cron: '0 9 * * *', timezone: 'UTC'})
    expect(made).toMatchObject({protected: false})
    const row = page.getByRole('button', {name: /Nudge the sessions/}).first()
    await expect(row).toContainText('by Agent · not running until you make it yours')
    await expect(row).not.toContainText('claude')
    await expect(row.locator('.unseen-dot')).toBeVisible()
    await row.click()
    const dialog = page.getByRole('dialog', {name: 'Edit schedule'})
    await expect(dialog.getByRole('note')).toContainText('An agent made this schedule.')
    await expect(dialog.getByRole('note')).toContainText("Its message doesn't reach the sessions until you make it yours")
    await dialog.getByRole('button', {name: 'Make it mine'}).click()
    await expect(dialog.getByRole('note')).toBeHidden()
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await api(request, 'get', `/schedules/${made.id}`)).protected).toBe(true)
    await expect(row).not.toContainText('not running')
    await expect(row.locator('.unseen-dot')).toBeHidden()
})

test('makes a schedule across projects, leaves one out, and removes it (ORR-638)', async ({page, request}) => {
    await page.goto('/schedules')
    await page.getByRole('button', {name: 'New schedule', exact: true}).click()
    const dialog = page.getByRole('dialog', {name: 'New schedule'})
    await dialog.getByRole('button', {name: 'Project', exact: true}).click()
    await dialog.getByRole('option', {name: 'All projects'}).click()
    await dialog.getByLabel('Title').fill('Weekly tidy everywhere')
    await dialog.getByRole('group', {name: "Projects it's for"}).getByRole('button', {name: 'Cottage'}).click()
    await dialog.getByRole('button', {name: /Create schedule/}).click()
    await expect(dialog).toBeHidden()

    const across = page.getByRole('region', {name: 'Across projects'})
    await expect(across.getByText('Weekly tidy everywhere')).toBeVisible()
    await expect(across.getByText(/All projects, not Cottage/)).toBeVisible()
    expect((await projectApi('vineyard')(request, 'get', '/schedules')).some((s: {title: string}) => s.title === 'Weekly tidy everywhere')).toBe(true)
    expect((await projectApi('cottage')(request, 'get', '/schedules')).some((s: {title: string}) => s.title === 'Weekly tidy everywhere')).toBe(false)

    await across.getByText('Weekly tidy everywhere').click()
    const edit = page.getByRole('dialog', {name: 'Edit schedule'})
    await edit.getByRole('button', {name: 'Remove', exact: true}).click()
    await edit.getByRole('button', {name: /Remove|Yes|Confirm/}).last().click()
    await expect(edit).toBeHidden()
    await expect(across).toBeHidden()
    expect((await projectApi('vineyard')(request, 'get', '/schedules')).some((s: {title: string}) => s.title === 'Weekly tidy everywhere')).toBe(false)
})

test('makes a schedule that moves issues, which runs on an event and has no Run now', async ({page, request}) => {
    await page.goto('/schedules?project=vineyard')
    await page.getByRole('button', {name: 'New schedule in Vineyard'}).click()
    const dialog = page.getByRole('dialog', {name: 'New schedule'})
    await dialog.getByRole('radio', {name: 'Moves issues'}).click()
    await dialog.getByLabel('Title').fill('Merged PR closes its issue')
    // On an event, with no clock to pick.
    await expect(dialog.getByRole('radio', {name: 'Time', exact: true})).toBeHidden()
    await dialog.getByRole('button', {name: 'Event', exact: true}).click()
    await dialog.getByRole('option', {name: "An issue's pull request is merged"}).click()
    await dialog.getByRole('group', {name: 'Moves it from'}).getByRole('button', {name: 'In review'}).click()
    await dialog.getByRole('button', {name: /Create schedule/}).click()
    await expect(dialog).toBeHidden()
    const made = (await api(request, 'get', '/schedules')).find((s: {title: string}) => s.title === 'Merged PR closes its issue')
    expect(made).toMatchObject({kind: 'action', on: 'pr.merged', column: 'done', move_from: ['in-review'], protected: true})
    await expect(page.getByText('moves to Done')).toBeVisible()

    await page.getByText('Merged PR closes its issue').click({button: 'right'})
    await expect(page.getByRole('menu').getByRole('button', {name: /Remove/})).toBeVisible()
    await expect(page.getByRole('menu').getByRole('button', {name: /Run now/})).toBeHidden()
})

test('Pause all goes at once, and Activate all asks first with the count', async ({page, request}) => {
    const project = {name: 'Trellis', key: 'TRL'}
    await request.post('/api/projects', {data: project, headers: {'Orrery-Actor': 'claude'}})
    const owner = {'Orrery-Actor': 'ada_lovelace'}
    for (const title of ['Prune', 'Tie in']) await request.post('/api/projects/trellis/schedules', {data: {title, cron: '0 9 * * *'}, headers: owner})
    const other = await (await request.post('/api/projects', {data: {name: 'Espalier', key: 'ESP'}, headers: {'Orrery-Actor': 'claude'}})).json()
    const theirs = await (await request.post(`/api/projects/${other.id}/schedules`, {data: {title: 'Stake', cron: '0 9 * * *'}, headers: owner})).json()
    const running = async () => (await (await request.get('/api/projects/trellis/schedules')).json() as {enabled: boolean}[]).filter(s => s.enabled).length

    await page.goto('/schedules')
    const card = page.locator('#schedules-trellis')
    const pauseAll = card.getByRole('button', {name: 'Pause all in Trellis'})
    const activateAll = card.getByRole('button', {name: 'Activate all in Trellis'})
    await expect(activateAll).toBeDisabled()

    await pauseAll.click()
    await expect(card.getByRole('status')).toHaveText('Paused 2 schedules.')
    await expect.poll(running).toBe(0)
    await expect(pauseAll).toBeDisabled()
    expect((await (await request.get(`/api/projects/${other.id}/schedules/${theirs.id}`)).json()).enabled).toBe(true)

    await activateAll.click()
    await expect(card).toContainText('Activate 2 schedules, including any paused on purpose?')
    await card.getByRole('button', {name: 'Cancel'}).click()
    expect(await running()).toBe(0)

    await activateAll.click()
    await card.getByRole('button', {name: 'Activate', exact: true}).click()
    await expect(card.getByRole('status')).toHaveText('Activated 2 schedules.')
    await expect.poll(running).toBe(2)
})
