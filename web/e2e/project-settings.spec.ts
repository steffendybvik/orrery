import {expect, test} from './test'
import {makeProject} from './support'

// A project's own settings: its name, its icon and colour in the sidebar, marking it as moved, and deleting it, which asks
// for its id.

test('renames a project, Esc puts the name back', async ({page, request}) => {
    await makeProject(request, {name: 'Dovecote', key: 'DOV'})
    await page.goto('/p/dovecote/settings')
    const name = page.getByRole('textbox', {name: 'Project name'})
    await name.fill('Bell tower')
    await name.press('Enter')
    await expect.poll(async () => (await (await request.get('/api/projects/dovecote')).json()).name).toBe('Bell tower')
    await expect(page.locator('aside').getByRole('link', {name: 'Bell tower'})).toBeVisible()

    await name.fill('Clock tower')
    await name.press('Escape')
    await expect(name).toHaveValue('Bell tower')
})

test('picks an icon and its colour, and Use the ring goes back', async ({page, request}) => {
    await makeProject(request, {name: 'Smokehouse', key: 'SMK'})
    const project = async () => (await request.get('/api/projects/smokehouse')).json()
    await page.goto('/p/smokehouse/settings')
    await page.getByRole('searchbox', {name: 'Find an icon'}).fill('bolt')
    await page.getByRole('button', {name: 'bolt', exact: true}).first().click()
    await expect.poll(async () => (await project()).icon).toBe('bolt')

    const colours = page.getByRole('group', {name: 'Icon colour'})
    await colours.getByRole('button').nth(1).click()
    await expect.poll(async () => (await project()).icon_color).toBeTruthy()

    await page.getByRole('button', {name: 'Use the ring'}).click()
    await expect.poll(async () => (await project()).icon).toBeFalsy()
})

test('deleting a project needs its id typed, and takes it away', async ({page, request}) => {
    await makeProject(request, {name: 'Larder', key: 'LAR'})
    await page.goto('/p/larder/settings')
    await page.getByRole('button', {name: 'Delete project…'}).click()
    const forever = page.getByRole('button', {name: 'Delete Larder forever'})
    await expect(forever).toBeDisabled()
    const typed = page.getByRole('textbox', {name: "Type the project's id to confirm"})
    await typed.fill('smokehouse')
    await expect(forever).toBeDisabled()
    await page.getByRole('button', {name: 'Cancel'}).click()
    expect((await request.get('/api/projects/larder')).status()).toBe(200)

    await page.getByRole('button', {name: 'Delete project…'}).click()
    await typed.fill('larder')
    await forever.click()
    await expect(page).toHaveURL(/\/mine$/)
    expect((await request.get('/api/projects/larder')).status()).toBe(404)
    await expect(page.locator('aside').getByRole('link', {name: 'Larder'})).toHaveCount(0)
})

test('marking a board as moved makes it read-only here, says where it went, and Undo lifts it (ORR-1225)', async ({page, request}) => {
    await makeProject(request, {name: 'Threshing Floor', key: 'THF'})
    await page.goto('/p/threshing-floor/settings')
    const moved = page.locator('#moved')
    await moved.getByRole('textbox', {name: 'The orrery it moved to'}).fill('https://orrery.example.com/')
    await moved.getByRole('button', {name: 'Mark as moved'}).click()
    await expect(moved.getByRole('link', {name: 'https://orrery.example.com'})).toBeVisible()
    const refused = await request.post('/api/projects/threshing-floor/issues', {data: {title: 'Still here?'}})
    expect(refused.status()).toBe(409)
    expect((await refused.json()).data.moved_to).toBe('https://orrery.example.com')

    await page.goto('/p/threshing-floor')
    await expect(page.getByRole('status').filter({hasText: 'Threshing Floor moved'})).toContainText('make changes there')

    await page.goto('/p/threshing-floor/settings')
    await moved.getByRole('button', {name: 'Undo'}).click()
    await expect(moved.getByRole('button', {name: 'Mark as moved'})).toBeVisible()
    expect((await request.post('/api/projects/threshing-floor/issues', {data: {title: 'Back again'}})).status()).toBe(201)
})
