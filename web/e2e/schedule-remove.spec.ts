import type {APIRequestContext} from '@playwright/test'
import {expect, test} from '@playwright/test'

// A schedule comes out from its edit dialog, or from the ⋯ on its row, not only a right-click (ORR-282).
// A project of its own; the owner named if no one has yet.
const api = async (request: APIRequestContext, method: 'get' | 'post' | 'put', path: string, data?: object) => {
    const r = await request[method](`/api${path}`, {data})
    expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy()
    return r.json()
}
const titles = async (request: APIRequestContext) => (await api(request, 'get', '/projects/barn/schedules')).map((s: {title: string}) => s.title)

test('removes a schedule from its dialog, and from the ⋯ on its row', async ({page, request}) => {
    if (!(await api(request, 'get', '/owner')).named) await api(request, 'put', '/owner', {name: 'Ada Lovelace'})
    await api(request, 'post', '/projects', {name: 'Barn'})
    for (const title of ['Feed the hens', 'Sweep the loft']) await api(request, 'post', '/projects/barn/schedules', {title, cron: '0 9 * * 1'})

    await page.goto('/schedules?project=barn')
    await page.getByText('Feed the hens').click()
    const dialog = page.getByRole('dialog', {name: 'Edit schedule'})
    await dialog.getByRole('button', {name: 'Remove', exact: true}).click()
    await expect(dialog).toContainText('Remove this schedule?')
    await dialog.getByRole('button', {name: /^Remove/}).last().click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => titles(request)).toEqual(['Sweep the loft'])

    await page.getByRole('button', {name: 'More for Sweep the loft', exact: true}).click()
    const menu = page.getByRole('menu')
    await menu.getByRole('button', {name: /Remove/}).click()
    await menu.getByRole('button', {name: /Remove/}).last().click()
    await expect.poll(() => titles(request)).toEqual([])
})
