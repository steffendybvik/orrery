import {expect, test} from '@playwright/test'
import {OWNER, makeProject} from './support'

// The Projects page (ORR-863): every project, hidden ones too, found by a search, kept to Starred or Hidden, and placed
// there as App settings → Projects places it, the same state. Only this spec's own project is hidden, and it's put back.
test('lists a hidden project, finds it, and shows it again from the page', async ({page, request}) => {
    const {id} = await makeProject(request, {name: 'Zz Glasshouse', key: 'ZZG'})
    try {
        await request.patch('/api/settings', {data: {hidden: [...(await (await request.get('/api/settings')).json()).hidden, id]}, headers: OWNER})
        await page.goto('/')
        const sidebar = page.locator('aside')
        await sidebar.getByRole('link', {name: /^Projects/}).click()
        await expect(page).toHaveURL(/\/projects$/)
        await expect(page.getByRole('heading', {name: 'Projects'})).toBeVisible()

        const list = page.getByTestId('projects-list')
        await page.getByRole('searchbox', {name: 'Find a project'}).fill('glasshouse')
        await expect(list.getByRole('listitem')).toHaveCount(1)
        await expect(list.getByRole('link', {name: /Zz Glasshouse/})).toBeVisible()
        await expect(page).toHaveURL(/q=glasshouse/)

        await page.getByRole('radiogroup', {name: 'Which projects'}).getByRole('radio', {name: /^Hidden/}).click()
        await expect(list.getByRole('link', {name: /Zz Glasshouse/})).toBeVisible()
        await list.getByRole('radiogroup', {name: 'Where the sidebar lists Zz Glasshouse'}).getByRole('radio', {name: 'Shown'}).click()
        await expect.poll(async () => (await (await request.get('/api/settings')).json()).hidden.includes(id)).toBe(false)
        await expect(page.getByText('No project matches “glasshouse”.')).toBeVisible()
        await expect(sidebar.getByRole('link', {name: /Zz Glasshouse/})).toBeVisible()
    } finally {
        const {hidden} = await (await request.get('/api/settings')).json()
        await request.patch('/api/settings', {data: {hidden: hidden.filter((other: string) => other !== id)}, headers: OWNER})
    }
})
