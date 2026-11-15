import type {APIRequestContext, Page} from '@playwright/test'
import {expect, test} from './test'
import {OWNER, dragCard, makeProject, projectApi} from './support'

// Moving cards on the board by dragging them to another column, the ticked ones together, or with [ and ]; while
// proposals are restricted (the default), the owner can put a card into Proposed, and nothing comes out of it. A drop
// back on its own column or off the columns changes nothing (ORR-1200). The board drags with the mouse only: there's
// no touch drag to cover.

const api = projectApi('planetarium')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Planetarium', key: 'PLN'})
})

const card = (page: Page, id: string) => page.locator(`article[data-issue="${id}"]`)
const column = (page: Page, id: string) => page.locator(`section[data-column="${id}"]`)
const statusOf = async (request: APIRequestContext, id: string) => (await api(request, 'get', `/issues/${id}`)).column
/** Counts the issue writes the page sends from here on. */
function writes(page: Page) {
    const sent = {count: 0}
    page.on('request', r => {
        if (r.method() === 'PATCH' && r.url().includes('/issues/')) sent.count++
    })
    return sent
}

test('a card dragged to another column moves there', async ({page, request}) => {
    const jam = await api(request, 'post', '/issues', {title: 'Label the jam', status: 'todo'})
    await page.goto('/p/planetarium?view=board')
    await card(page, jam.id).dragTo(column(page, 'in-progress'))
    await expect.poll(() => statusOf(request, jam.id)).toBe('in-progress')
    await expect(column(page, 'in-progress').locator(`[data-issue="${jam.id}"]`)).toBeVisible()

    // It was saved, not only drawn there.
    await page.reload()
    await expect(column(page, 'in-progress').locator(`[data-issue="${jam.id}"]`)).toBeVisible()
    await expect(column(page, 'todo').locator(`[data-issue="${jam.id}"]`)).toHaveCount(0)
})

test('a card dropped back on its own column, or off the columns, stays where it was', async ({page, request}) => {
    const lid = await api(request, 'post', '/issues', {title: 'Find the lid', status: 'todo'})
    await page.goto('/p/planetarium?view=board')
    const sent = writes(page)

    await dragCard(page, card(page, lid.id), column(page, 'todo'))
    await dragCard(page, card(page, lid.id), page.locator('header').first())
    await page.waitForTimeout(300)
    expect(sent.count).toBe(0)
    expect(await statusOf(request, lid.id)).toBe('todo')
    await expect(column(page, 'todo').locator(`[data-issue="${lid.id}"]`)).toBeVisible()
    // Nothing is left dimmed or marked as being dragged.
    await expect(card(page, lid.id)).not.toHaveClass(/opacity-40/)
})

test('a card dragged to Done is done, as from its page: what waited on it is no longer blocked', async ({page, request}) => {
    const flour = await api(request, 'post', '/issues', {title: 'Sift the flour', status: 'in-progress'})
    const dough = await api(request, 'post', '/issues', {title: 'Knead the dough', status: 'todo'})
    await api(request, 'patch', `/issues/${dough.id}`, {depends_on: [flour.id]}, OWNER)
    await page.goto('/p/planetarium?view=board')
    const chip = card(page, dough.id).getByTitle(`Waiting on ${flour.id}`)
    await expect(chip).toBeVisible()

    // Done is filtered out to begin with, so it only shows to drop on once the card is picked up.
    await dragCard(page, card(page, flour.id), column(page, 'done'))
    await expect.poll(() => statusOf(request, flour.id)).toBe('done')
    const done = await api(request, 'get', `/issues/${flour.id}`)
    expect(done.kind).toBe('done')
    await expect(card(page, flour.id)).toHaveCount(0)
    await expect(chip).toBeHidden()
    expect((await api(request, 'get', `/issues/${dough.id}`)).column).toBe('todo')
})

test('the ticked cards move together, to a column the filter hides too', async ({page, request}) => {
    const made = [await api(request, 'post', '/issues', {title: 'Stack the tins', status: 'todo'}), await api(request, 'post', '/issues', {title: 'Sweep the floor', status: 'todo'})]
    await page.goto('/p/planetarium?view=board')
    for (const {id} of made) await page.getByRole('checkbox', {name: `Select ${id}`}).click()
    // Done is filtered out to begin with, so it's only there to drop on once a card is picked up.
    await expect(column(page, 'done')).toHaveCount(0)
    await dragCard(page, card(page, made[0]!.id), column(page, 'done'))
    for (const {id} of made) await expect.poll(() => statusOf(request, id)).toBe('done')
})

test('[ and ] move the focused card to the column on its left or right', async ({page, request}) => {
    const rice = await api(request, 'post', '/issues', {title: 'Weigh the rice', status: 'todo'})
    await page.goto('/p/planetarium?view=board')
    await card(page, rice.id).focus()
    // Started columns come first, so Backlog is right of Todo.
    await page.keyboard.press(']')
    await expect.poll(() => statusOf(request, rice.id)).toBe('backlog')
    await expect(column(page, 'backlog').locator(`[data-issue="${rice.id}"]`)).toBeFocused()
    await page.keyboard.press('[')
    await expect.poll(() => statusOf(request, rice.id)).toBe('todo')
})

test('the owner drags a card into Proposed, and nothing comes out while proposals are restricted', async ({page, request}) => {
    const proposal = await api(request, 'post', '/issues', {title: 'Buy a second freezer', proposal: 'pending'})
    const oats = await api(request, 'post', '/issues', {title: 'Seal the oats', status: 'todo'})
    await page.goto('/p/planetarium?view=board')
    await expect(card(page, proposal.id)).toHaveAttribute('draggable', 'false')
    await dragCard(page, card(page, oats.id), column(page, 'proposed'))
    await expect.poll(() => statusOf(request, oats.id)).toBe('proposed')
    await expect(column(page, 'proposed').locator(`[data-issue="${oats.id}"]`)).toBeVisible()

    await dragCard(page, card(page, proposal.id), column(page, 'todo'))
    await page.waitForTimeout(300)
    expect(await statusOf(request, proposal.id)).toBe('proposed')
})

test('[ and ] land in Proposed, and leave a proposal where it is', async ({page, request}) => {
    const salt = await api(request, 'post', '/issues', {title: 'Sort the salt', status: 'backlog'})
    await page.goto('/p/planetarium?view=board')
    await card(page, salt.id).focus()
    await page.keyboard.press(']')
    await expect.poll(() => statusOf(request, salt.id)).toBe('proposed')
    await expect(column(page, 'proposed').locator(`[data-issue="${salt.id}"]`)).toBeFocused()
    await page.keyboard.press('[')
    await page.waitForTimeout(300)
    expect(await statusOf(request, salt.id)).toBe('proposed')
})
