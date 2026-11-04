import {expect, test} from '@playwright/test'
import {OWNER} from './support'

// Usage, on its own tab of App settings (ORR-881, ORR-900): off until the owner turns it on, then the pages they open and the
// palette show with their counts, the listed features never used at the top; turned off, it offers to delete them.
test('counts nothing until turned on, then lists what was used, coldest first', async ({page, request}) => {
    test.info().annotations.push({type: 'state', description: 'turns counting on, and off again at the end'})
    // A link from when it was under Advanced opens its own tab.
    await page.goto('/settings?tab=advanced#usage')
    await expect(page).toHaveURL(/[?&]tab=usage/)
    await expect(page.getByRole('radio', {name: 'Usage'}).or(page.getByRole('tab', {name: 'Usage'})).first()).toBeVisible()
    const section = page.locator('#usage')
    const toggle = section.getByLabel('Count what I use')
    await expect(toggle).not.toBeChecked()
    await expect(section.getByRole('table', {name: 'Feature use'})).toBeHidden()

    await toggle.check()
    await expect(section.getByRole('table', {name: 'Feature use'})).toBeVisible()
    await page.goto('/sessions')
    await expect(page.getByRole('heading', {level: 1}).first()).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByRole('dialog', {name: 'Commands'})).toBeVisible()
    await page.keyboard.press('Escape')
    await page.goto('/settings?tab=usage')
    const table = section.getByRole('table', {name: 'Feature use'})
    await expect(table.locator('[data-feature="page:sessions"] td').nth(2)).toHaveText('1')
    await expect(table.locator('[data-feature="command-palette"] td').nth(2)).toHaveText('1')
    await expect(table.locator('[data-feature="presets"] td').nth(1)).toHaveText('never')
    // Coldest first: one never used comes before the pages that were.
    const order = await table.locator('tbody tr').evaluateAll(rows => rows.map(r => r.getAttribute('data-feature')))
    expect(order.indexOf('presets')).toBeLessThan(order.indexOf('page:sessions'))

    await toggle.uncheck()
    await section.getByRole('button', {name: 'Delete the counts'}).click()
    await expect(section.getByRole('table', {name: 'Feature use'})).toBeHidden()
    const after = await (await request.get('/api/usage', {headers: OWNER})).json() as {on: boolean, features: {last: string | null}[]}
    expect(after.on).toBe(false)
    expect(after.features.every(f => !f.last)).toBe(true)
})
