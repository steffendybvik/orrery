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

test('pops the sessions out to float anywhere, remembers where, and puts them back (ORR-901)', async ({page, request, baseURL}) => {
    await api(request, 'post', '/projects', {name: 'Grain store', key: 'GRS'})
    const stop = hold(baseURL!, '/api/projects/grain-store/signals/stream?session=e2e-grain-store&name=grain-store-one&format=text')
    try {
        await expect.poll(async () => (await api(request, 'get', '/projects/grain-store/sessions')).some((s: {id: string, listening: boolean}) => s.id === 'e2e-grain-store' && s.listening)).toBe(true)
        await page.setViewportSize({width: 1280, height: 800})
        await page.goto('/p/grain-store')
        const aside = page.locator('aside').first()
        await aside.getByRole('button', {name: 'Pop out the sessions'}).click()

        // Out of the sidebar, at the top right.
        const panel = page.getByRole('region', {name: 'Sessions'})
        await expect(panel).toBeVisible()
        await expect(aside.getByTestId('sidebar-sessions')).toHaveCount(0)
        let box = (await panel.boundingBox())!
        expect(box.x + box.width).toBeGreaterThan(1200)
        expect(box.y).toBeLessThan(100)
        await expect(panel.getByRole('link', {name: /Grain store/})).toBeVisible()

        // Dragged by its heading to the bottom left, it stays there over a reload.
        const heading = panel.getByRole('link', {name: 'Sessions'})
        const from = (await panel.getByTestId('sessions-float-grip').boundingBox())!
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
        await page.mouse.down()
        await page.mouse.move(400, 700, {steps: 6})
        await page.mouse.up()
        box = (await panel.boundingBox())!
        expect(box.x).toBeLessThan(640)
        expect(box.y + box.height).toBeGreaterThan(400)
        await page.reload()
        await expect(panel).toBeVisible()
        const kept = (await panel.boundingBox())!
        expect(Math.abs(kept.x - box.x)).toBeLessThan(2)
        expect(Math.abs(kept.y + kept.height - (box.y + box.height))).toBeLessThan(2)
        await expect(heading).toBeVisible()

        // Its grip's arrows move it; Esc folds it.
        const grip = panel.getByTestId('sessions-float-grip')
        await grip.focus()
        await page.keyboard.press('ArrowRight')
        await expect.poll(async () => (await panel.boundingBox())!.x).toBeCloseTo(kept.x + 16, 0)
        await page.keyboard.press('Escape')
        await expect(panel.getByRole('link', {name: /Grain store/})).toBeHidden()
        await panel.getByRole('button', {name: 'Show the sessions'}).click()

        // On a phone it's in the drawer, as before.
        await page.setViewportSize({width: 390, height: 800})
        await expect(page.getByRole('region', {name: 'Sessions'})).toHaveCount(0)
        await page.setViewportSize({width: 1280, height: 800})

        // Back in the sidebar, and still there after a reload.
        await page.getByRole('region', {name: 'Sessions'}).getByRole('button', {name: 'Back to the sidebar'}).click()
        await expect(aside.getByTestId('sidebar-sessions').getByRole('link', {name: /Grain store/})).toBeVisible()
        await page.reload()
        await expect(page.getByRole('region', {name: 'Sessions'})).toHaveCount(0)
        await expect(aside.getByTestId('sidebar-sessions')).toBeVisible()
    } finally {
        stop()
    }
})
