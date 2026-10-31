import {expect, test} from '@playwright/test'
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
