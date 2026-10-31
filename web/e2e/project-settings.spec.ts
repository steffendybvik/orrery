import {expect, test} from '@playwright/test'
import {makeProject} from './support'

// A project's own settings: its name, its icon and colour in the sidebar, and deleting it, which asks for its id.

test('renames a project, Esc puts the name back', async ({page, request}) => {
    await makeProject(request, {name: 'Cellar', key: 'CEL'})
    await page.goto('/p/cellar/settings')
    const name = page.getByRole('textbox', {name: 'Project name'})
    await name.fill('Wine cellar')
    await name.press('Enter')
    await expect.poll(async () => (await (await request.get('/api/projects/cellar')).json()).name).toBe('Wine cellar')
    await expect(page.locator('aside').getByRole('link', {name: 'Wine cellar'})).toBeVisible()

    await name.fill('Root cellar')
    await name.press('Escape')
    await expect(name).toHaveValue('Wine cellar')
})

test('picks an icon and its colour, and Use the ring goes back', async ({page, request}) => {
    await makeProject(request, {name: 'Pantry', key: 'PAN'})
    const project = async () => (await request.get('/api/projects/pantry')).json()
    await page.goto('/p/pantry/settings')
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
    await typed.fill('pantry')
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
