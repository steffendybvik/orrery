import {expect, test} from '@playwright/test'

// A newer orrery is out (ORR-608): a notice at the sidebar's foot, above the version, hidden for that version by ×
// and back for the next. The e2e server never asks GitHub (NUXT_UPDATE_CHECK=false), so its answer is played here.
test('shows a newer version above the version, until hidden for that version', async ({page}) => {
    let newer: {version: string, url: string} | null = {version: '9.0.0-rc.1', url: 'https://github.com/steffendybvik/orrery/releases/tag/v9.0.0-rc.1'}
    await page.route('**/api/version', route => route.fulfill({json: {version: '1.0.0-rc.13', newer}}))
    // Reloads, and waits for the page to have asked, so a notice that's missing is missing, not still on its way.
    const reload = () => Promise.all([page.waitForResponse('**/api/version'), page.reload()])
    await page.goto('/mine')
    const notice = page.locator('aside').getByRole('status').filter({hasText: 'is out'})
    await expect(notice).toContainText('orrery 9.0.0-rc.1 is out')
    await expect(notice.getByRole('link', {name: "What's new"})).toHaveAttribute('href', newer.url)
    await expect(notice.getByRole('link', {name: 'Updating'})).toHaveAttribute('href', /docs\/running\.md#updating$/)
    // Above the version, at the foot.
    const version = page.locator('aside p.font-mono')
    expect((await notice.boundingBox())!.y).toBeLessThan((await version.boundingBox())!.y)

    await notice.getByRole('button', {name: 'Hide the notice for 9.0.0-rc.1'}).click()
    await expect(notice).toHaveCount(0)
    await reload()
    await expect(notice).toHaveCount(0)

    // The next version shows again; none newer, none at all.
    newer = {version: '9.0.0-rc.2', url: 'https://github.com/steffendybvik/orrery/releases/tag/v9.0.0-rc.2'}
    await page.reload()
    await expect(notice).toContainText('orrery 9.0.0-rc.2 is out')
    newer = null
    await reload()
    await expect(notice).toHaveCount(0)
})
