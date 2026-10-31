import type {APIRequestContext, Locator, Page} from '@playwright/test'
import {expect, test} from '@playwright/test'

// What the spec files split from the first-run story share: a project of their own made through the API, the API as
// an agent or as the owner (named Ada Lovelace by first-run.spec.ts, which runs before them all), a stream held open
// the way a channel holds it, and a new issue made from the page.
export const AGENT = {'Orrery-Actor': 'claude'}
export const OWNER = {'Orrery-Actor': 'ada_lovelace'}

/** The API under one project (`''` is the project itself), as an agent unless other headers are given. */
export function projectApi(project: string) {
    return (request: APIRequestContext, method: 'get' | 'post' | 'patch', path: string, data?: object, headers: Record<string, string> = AGENT) =>
        request[method](`/api/projects/${project}${path}`, {data, headers}).then(async r => {
            expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy()
            return r.json()
        })
}

/** Makes a project as an agent; its id is its name in lowercase. A retry finds the one its first try made. */
export async function makeProject(request: APIRequestContext, data: {name: string, key?: string, [field: string]: unknown}) {
    const made = await request.post('/api/projects', {data, headers: AGENT})
    if (made.status() === 409 && test.info().retry > 0) return (await request.get(`/api/projects/${data.name.toLowerCase()}`)).json()
    expect(made.ok(), await made.text()).toBeTruthy()
    return made.json()
}

/** Drags a card on the board to a column, finding the column once the drag has started: picking a card up adds the
 * columns the filter hides, which moves the others. */
export async function dragCard(page: Page, card: Locator, column: Locator) {
    await card.hover()
    await page.mouse.down()
    await page.mouse.move(10, 10, {steps: 2})
    await column.hover()
    await page.mouse.up()
}

/** A stream held open the way a channel or launcher holds it, keeping what arrives; `stop` lets it go. */
export function hold(baseURL: string, path: string) {
    const controller = new AbortController()
    const said = {text: ''}
    fetch(`${baseURL}${path}`, {signal: controller.signal}).then(async response => {
        const reader = response.body!.getReader()
        for (;;) {
            const {done, value} = await reader.read()
            if (done) return
            said.text += new TextDecoder().decode(value)
        }
    }).catch(() => {})
    return {said, stop: () => controller.abort()}
}

/** Makes an issue from the project's New issue dialog, in the status `where` names. */
export async function newIssue(page: Page, project: string, title: string, where: string) {
    await page.goto(`/p/${project}`)
    await page.getByRole('button', {name: 'New issue'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New issue'})
    await dialog.getByLabel('Title').fill(title)
    await dialog.getByRole('button', {name: 'Where'}).click()
    await dialog.getByRole('option', {name: new RegExp(`^${where}\\b`, 'i')}).click()
    await dialog.getByRole('button', {name: /Create issue/}).click()
    await expect(dialog).toBeHidden()
}
