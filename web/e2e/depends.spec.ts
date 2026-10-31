import {expect, test} from '@playwright/test'
import {OWNER, makeProject, projectApi} from './support'

// Issues that depend on others (ORR-601): linked from an issue's page, the waiting one marked Blocked on the list and the
// board until what it waits on is done, and ticked issues chained in the order the page lists them.

const api = projectApi('windmill')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Windmill', key: 'WND'})
})

test('links two issues on the page, and the waiting one is blocked until the other is done', async ({page, request}) => {
    const first = await api(request, 'post', '/issues', {title: 'Sharpen the millstone'})
    const second = await api(request, 'post', '/issues', {title: 'Grind the wheat'})
    await page.goto(`/p/windmill/issues/${second.id}`)
    const side = page.locator('aside')
    await side.getByRole('button', {name: 'Blocked by'}).click()
    // No Esc to close it: the picker shuts by itself while the pick saves, and Esc on the page goes back to the list.
    await page.getByRole('option', {name: new RegExp(`${first.id} · Sharpen the millstone`)}).click()
    await expect(side.getByRole('link', {name: first.id})).toBeVisible()
    await expect(page.locator('header p', {hasText: 'Waiting on'})).toContainText(first.id)
    expect((await api(request, 'get', `/issues/${second.id}`)).depends_on).toEqual([first.id])

    // Read the other way, on the first one's page.
    await page.goto(`/p/windmill/issues/${first.id}`)
    await expect(page.locator('aside').getByRole('link', {name: second.id})).toBeVisible()

    const chip = page.locator(`[data-issue="${second.id}"]`).getByTitle(`Waiting on ${first.id}`)
    await page.goto('/p/windmill?view=list')
    await expect(chip).toBeVisible()
    await expect(page.locator(`[data-issue="${first.id}"]`).getByText('Blocked')).toBeHidden()
    await page.goto('/p/windmill?view=board')
    await expect(chip).toBeVisible()

    // Done, it holds nothing up: the chip goes as the board catches up.
    await api(request, 'patch', `/issues/${first.id}`, {status: 'done'}, OWNER)
    await expect(chip).toBeHidden()
    await expect(page.locator(`[data-issue="${second.id}"]`)).toBeVisible()
})

test('blocks another from the page of the one in the way, and lets it go from either side (ORR-680)', async ({page, request}) => {
    const first = await api(request, 'post', '/issues', {title: 'Oil the sails'})
    const second = await api(request, 'post', '/issues', {title: 'Turn the cap'})
    await page.goto(`/p/windmill/issues/${first.id}`)
    const side = page.locator('aside')
    await side.getByRole('button', {name: 'Blocks', exact: true}).click()
    await page.getByRole('option', {name: new RegExp(`${second.id} · Turn the cap`)}).click()
    await expect.poll(async () => (await api(request, 'get', `/issues/${second.id}`)).depends_on).toEqual([first.id])
    await expect(side.getByRole('link', {name: second.id})).toBeVisible()

    // The other way is refused, and says why.
    await page.goto(`/p/windmill/issues/${second.id}`)
    await page.locator('aside').getByRole('button', {name: 'Blocks', exact: true}).click()
    await page.getByRole('option', {name: new RegExp(`${first.id} · Oil the sails`)}).click()
    await expect(page.locator('aside').getByText(/already depends on/)).toBeVisible()
    await page.reload()

    // One click under the title unblocks it.
    await page.locator('header p', {hasText: 'Waiting on'}).getByRole('button', {name: `Stop waiting on ${first.id}`}).click()
    await expect(page.locator('header p', {hasText: 'Waiting on'})).toBeHidden()
    expect((await api(request, 'get', `/issues/${second.id}`)).depends_on ?? []).toEqual([])

    // And from the one in the way, without opening the picker.
    await api(request, 'patch', `/issues/${second.id}`, {depends_on: [first.id]}, OWNER)
    await page.goto(`/p/windmill/issues/${first.id}`)
    await page.locator('aside').getByRole('button', {name: `Stop blocking ${second.id}`}).click()
    await expect.poll(async () => (await api(request, 'get', `/issues/${second.id}`)).depends_on ?? []).toEqual([])
    await expect(page.locator('aside').getByRole('link', {name: second.id})).toBeHidden()
})

test('ticks three issues and chains them in the order listed', async ({page, request}) => {
    const made = [
        await api(request, 'post', '/issues', {title: 'Open the sluice'}),
        await api(request, 'post', '/issues', {title: 'Turn the wheel'}),
        await api(request, 'post', '/issues', {title: 'Sack the flour'}),
    ]
    await page.goto('/p/windmill?view=list')
    for (const {id} of made) await page.getByRole('checkbox', {name: `Select ${id}`}).click()
    // The order the page lists them in, top to bottom, whatever order they were ticked in.
    const listed = (await page.locator('main [data-issue]').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.issue!)))
        .filter(id => made.some(m => m.id === id))
    const bar = page.getByRole('toolbar', {name: 'Change the ticked issues'})
    await bar.getByRole('button', {name: 'Chain in order'}).click()
    await expect(bar.getByRole('status')).toHaveText('Chained 3 issues')

    const [a, b, c] = listed as [string, string, string]
    expect((await api(request, 'get', `/issues/${a}`)).depends_on ?? []).toEqual([])
    expect((await api(request, 'get', `/issues/${b}`)).depends_on).toEqual([a])
    expect((await api(request, 'get', `/issues/${c}`)).depends_on).toEqual([b])
    await page.goto(`/p/windmill/issues/${b}`)
    const side = page.locator('aside')
    await expect(side.getByRole('link', {name: a})).toBeVisible()
    await expect(side.getByRole('link', {name: c})).toBeVisible()
    await page.goto(`/p/windmill/issues/${c}`)
    await expect(page.locator('aside').getByRole('link', {name: b})).toBeVisible()
})
