import {expect, test} from './test'
import {AGENT, hold, makeProject, projectApi} from './support'

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

test('comments on an epic\'s page, the owner\'s and an agent\'s (ORR-977)', async ({page, request}) => {
    const epic = await (await request.post('/api/epics', {data: {title: 'Seasonal menu'}, headers: AGENT})).json() as {id: number}
    await request.post(`/api/epics/${epic.id}/comments`, {data: {body: 'Spring dishes first.'}, headers: AGENT})
    await page.goto(`/epics/${epic.id}`)
    const thread = page.getByRole('region', {name: 'Comments'})
    await expect(thread.getByText('Spring dishes first.')).toBeVisible()
    await thread.getByRole('textbox', {name: 'Comment'}).fill('And the summer ones by June.')
    await thread.getByRole('button', {name: 'Comment', exact: true}).click()
    await expect(thread.getByText('And the summer ones by June.')).toBeVisible()
    await expect.poll(async () => (await (await request.get(`/api/epics/${epic.id}/comments`)).json() as {body: string}[]).map(c => c.body))
        .toEqual(['Spring dishes first.', 'And the summer ones by June.'])
    // An agent can't take the owner's words away.
    const [, mine] = await (await request.get(`/api/epics/${epic.id}/comments`)).json() as {id: number}[]
    expect((await request.delete(`/api/epics/${epic.id}/comments/${mine!.id}`, {headers: AGENT})).status()).toBe(403)
})

test('focuses on an epic: a focus for each project with open issues in it (ORR-987)', async ({page, request}) => {
    const epic = await (await request.post('/api/epics', {data: {title: 'Loyalty stamps'}, headers: AGENT})).json() as {id: number}
    await front(request, 'post', '/issues', {title: 'Show the stamps', status: 'todo', epic: epic.id})
    await back(request, 'post', '/issues', {title: 'Count the stamps', status: 'todo', epic: epic.id})
    await page.goto(`/epics/${epic.id}`)
    await page.getByRole('button', {name: 'Focus on this'}).click()
    await expect(page.getByRole('status').filter({hasText: 'Sent to 2 projects'})).toBeVisible()
    for (const api of [front, back]) {
        const signals = await api(request, 'get', '/signals') as {epic?: number, milestone?: string}[]
        expect(signals.at(-1)).toMatchObject({epic: epic.id, milestone: 'all'})
    }
})

test("an epic's Sessions panel points one session, all of them, or a status at it, across its projects (ORR-958)", async ({page, request, baseURL}) => {
    const epic = await (await request.post('/api/epics', {data: {title: 'Gift cards'}, headers: AGENT})).json() as {id: number}
    await front(request, 'post', '/issues', {title: 'Show the card', status: 'todo', epic: epic.id})
    await back(request, 'post', '/issues', {title: 'Charge the card', status: 'in-progress', epic: epic.id})
    const both = hold(baseURL!, '/api/signals/stream?projects=storefront,tannery&session=e2e-both&name=both&format=text')
    const one = hold(baseURL!, '/api/projects/storefront/signals/stream?session=e2e-front&name=front&format=text')
    const last = async (api: typeof front) => (await api(request, 'get', '/signals') as {epic?: number, target?: string, status?: string}[]).at(-1)
    try {
        await page.goto(`/epics/${epic.id}`)
        const panel = page.getByRole('region', {name: 'Sessions'})
        await expect(panel.getByText('2 listening')).toBeVisible()
        const row = (name: string) => panel.getByRole('listitem').filter({hasText: name})
        await expect(row('both')).toContainText('hears all its projects')
        await expect(row('front')).toContainText('hears Storefront')

        // One that hears only Storefront takes just its part there.
        await row('front').getByRole('button', {name: 'Focus on this'}).click()
        await expect(panel.getByRole('status')).toHaveText('Sent to front, on Storefront')
        expect(await last(front)).toMatchObject({epic: epic.id, target: 'e2e-front'})
        await expect.poll(() => one.said.text).toContain('Show the card')

        // A status goes only where the epic has issues in it.
        await panel.getByRole('button', {name: 'Focus on all In progress'}).click()
        await page.getByRole('menuitem', {name: 'All 2 sessions'}).click()
        await expect.poll(async () => (await last(back))?.status).toBe('in-progress')
        expect(await last(front)).toMatchObject({target: 'e2e-front'})
        await expect.poll(() => both.said.text).toContain('Charge the card')

        // Right-clicking it in the Epics list does the same.
        await page.goto('/epics')
        await page.getByRole('link').filter({hasText: 'Gift cards'}).click({button: 'right'})
        const menu = page.getByRole('menu', {name: /Actions for EPC-/})
        await menu.getByRole('button', {name: 'Focus all 2 sessions on this'}).click()
        await expect(menu.getByRole('status')).toHaveText('Sent to 2 projects')
        expect(await last(front)).toMatchObject({epic: epic.id, target: '*'})
        expect(await last(back)).toMatchObject({epic: epic.id, target: '*'})
    } finally {
        both.stop()
        one.stop()
    }
})

test("shows an epic's id and copies its full form from its page (ORR-994, ORR-995)", async ({page, request}) => {
    const epic = await (await request.post('/api/epics', {data: {title: 'Gift cards'}, headers: AGENT})).json() as {id: number, full_id: string}
    expect(epic.full_id).toMatch(new RegExp(`^EPC-${epic.id}-[a-z2-7]{8}$`))
    await page.goto(`/epics/EPC-${epic.id}`)
    await expect(page.getByTestId('epic-id')).toHaveText(`EPC-${epic.id}`)
    await page.evaluate(() => {
        const copied: string[] = (window as unknown as {copied: string[]}).copied = []
        navigator.clipboard.writeText = async text => { copied.push(text) }
    })
    const copy = page.getByRole('button', {name: `Copy ${epic.full_id}`})
    await copy.focus()
    await page.keyboard.press('Enter')
    await expect(copy).toHaveText('Copied')
    expect(await page.evaluate(() => (window as unknown as {copied: string[]}).copied)).toEqual([epic.full_id])
})

test('gives a parent and its sub-issues a card of their own on an epic\'s page (ORR-1146)', async ({page, request}) => {
    const epic = await (await request.post('/api/epics', {data: {title: 'Gift wrapping'}, headers: AGENT})).json() as {id: number}
    await front(request, 'post', '/issues', {title: 'Price the paper', status: 'todo', epic: epic.id})
    const parent = await front(request, 'post', '/issues', {title: 'Wrap at the till', status: 'todo', epic: epic.id})
    await front(request, 'post', '/issues', {title: 'Fold the corners', status: 'todo', parent: parent.id})
    await front(request, 'post', '/issues', {title: 'Tie the ribbon', status: 'todo', parent: parent.id})
    await front(request, 'post', '/issues', {title: 'Stock the tags', status: 'todo', epic: epic.id})
    await page.goto(`/epics/${epic.id}`)
    const own = page.locator('[data-group]').filter({hasText: 'Wrap at the till'})
    await expect(own.locator('[data-issue]')).toHaveCount(3)
    await expect(own).toContainText('Fold the corners')
    await expect(own).toContainText('Tie the ribbon')
    await expect(own).not.toContainText('Price the paper')
    await expect(own).not.toContainText('Stock the tags')
    await expect(page.locator('[data-group]')).toHaveCount(3)
})
