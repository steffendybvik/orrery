import {expect, test} from '@playwright/test'
import {OWNER, makeProject} from './support'

// What orrery puts into a session's context (ORR-549): for a work session, its instructions and each tool with their
// sizes and the total, biggest first, each part's text folded under it; and the chat's own set.
let advanced = false

test.beforeAll(async ({request}) => {
    advanced = !!(await (await request.get('/api/settings')).json()).advanced
    const on = await request.patch('/api/settings', {data: {advanced: true}, headers: OWNER})
    expect(on.ok(), await on.text()).toBeTruthy()
    if (!(await request.get('/api/projects/almanac')).ok()) await makeProject(request, {name: 'Almanac', key: 'ALM'})
})

test.afterAll(async ({request}) => {
    await request.patch('/api/settings', {data: {advanced}, headers: OWNER})
})

test("shows a work session's parts and their sizes, with the total, and the chat's own", async ({page, request}) => {
    const work = await (await request.get('/api/projects/almanac/context?kind=work')).json()
    await page.goto('/')
    await page.getByRole('link', {name: 'Context', exact: true}).click()
    await expect(page).toHaveURL(/\/context/)
    await page.goto('/context?project=almanac&kind=work')
    await expect(page.getByTestId('context-total')).toHaveText(`${work.chars.toLocaleString('en')} characters`)
    const parts = page.getByRole('list', {name: 'Parts'}).getByRole('listitem')
    await expect(parts).toHaveCount(work.parts.length)
    await expect(parts.filter({hasText: 'Server instructions'})).toHaveCount(1)
    await expect(parts.filter({hasText: /^\s*start_issue/})).toHaveCount(1)
    // Biggest first, and each part's text is there once it's opened.
    const first = work.parts.toSorted((a: {chars: number}, b: {chars: number}) => b.chars - a.chars)[0]
    await expect(parts.first()).toContainText(first.title)
    await parts.first().locator('summary').click()
    await expect(parts.first().locator('pre')).toContainText(first.text.slice(0, 40))

    await page.getByRole('button', {name: 'Chat', exact: true}).click()
    await expect(page).toHaveURL(/kind=chat/)
    await expect(parts.filter({hasText: 'reply'})).not.toHaveCount(0)
    await expect(parts.filter({hasText: /^\s*start_issue/})).toHaveCount(0)
})
