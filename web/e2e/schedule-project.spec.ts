import type {APIRequestContext} from '@playwright/test'
import {expect, test} from './test'

// New schedule on the Schedules page opens the dialog on a project, and the project is picked in the dialog
// (ORR-279). Two projects of its own; the owner named if no one has yet.
const api = async (request: APIRequestContext, method: 'get' | 'post' | 'put', path: string, data?: object) => {
    const r = await request[method](`/api${path}`, {data})
    expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy()
    return r.json()
}

test('New schedule picks its project in the dialog', async ({page, request}) => {
    if (!(await api(request, 'get', '/owner')).named) await api(request, 'put', '/owner', {name: 'Ada Lovelace'})
    // bell.spec.ts makes Shed too, whichever runs first.
    for (const name of ['Garden', 'Shed']) if (!(await request.get(`/api/projects/${name.toLowerCase()}`)).ok()) await api(request, 'post', '/projects', {name})

    await page.goto('/schedules')
    await page.getByRole('button', {name: 'New schedule', exact: true}).click()
    const dialog = page.getByRole('dialog', {name: 'New schedule'})
    await dialog.getByRole('button', {name: 'Project'}).click()
    await dialog.getByRole('option', {name: 'Shed', exact: true}).click()
    await expect(dialog.getByRole('button', {name: 'Project'})).toContainText('Shed')
    // A retry finds the first try's schedule if it got as far as making it, so each try's has a title of its own.
    const title = test.info().retry ? `Oil the hinges (${test.info().retry})` : 'Oil the hinges'
    await dialog.getByLabel('Title').fill(title)
    await dialog.getByRole('button', {name: /Create schedule/}).click()
    await expect(dialog).toBeHidden()
    expect((await api(request, 'get', '/projects/shed/schedules')).map((s: {title: string}) => s.title).filter((t: string) => t === title)).toEqual([title])
    expect(await api(request, 'get', '/projects/garden/schedules')).toEqual([])
})
