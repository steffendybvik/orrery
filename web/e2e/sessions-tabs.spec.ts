import {expect, test} from '@playwright/test'
import {PERMISSIONS, SESSION_KINDS, permissionAreas} from '../shared/permissions'

// The Sessions page's tabs: Sessions, what's running, Setup, how sessions start and what they hear, and Permissions, what
// each kind may do. A link to one of Setup's sections opens Setup. The owner is named if no one has yet.
test.beforeAll(async ({request}) => {
    if (!(await (await request.get('/api/owner')).json()).named) await request.put('/api/owner', {data: {name: 'Ada Lovelace'}})
    if ((await request.get('/api/projects/tabs')).status() === 404) await request.post('/api/projects', {data: {name: 'Tabs'}})
})

test('the Sessions page keeps what runs and how it is set up on two tabs', async ({page}) => {
    await page.goto('/sessions')
    // The tab, first; the no-sessions note links to Setup too.
    const setup = page.getByRole('radio', {name: 'Setup', exact: true})
    await expect(setup).toBeVisible()
    await expect(page.getByRole('heading', {name: 'Starting sessions'})).toBeHidden()
    await setup.click()
    await expect(page).toHaveURL(/\/sessions\?tab=setup$/)
    for (const name of ['Starting sessions', 'What sessions hear', 'Presets'])
        await expect(page.getByRole('heading', {name, exact: true})).toBeVisible()
    // The launcher's install command comes first, in view without opening the guide, as each new repo needs it (ORR-473).
    await expect(page.locator('#starts pre').first()).toHaveText(/bootstrap\.mjs launcher --install$/)
    await page.getByRole('radio', {name: 'Sessions', exact: true}).click()
    await expect(page).toHaveURL(/\/sessions$/)
    await expect(page.getByRole('heading', {name: 'Presets', exact: true})).toBeHidden()
    // A link to a Setup section, as Start session's "Presets" link is, lands on Setup.
    await page.goto('/sessions#presets')
    await expect(page.getByRole('heading', {name: 'Presets', exact: true})).toBeVisible()
})

test('the Permissions tab shows what each kind of session may do, from the table the server enforces', async ({page}) => {
    await page.goto('/sessions')
    await page.getByRole('radio', {name: 'Permissions', exact: true}).click()
    await expect(page).toHaveURL(/\/sessions\?tab=permissions$/)
    for (const area of permissionAreas()) await expect(page.getByRole('heading', {name: area, exact: true, level: 2})).toBeVisible()
    const table = page.getByRole('table').first()
    for (const kind of Object.values(SESSION_KINDS)) await expect(table.getByRole('columnheader', {name: kind, exact: true})).toBeVisible()
    await expect(table).toContainText(PERMISSIONS.find(p => p.area === permissionAreas()[0])!.action)
})
