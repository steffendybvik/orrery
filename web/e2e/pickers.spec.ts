import {expect, test} from '@playwright/test'
import {OWNER, makeProject, projectApi} from './support'

// The settings that were native selects pick through the app's own picker: a project's releases, a chunk's
// priority, and where a removed status's issues go.
test.describe.configure({mode: 'serial'})

const api = projectApi('foundry')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Foundry', key: 'FDY'})
})

test("picks a project's releases", async ({page, request}) => {
    await page.goto('/p/foundry/settings')
    await page.getByRole('button', {name: 'Its releases'}).click()
    await page.getByRole('option', {name: 'Its own'}).click()
    await expect.poll(async () => (await api(request, 'get', '')).release_mode).toBe('own')
    await expect(page.getByRole('button', {name: 'Its releases'})).toHaveText('Its own')
})

test("picks a chunk's priority", async ({page, request}) => {
    const chunk = await api(request, 'post', '/chunks', {title: 'Casting'})
    await page.goto(`/p/foundry/roadmap/${chunk.id}`)
    await page.getByRole('button', {name: 'Chunk priority'}).click()
    await page.getByRole('option', {name: 'P1 · High'}).click()
    await expect.poll(async () => (await api(request, 'get', `/chunks/${chunk.id}`)).priority).toBe('P1')
})

test("picks where a removed status's issues go", async ({page, request}) => {
    await request.post('/api/statuses', {data: {name: 'Cooling', kind: 'started'}, headers: OWNER})
    await page.goto('/settings#statuses')
    await page.getByRole('button', {name: 'Remove Cooling'}).click()
    await page.getByRole('button', {name: 'Move its issues to'}).click()
    await page.getByRole('option', {name: 'Done'}).click()
    await expect(page.getByRole('button', {name: 'Move its issues to'})).toHaveText('Done')
    await page.getByRole('button', {name: 'Remove', exact: true}).click()
    await expect.poll(async () => (await (await request.get('/api/statuses')).json()).some((s: {id: string}) => s.id === 'cooling')).toBe(false)
})
