import {expect, test} from './test'

// App settings by what they reach (ORR-285): You, and the Workspace (ORR-1108: its name and colour, projects, how issues
// work, people and secrets), each tab saying so; a link to a section opens its tab, an old tab's link too. Which
// terminal Watch opens is with the sessions, under Sessions → Setup.
test('splits App settings into tabs by what they reach, and a link opens the right one', async ({page}) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', {name: 'Your name'})).toBeVisible()
    await expect(page.getByText('Who you are on this orrery')).toBeVisible()
    await expect(page.getByRole('heading', {name: 'Issue statuses'})).toHaveCount(0)

    await page.getByRole('radio', {name: 'Workspace'}).click()
    await expect(page).toHaveURL(/tab=workspace/)
    await expect(page.getByText('This workspace: its name and colour')).toBeVisible()
    for (const name of ['Name', 'Colour', 'Team tracker', 'Issue statuses', 'Proposals', 'Secrets', 'Storage']) await expect(page.getByRole('heading', {name, exact: true})).toBeVisible()
    // Its name and colour first, then the projects, then how issues work, proposals first of those (ORR-612).
    expect(await page.locator('section[id]').evaluateAll(sections => sections.map(s => s.id)))
        .toEqual(['workspace', 'tint', 'projects', 'export', 'upload', 'proposals', 'tracker', 'statuses', 'people', 'secrets', 'storage', 'move']) // moving it last (ORR-1249)
    // Storage (ORR-1250): with no image left behind, nothing to clean up.
    await expect(page.locator('#storage').getByText('Every image here is shown somewhere.')).toBeVisible()
    await expect(page.getByRole('button', {name: 'Clean up'})).toHaveCount(0)
    await expect(page.getByRole('heading', {name: 'Your name'})).toHaveCount(0)

    // An old tab's link opens the Workspace tab.
    await page.goto('/settings?tab=issues')
    await expect(page.getByRole('heading', {name: 'Issue statuses'})).toBeVisible()
    await page.goto('/settings#tint')
    for (const name of ['Colour', 'Secrets']) await expect(page.getByRole('heading', {name, exact: true})).toBeVisible()
    // The database is set only as orrery starts (ORR-1187): App settings has no section for it.
    for (const name of ['Database', 'Watching sessions']) await expect(page.getByRole('heading', {name})).toHaveCount(0)

    await page.goto('/sessions#watch')
    await expect(page.getByRole('heading', {name: 'Watching sessions'})).toBeVisible()
    await expect(page.locator('[data-picker="Terminal app"]')).toBeVisible()
})
