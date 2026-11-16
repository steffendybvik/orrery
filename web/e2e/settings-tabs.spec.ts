import {expect, test} from './test'
import {OWNER} from './support'

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
    for (const name of ['Name', 'Colour', 'Team tracker', 'Issue statuses', 'Proposals', 'Secrets']) await expect(page.getByRole('heading', {name, exact: true})).toBeVisible()
    // Its name and colour first, then the projects, then how issues work, proposals first of those (ORR-612).
    expect(await page.locator('section[id]').evaluateAll(sections => sections.map(s => s.id)))
        .toEqual(['workspace', 'tint', 'projects', 'export', 'upload', 'proposals', 'tracker', 'statuses', 'people', 'secrets', 'move']) // moving it last (ORR-1249)
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

// The tint takes to the page's background and the sidebar framing it, and nothing on them: cards, inputs, menus and
// dialogs keep their colours (ORR-1252).
for (const colorScheme of ['light', 'dark'] as const) {
    test(`a tint colours the page's background and the sidebar, not what's on them (ORR-1252, ${colorScheme})`, async ({page, request}) => {
        await page.emulateMedia({colorScheme})
        const colours = async () => {
            await page.goto('/settings')
            await expect(page.getByRole('heading', {name: 'Your name'})).toBeVisible()
            return page.evaluate(() => {
                const of = (el: Element) => getComputedStyle(el).backgroundColor
                const probe = (cls: string) => {
                    const el = document.body.appendChild(document.createElement('div'))
                    el.className = cls
                    const colour = of(el)
                    el.remove()
                    return colour
                }
                return {page: of(document.body), frame: probe('bg-frame'), panel: probe('bg-panel'), raised: probe('bg-raised')}
            })
        }
        try {
            await request.patch('/api/settings', {data: {tint: null}, headers: OWNER})
            const plain = await colours()
            await request.patch('/api/settings', {data: {tint: 'teal'}, headers: OWNER})
            const tinted = await colours()
            await expect(page.locator('html[data-tint]')).toHaveCount(1)
            expect(tinted.page).not.toBe(plain.page)
            expect(tinted.frame).not.toBe(plain.frame)
            expect(tinted.panel).toBe(plain.panel)
            expect(tinted.raised).toBe(plain.raised)
        } finally {
            await request.patch('/api/settings', {data: {tint: null}, headers: OWNER})
        }
    })
}
