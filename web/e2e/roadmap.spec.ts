import {expect, test} from './test'
import {makeProject, projectApi} from './support'

// A milestone made from the roadmap, renamed, given a summary and removed.

const api = projectApi('orchard')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Orchard', key: 'ORC'})
})

test('makes a milestone from the roadmap, renames it, gives it a summary and removes it', async ({page, request}) => {
    await page.goto('/p/orchard/roadmap')
    await page.getByRole('button', {name: 'New milestone'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New milestone'})
    await dialog.getByLabel('Title').fill('Shelves')
    await dialog.getByLabel('Summary').fill('Where things go')
    await dialog.getByRole('button', {name: /Create milestone/}).click()
    await expect(page).toHaveURL(/\/p\/orchard\/roadmap\/\d+$/)
    const id = page.url().split('/').at(-1)!
    expect(await api(request, 'get', `/milestones/${id}`)).toMatchObject({title: 'Shelves', summary: 'Where things go', created_by: 'ada_lovelace'})

    await page.getByRole('heading', {name: 'Shelves'}).click()
    await page.getByLabel('Title', {exact: true}).fill('Shelving')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', {name: 'Shelving'})).toBeVisible()

    await page.getByRole('button', {name: 'Edit'}).click()
    await page.getByLabel('Summary', {exact: true}).fill('Where **everything** goes')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.locator('.doc strong', {hasText: 'everything'})).toBeVisible()
    expect(await api(request, 'get', `/milestones/${id}`)).toMatchObject({title: 'Shelving', summary: 'Where **everything** goes'})

    await page.getByRole('button', {name: 'Remove this milestone'}).click()
    await page.getByRole('button', {name: 'Remove', exact: true}).click()
    await expect(page).toHaveURL(/\/p\/orchard\/roadmap$/)
    expect((await request.get(`/api/projects/orchard/milestones/${id}`)).status()).toBe(404)
})

test("a milestone's right-click menu sets its priority, files an issue in it, copies its id, opens it and removes it (ORR-792)", async ({page, request}) => {
    const milestone = await api(request, 'post', '/milestones', {title: 'Ladders'})
    await api(request, 'post', '/issues', {title: 'Check the rungs', milestone: milestone.id})
    await page.goto('/p/orchard/roadmap')
    await page.evaluate(() => {
        const copied: string[] = (window as unknown as {copied: string[]}).copied = []
        navigator.clipboard.writeText = async text => { copied.push(text) }
    })
    // By its own address, as a retry finds the first try's Ladders on the roadmap too.
    const card = page.locator(`a[href="/p/orchard/roadmap/${milestone.id}"]`).first()
    const menu = page.getByRole('menu', {name: `Actions for milestone ${milestone.id}`})

    await card.click({button: 'right'})
    await menu.getByRole('button', {name: 'Priority P1'}).click()
    await expect.poll(async () => (await api(request, 'get', `/milestones/${milestone.id}`)).priority).toBe('P1')
    // A pick closes the menu.
    await expect(menu).toHaveCount(0)

    await card.click({button: 'right'})
    await menu.getByRole('button', {name: 'Copy id'}).click()
    await expect(menu).toContainText(/Copied \S+/)
    expect((await page.evaluate(() => (window as unknown as {copied: string[]}).copied))[0]).toContain(String(milestone.id))
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    // The new issue lands in the milestone.
    await card.click({button: 'right'})
    await menu.getByRole('button', {name: 'New issue in it'}).click()
    const dialog = page.getByRole('dialog', {name: 'New issue'})
    await dialog.getByLabel('Title').fill('Oil the hinges')
    await dialog.getByRole('button', {name: /Create issue/}).click()
    await expect(page).toHaveURL(/\/p\/orchard\/issues\/ORC-\d+/)
    expect(await api(request, 'get', `/issues/${page.url().split('/').at(-1)}`)).toMatchObject({milestone: milestone.id})

    await page.goto('/p/orchard/roadmap')
    await card.click({button: 'right'})
    await menu.getByRole('button', {name: 'Open'}).click()
    await expect(page).toHaveURL(new RegExp(`/p/orchard/roadmap/${milestone.id}$`))

    // Remove asks first; Cancel leaves it, Remove takes the milestone and leaves its issues in no milestone.
    await page.goto('/p/orchard/roadmap')
    await card.click({button: 'right'})
    await menu.getByRole('button', {name: 'Remove…'}).click()
    await expect(menu).toContainText(`Remove milestone ${milestone.id}? Its 2 issues stay, in no milestone.`)
    await menu.getByRole('button', {name: 'Cancel'}).click()
    await expect(menu.getByRole('button', {name: 'Remove…'})).toBeVisible()
    await menu.getByRole('button', {name: 'Remove…'}).click()
    await menu.getByRole('button', {name: 'Remove', exact: true}).click()
    await expect.poll(async () => (await request.get(`/api/projects/orchard/milestones/${milestone.id}`)).status()).toBe(404)
    const left = await api(request, 'get', '/issues')
    const list = (Array.isArray(left) ? left : left.issues) as {title: string, milestone: unknown}[]
    expect(list.filter(i => ['Check the rungs', 'Oil the hinges'].includes(i.title)).map(i => i.milestone ?? null)).toEqual([null, null])
})

test("comments on a milestone's page: an agent's shows up live, and the owner's posts, edits and comes out (ORR-977)", async ({page, request}) => {
    const milestone = await api(request, 'post', '/milestones', {title: 'Cider press'})
    await page.goto(`/p/orchard/roadmap/${milestone.id}`)
    const thread = page.getByRole('region', {name: 'Comments'})
    await expect(thread.getByRole('heading', {name: 'Comments'})).toBeVisible()
    // Said by an agent once the page is open: it comes in with the project's change.
    await api(request, 'post', `/milestones/${milestone.id}/comments`, {body: 'The **press** first.'})
    await expect(thread.locator('strong', {hasText: 'press'})).toBeVisible()

    await thread.getByRole('textbox', {name: 'Comment'}).fill('Then the bottling.')
    await thread.getByRole('button', {name: 'Comment', exact: true}).click()
    await expect(thread.getByText('Then the bottling.')).toBeVisible()
    await expect.poll(async () => (await api(request, 'get', `/milestones/${milestone.id}/comments`)).map((c: {body: string, protected: boolean}) => [c.body, c.protected]))
        .toEqual([['The **press** first.', false], ['Then the bottling.', true]])

    const mine = thread.locator('li', {hasText: 'Then the bottling.'})
    await mine.hover()
    await mine.getByRole('button', {name: 'Edit'}).click()
    await thread.getByRole('textbox', {name: 'Edit comment'}).fill('Then the bottling, in May.')
    await thread.getByRole('button', {name: 'Save'}).click()
    await expect(thread.getByText('Then the bottling, in May.')).toBeVisible()

    await thread.locator('li', {hasText: 'in May'}).hover()
    await thread.locator('li', {hasText: 'in May'}).getByRole('button', {name: 'Delete'}).click()
    await thread.getByRole('button', {name: 'Delete', exact: true}).click()
    await expect(thread.getByText('in May')).toHaveCount(0)
    // The agent's is no one's but its own to edit here: the page offers the owner's own only, as on an issue.
    await thread.locator('li', {hasText: 'first.'}).hover()
    await expect(thread.locator('li', {hasText: 'first.'}).getByRole('button', {name: 'Edit'})).toHaveCount(0)
})
