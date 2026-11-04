import type {APIRequestContext} from '@playwright/test'
import {expect, test} from '@playwright/test'

// The sidebar's sessions list is a panel of its own (ORR-897): its top edge drags it taller, its arrow folds it away,
// and both hold over a reload. A project of its own, with a session listening on it.
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

test('resizes and folds the sidebar sessions list, and remembers both', async ({page, request, baseURL}) => {
    await api(request, 'post', '/projects', {name: 'Boot room', key: 'BTR'})
    const stop = hold(baseURL!, '/api/projects/boot-room/signals/stream?session=e2e-boot-room&name=boot-room-one&format=text')
    try {
        await expect.poll(async () => (await api(request, 'get', '/projects/boot-room/sessions')).some((s: {id: string, listening: boolean}) => s.id === 'e2e-boot-room' && s.listening)).toBe(true)
        await page.goto('/p/boot-room')
        const panel = page.getByTestId('sidebar-sessions').first()
        const row = panel.getByRole('link', {name: /Boot room/})
        await expect(row).toBeVisible()

        // Dragged up, it grows by as much, and keeps that height.
        const handle = panel.getByRole('separator', {name: 'Resize the sessions list'})
        await expect(handle).toHaveAttribute('aria-valuenow', '224')
        const before = (await panel.boundingBox())!.height
        const box = (await handle.boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 60, {steps: 4})
        await page.mouse.up()
        await expect.poll(async () => (await panel.boundingBox())!.height).toBeGreaterThan(before + 50)
        const grown = Number(await handle.getAttribute('aria-valuenow'))
        // The arrows nudge it; double-click puts it back.
        await handle.focus()
        await page.keyboard.press('ArrowUp')
        await expect(handle).toHaveAttribute('aria-valuenow', String(grown + 16))
        await page.reload()
        await expect(handle).toHaveAttribute('aria-valuenow', String(grown + 16))
        await handle.dblclick()
        await expect(handle).toHaveAttribute('aria-valuenow', '224')

        // Folded, the list goes and the heading stays; still folded after a reload, and back on a second press.
        await panel.getByRole('button', {name: 'Fold the sessions away'}).click()
        await expect(row).toBeHidden()
        await expect(handle).toHaveCount(0)
        await expect(panel.getByRole('link', {name: 'Sessions'})).toBeVisible()
        await page.reload()
        await expect(row).toBeHidden()
        await panel.getByRole('button', {name: 'Show the sessions'}).click()
        await expect(row).toBeVisible()
    } finally {
        stop()
    }
})
