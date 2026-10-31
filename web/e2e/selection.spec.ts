import {expect, test} from '@playwright/test'
import {makeProject, projectApi} from './support'

// Ticking issues to change them together: a click (or one just beside the box), a drag over the ticks, a group's
// tick, and the bar that changes them.

const api = projectApi('workshop')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Workshop', key: 'WOR'})
})

test('ticks issues and changes them together', async ({page, request}) => {
    const a = await api(request, 'post', '/issues', {title: 'Sort the spices'})
    const b = await api(request, 'post', '/issues', {title: 'Date the flour'})
    await page.goto('/p/workshop?view=list')
    await page.getByRole('checkbox', {name: `Select ${a.id}`}).click()
    // A click that just misses the box, at the row's edge beside it, ticks too instead of opening the issue.
    const row = (await page.locator(`[data-issue="${b.id}"]`).boundingBox())!
    const box = (await page.getByRole('checkbox', {name: `Select ${b.id}`}).locator('span').boundingBox())!
    await page.mouse.click(box.x - 4, row.y + 2)
    await expect(page.getByRole('checkbox', {name: `Select ${b.id}`})).toHaveAttribute('aria-checked', 'true')
    await expect(page).toHaveURL(/\/p\/workshop\?view=list$/)
    const bar = page.getByRole('toolbar', {name: 'Change the ticked issues'})
    await expect(bar.getByText('2 selected')).toBeVisible()
    await bar.getByRole('button', {name: 'Priority'}).click()
    await page.getByRole('option', {name: 'High'}).click()
    await expect(bar.getByRole('status')).toHaveText('Changed 2 issues')
    for (const {id} of [a, b]) expect((await api(request, 'get', `/issues/${id}`)).priority).toBe('P1')
    await page.keyboard.press('Escape')
    await expect(bar.getByText('2 selected')).toBeHidden()
})

test('ticks a run by dragging over the ticks, and a whole group from its header', async ({page, request}) => {
    const made = [await api(request, 'post', '/issues', {title: 'Wipe the shelves'}), await api(request, 'post', '/issues', {title: 'Toss the stale crackers'}), await api(request, 'post', '/issues', {title: 'Refill the salt'})]
    await page.goto('/p/workshop?view=list')
    const tick = (id: string) => page.getByRole('checkbox', {name: `Select ${id}`})
    const centres = await Promise.all(made.map(async ({id}) => {
        const box = (await tick(id).boundingBox())!
        return {x: box.x + box.width / 2, y: box.y + box.height / 2}
    }))
    const [top, bottom] = [centres.reduce((a, b) => a.y < b.y ? a : b), centres.reduce((a, b) => a.y > b.y ? a : b)]
    // Pressing one tick and dragging over the others ticks them all, and doesn't open the one it's let go on.
    await page.mouse.move(top.x, top.y)
    await page.mouse.down()
    await page.mouse.move(bottom.x, bottom.y, {steps: 8})
    await page.mouse.up()
    for (const {id} of made) await expect(tick(id)).toHaveAttribute('aria-checked', 'true')
    await expect(page).toHaveURL(/\/p\/workshop\?view=list$/)
    const bar = page.getByRole('toolbar', {name: 'Change the ticked issues'})
    await expect(bar.getByText(/Drag over the ticks/)).toBeVisible()
    // Dragging back from a ticked one unticks them.
    await page.mouse.move(bottom.x, bottom.y)
    await page.mouse.down()
    await page.mouse.move(top.x, top.y, {steps: 8})
    await page.mouse.up()
    for (const {id} of made) await expect(tick(id)).toHaveAttribute('aria-checked', 'false')
    // A group's tick ticks every row in it, and a second click unticks them.
    const group = page.getByRole('checkbox', {name: /^Select all in /}).first()
    await group.click()
    await expect(group).toHaveAttribute('aria-checked', 'true')
    await expect(bar.getByText(/\d+ selected/)).toBeVisible()
    await group.click()
    await expect(bar).toBeHidden()
})
