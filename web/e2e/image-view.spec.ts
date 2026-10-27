import type {APIRequestContext} from '@playwright/test'
import {expect, test} from '@playwright/test'

// A picture in Markdown opens larger over the page on a click (ORR-286), not on a page of its own: a click outside it
// or Esc closes it and leaves you where you were. A project of its own; the owner named if no one has yet.
const AGENT = {'Orrery-Actor': 'claude'}
const api = async (request: APIRequestContext, method: 'get' | 'post' | 'put', path: string, data?: object) => {
    const r = await request[method](`/api${path}`, {data, headers: AGENT})
    expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy()
    return r.json()
}

test('opens a picture larger over the page, and closes it without leaving', async ({page, request}) => {
    if (!(await api(request, 'get', '/owner')).named) await request.put('/api/owner', {data: {name: 'Ada Lovelace'}})
    await api(request, 'post', '/projects', {name: 'Pictures', key: 'PIC'})
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const [before, after] = await Promise.all(['before', 'after'].map(name => api(request, 'post', '/uploads', {data: png, name})))
    const {id} = await api(request, 'post', '/projects/pictures/issues', {title: 'Hang the frames'})
    await api(request, 'post', `/projects/pictures/issues/${id}/comments`,
        {body: `![The hallway](${after.url})\n\n![Before: frames](${before.url})\n![After: frames](${after.url})`})
    const url = `/p/pictures/issues/${id}`
    await page.goto(url)

    const view = page.getByRole('dialog', {name: 'The hallway'})
    await page.locator('.doc a.image-link > img[alt="The hallway"]').click()
    await expect(view).toBeVisible()
    await expect(view.locator('img')).toHaveAttribute('src', after.url)
    await expect(view.getByRole('link', {name: 'Open original'})).toHaveAttribute('href', after.url)
    // Esc closes it, not the issue's page under it.
    await page.keyboard.press('Escape')
    await expect(view).toHaveCount(0)
    await expect(page).toHaveURL(url)

    // A slider's label opens its own picture; a click on the dimmed page closes it.
    await page.locator('.doc .compare').getByRole('link', {name: 'Before'}).click()
    const frames = page.getByRole('dialog', {name: 'Before: frames'})
    await expect(frames.locator('img')).toHaveAttribute('src', before.url)
    await frames.click({position: {x: 5, y: 5}})
    await expect(frames).toHaveCount(0)
    await expect(page).toHaveURL(url)
})
