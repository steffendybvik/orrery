import type {APIRequestContext} from '@playwright/test'
import {expect, test} from '@playwright/test'

// A session whose channel hears several projects spans them (ORR-283): the Sessions page lists it once, under Across
// projects with the projects it hears, and each of those with sessions of its own says it hears it too; the sidebar
// says how many projects. Projects of its own; the owner named if no one has yet.
const api = async (request: APIRequestContext, method: 'get' | 'post' | 'put', path: string, data?: object) => {
    const r = await request[method](`/api${path}`, {data, headers: {'Orrery-Actor': 'claude'}})
    expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy()
    return r.json()
}

function hold(baseURL: string, path: string) {
    const controller = new AbortController()
    fetch(`${baseURL}${path}`, {signal: controller.signal}).then(async response => {
        const reader = response.body!.getReader()
        while (!(await reader.read()).done) { /* keep it open */ }
    }).catch(() => {})
    return () => controller.abort()
}

test('lists a session that hears several projects once, across them', async ({page, request, baseURL}) => {
    if (!(await api(request, 'get', '/owner')).named) await api(request, 'put', '/owner', {name: 'Ada Lovelace'})
    for (const [name, key] of [['Attic', 'ATT'], ['Garage', 'GAR'], ['Loft', 'LFT']]) await api(request, 'post', '/projects', {name, key})
    const stops = [
        hold(baseURL!, '/api/signals/stream?projects=attic,garage&session=e2e-span&name=tidy-up'),
        hold(baseURL!, '/api/projects/attic/signals/stream?session=e2e-attic&name=attic-one&format=text'),
    ]
    try {
        await expect.poll(async () => (await api(request, 'get', '/projects/attic/sessions')).filter((s: {id: string, listening: boolean}) => ['e2e-span', 'e2e-attic'].includes(s.id) && s.listening).length).toBe(2)
        await page.goto('/sessions')

        const across = page.locator('#sessions-across')
        await expect(across.getByRole('heading', {name: 'Across projects'})).toBeVisible()
        const card = across.locator('#session-e2e-span')
        await expect(card.getByLabel('Hears Attic, Garage')).toBeVisible()
        await expect(card.getByText("can't hear signals")).toHaveCount(0)
        // Once only: not again under Attic, where it's a line pointing to it.
        await expect(page.locator('#session-e2e-span')).toHaveCount(1)
        const attic = page.locator('#sessions-attic')
        await expect(attic.locator('#session-e2e-attic')).toBeVisible()
        await expect(attic.getByText('Also hears this, via tidy-up across projects')).toBeVisible()
        // Garage has no session of its own, so no group.
        await expect(page.locator('#sessions-garage')).toHaveCount(0)

        await expect(page.locator('aside').first().getByRole('link', {name: /tidy-up/}).getByText('2 projects')).toBeVisible()
    } finally {
        stops.forEach(stop => stop())
    }
})
