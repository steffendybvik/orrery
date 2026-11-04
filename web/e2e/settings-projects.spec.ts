import {expect, test} from './test'
import {OWNER, makeProject} from './support'

// App settings → Projects (ORR-836): a starred project leads the sidebar's list, a hidden one folds away under Hidden
// and its page still opens. Only this spec's own projects are starred or hidden, and both are put back at the end.
test('stars a project to the top of the sidebar, hides another under Hidden', async ({page, request}) => {
    const {id: starredId} = await makeProject(request, {name: 'Zz Orangery', key: 'ZZO'})
    const {id: hiddenId} = await makeProject(request, {name: 'Zz Icehouse', key: 'ZZI'})
    try {
        await page.goto('/settings?tab=projects')
        await expect(page.getByRole('heading', {name: 'Projects in the sidebar'})).toBeVisible()
        const list = page.getByTestId('settings-projects')
        await list.getByRole('radiogroup', {name: 'Where the sidebar lists Zz Orangery'}).getByRole('radio', {name: 'Starred'}).click()
        await list.getByRole('radiogroup', {name: 'Where the sidebar lists Zz Icehouse'}).getByRole('radio', {name: 'Hidden'}).click()
        await expect.poll(async () => {
            const {starred, hidden} = await (await request.get('/api/settings')).json()
            return {starred: starred.includes(starredId), hidden: hidden.includes(hiddenId)}
        }).toEqual({starred: true, hidden: true})

        // Starred first, though its name sorts last; the hidden one is out of the list until Hidden opens.
        const sidebar = page.locator('aside')
        await expect(sidebar.getByRole('img', {name: 'Starred'})).toBeVisible()
        const projectLinks = () => sidebar.locator('a[href^="/p/"]').evaluateAll(links => links.map(a => a.getAttribute('href')).filter(href => /^\/p\/[^/]+$/.test(href ?? '')))
        await expect.poll(async () => (await projectLinks())[0]).toBe(`/p/${starredId}`)
        await expect(sidebar.getByRole('link', {name: /Zz Icehouse/})).toHaveCount(0)
        await sidebar.getByTestId('sidebar-hidden').click()
        // Just the hidden projects: the Projects page is in the nav, not under the fold (ORR-905).
        await expect(sidebar.locator('a[href="/projects?show=hidden"]')).toHaveCount(0)
        await sidebar.getByRole('link', {name: 'Zz Icehouse'}).click()
        await expect(page).toHaveURL(new RegExp(`/p/${hiddenId}`))
    } finally {
        const {starred, hidden} = await (await request.get('/api/settings')).json()
        await request.patch('/api/settings', {
            data: {starred: starred.filter((id: string) => id !== starredId), hidden: hidden.filter((id: string) => id !== hiddenId)},
            headers: OWNER,
        })
    }
})
