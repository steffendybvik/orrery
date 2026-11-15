import {readFileSync} from 'node:fs'
import type {APIRequestContext, Page} from '@playwright/test'
import {OWNER} from './support'
import {expect, test} from './test'

// A global session (ORR-1079): one orrery started in its default folder, hearing every project, with none of its own.
// The Sessions page lists it under Global, apart from sessions that hear a few projects, and its card says so; Start
// session starts one with no project ticked. Projects of its own; the owner named if no one has yet.
const api = async (request: APIRequestContext, method: 'get' | 'post' | 'put', path: string, data?: object) => {
    const r = await request[method](`/api${path}`, {data, headers: {'Orrery-Actor': 'claude'}})
    expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy()
    const text = await r.text()
    return text ? JSON.parse(text) : null
}

/** This checkout's version, which the launcher and channel say they run, so neither shows as older. */
const {version} = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {version: string}

/** Holds a stream open, keeping what it says. */
function hold(baseURL: string, path: string) {
    const controller = new AbortController()
    const said = {text: ''}
    fetch(`${baseURL}${path}`, {signal: controller.signal}).then(async response => {
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) said.text += decoder.decode(chunk.value)
    }).catch(() => {})
    return {said, stop: () => controller.abort()}
}

/** With SHOTS_DIR set, a picture of `what` there, for the issue's Before and After. */
async function shot(page: Page, name: string) {
    if (!process.env.SHOTS_DIR) return
    // Once the dialog's fade has finished.
    await page.waitForTimeout(500)
    await page.screenshot({path: `${process.env.SHOTS_DIR}/${name}.png`})
}

test('lists a global session under Global, and starts one with no project ticked', async ({page, request, baseURL}) => {
    if (!(await api(request, 'get', '/owner')).named) await api(request, 'put', '/owner', {name: 'Ada Lovelace'})
    for (const [name, key] of [['Pantry', 'PAN'], ['Cellar', 'CEL']]) await api(request, 'post', '/projects', {name, key})
    // The orrery's own setting, shared with specs running beside this one: put back as it was.
    const was = (await (await request.get('/api/settings')).json()).starts ?? null
    const launcher = hold(baseURL!, `/api/projects/pantry/launches/stream?version=${version}`)
    let stream: ReturnType<typeof hold> | undefined
    try {
        await expect.poll(async () => (await api(request, 'get', '/projects/pantry/launches')).launchers).toBe(1)
        // A global session its launcher runs, as one would say after orrery restarted, and its channel hearing every project.
        await api(request, 'post', '/projects/pantry/launches/running', {launches: [{id: 'e2e1079e2e10', tmux: 'orrery-e2e-global', global: true}]})
        const every = (await api(request, 'get', '/projects')).map((p: {id: string}) => p.id).join(',')
        stream = hold(baseURL!, `/api/signals/stream?projects=${every}&session=e2e-global&name=everywhere&started=e2e1079e2e10&started_for=pantry&version=${version}&format=text`)
        await expect.poll(async () => (await api(request, 'get', '/projects/pantry/sessions')).find((s: {id: string}) => s.id === 'e2e-global')?.started?.global).toBe(true)

        await page.goto('/sessions')
        await expect(page.locator('#session-e2e-global')).toBeVisible()
        await shot(page, 'sessions')
        // Start session with no project ticked starts a global one, through a project that can start sessions now.
        if (!was) expect((await request.patch('/api/settings', {data: {starts: {limit: 5}}, headers: OWNER})).ok()).toBeTruthy()
        await page.getByRole('button', {name: 'Start session'}).first().click()
        const dialog = page.getByRole('dialog', {name: 'Start session'})
        await expect(dialog.getByRole('checkbox', {name: 'Pantry'})).toBeVisible()
        for (const box of await dialog.getByRole('checkbox', {checked: true}).all()) await box.uncheck()
        await expect(dialog.getByRole('checkbox', {checked: true})).toHaveCount(0)
        await shot(page, 'start')
        await page.keyboard.press('Escape')

        const global = page.locator('#sessions-global')
        await expect(global.getByRole('heading', {name: 'Global'})).toBeVisible()
        const card = global.locator('#session-e2e-global')
        await expect(card.getByText('global, no project of its own')).toBeVisible()
        // Once only: not again under Across projects.
        await expect(page.locator('#session-e2e-global')).toHaveCount(1)

        await page.getByRole('button', {name: 'Start session'}).first().click()
        for (const box of await dialog.getByRole('checkbox', {checked: true}).all()) await box.uncheck()
        await expect(dialog.getByText('none ticked: a global session')).toBeVisible()
        // Caught here rather than sent: one on its way would take a place under the limit the specs beside this one share.
        const sent: unknown[] = []
        await page.route(/\/api\/projects\/pantry\/launches$/, route => {
            sent.push(route.request().postDataJSON())
            return route.fulfill({status: 201, json: {id: 'e2e1079e2e11', project: 'pantry', after: 0, tmux: 'orrery-pantry-e2e1079e2e11', global: true}})
        })
        await dialog.getByRole('button', {name: /^Start session/}).click()
        await expect.poll(() => sent).toEqual([expect.objectContaining({global: true})])
    } finally {
        stream?.stop()
        launcher.stop()
        if (!was) await request.patch('/api/settings', {data: {starts: null}, headers: OWNER})
    }
})
