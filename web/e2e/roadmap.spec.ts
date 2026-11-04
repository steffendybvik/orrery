import {expect, test} from './test'
import {makeProject, projectApi} from './support'

// A chunk made from the roadmap, renamed, given a summary and removed.

const api = projectApi('orchard')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Orchard', key: 'ORC'})
})

test('makes a chunk from the roadmap, renames it, gives it a summary and removes it', async ({page, request}) => {
    await page.goto('/p/orchard/roadmap')
    await page.getByRole('button', {name: 'New chunk'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New chunk'})
    await dialog.getByLabel('Title').fill('Shelves')
    await dialog.getByLabel('Summary').fill('Where things go')
    await dialog.getByRole('button', {name: /Create chunk/}).click()
    await expect(page).toHaveURL(/\/p\/orchard\/roadmap\/\d+$/)
    const id = page.url().split('/').at(-1)!
    expect(await api(request, 'get', `/chunks/${id}`)).toMatchObject({title: 'Shelves', summary: 'Where things go', created_by: 'ada_lovelace'})

    await page.getByRole('heading', {name: 'Shelves'}).click()
    await page.getByLabel('Title', {exact: true}).fill('Shelving')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', {name: 'Shelving'})).toBeVisible()

    await page.getByRole('button', {name: 'Edit'}).click()
    await page.getByLabel('Summary', {exact: true}).fill('Where **everything** goes')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.locator('.doc strong', {hasText: 'everything'})).toBeVisible()
    expect(await api(request, 'get', `/chunks/${id}`)).toMatchObject({title: 'Shelving', summary: 'Where **everything** goes'})

    await page.getByRole('button', {name: 'Remove this chunk'}).click()
    await page.getByRole('button', {name: 'Remove', exact: true}).click()
    await expect(page).toHaveURL(/\/p\/orchard\/roadmap$/)
    expect((await request.get(`/api/projects/orchard/chunks/${id}`)).status()).toBe(404)
})

test("a chunk's right-click menu sets its priority, files an issue in it, copies its id, opens it and removes it (ORR-792)", async ({page, request}) => {
    const chunk = await api(request, 'post', '/chunks', {title: 'Ladders'})
    await api(request, 'post', '/issues', {title: 'Check the rungs', chunk: chunk.id})
    await page.goto('/p/orchard/roadmap')
    await page.evaluate(() => {
        const copied: string[] = (window as unknown as {copied: string[]}).copied = []
        navigator.clipboard.writeText = async text => { copied.push(text) }
    })
    const card = page.getByRole('link', {name: /Ladders/}).first()
    const menu = page.getByRole('menu', {name: `Actions for chunk ${chunk.id}`})

    await card.click({button: 'right'})
    await menu.getByRole('button', {name: 'Priority P1'}).click()
    await expect.poll(async () => (await api(request, 'get', `/chunks/${chunk.id}`)).priority).toBe('P1')
    // A pick closes the menu.
    await expect(menu).toHaveCount(0)

    await card.click({button: 'right'})
    await menu.getByRole('button', {name: 'Copy id'}).click()
    await expect(menu).toContainText(/Copied \S+/)
    expect((await page.evaluate(() => (window as unknown as {copied: string[]}).copied))[0]).toContain(String(chunk.id))
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    // The new issue lands in the chunk.
    await card.click({button: 'right'})
    await menu.getByRole('button', {name: 'New issue in it'}).click()
    const dialog = page.getByRole('dialog', {name: 'New issue'})
    await dialog.getByLabel('Title').fill('Oil the hinges')
    await dialog.getByRole('button', {name: /Create issue/}).click()
    await expect(page).toHaveURL(/\/p\/orchard\/issues\/ORC-\d+/)
    expect(await api(request, 'get', `/issues/${page.url().split('/').at(-1)}`)).toMatchObject({chunk: chunk.id})

    await page.goto('/p/orchard/roadmap')
    await card.click({button: 'right'})
    await menu.getByRole('button', {name: 'Open'}).click()
    await expect(page).toHaveURL(new RegExp(`/p/orchard/roadmap/${chunk.id}$`))

    // Remove asks first; Cancel leaves it, Remove takes the chunk and leaves its issues in no chunk.
    await page.goto('/p/orchard/roadmap')
    await card.click({button: 'right'})
    await menu.getByRole('button', {name: 'Remove…'}).click()
    await expect(menu).toContainText(`Remove chunk ${chunk.id}? Its 2 issues stay, in no chunk.`)
    await menu.getByRole('button', {name: 'Cancel'}).click()
    await expect(menu.getByRole('button', {name: 'Remove…'})).toBeVisible()
    await menu.getByRole('button', {name: 'Remove…'}).click()
    await menu.getByRole('button', {name: 'Remove', exact: true}).click()
    await expect.poll(async () => (await request.get(`/api/projects/orchard/chunks/${chunk.id}`)).status()).toBe(404)
    const left = await api(request, 'get', '/issues')
    const list = (Array.isArray(left) ? left : left.issues) as {title: string, chunk: unknown}[]
    expect(list.filter(i => ['Check the rungs', 'Oil the hinges'].includes(i.title)).map(i => i.chunk ?? null)).toEqual([null, null])
})
