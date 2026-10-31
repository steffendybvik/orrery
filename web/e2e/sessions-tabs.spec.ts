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

test("a project's own template and instructions, shown in the preview, and back to the orrery's", async ({page, request}) => {
    const project = async () => (await request.get('/api/projects/tabs')).json()
    await page.goto('/sessions?tab=setup')
    const hear = page.locator('#hear')
    await hear.getByRole('button', {name: 'What sessions hear, for'}).click()
    await page.getByRole('option', {name: 'Tabs', exact: true}).click()

    // The template: its own, once saved, and the preview fills it in for a made-up issue.
    const focus = hear.locator('div').filter({has: page.getByRole('heading', {name: /^Focus on an issue/})}).first()
    await expect(focus).toContainText("the orrery's")
    await hear.getByRole('button', {name: 'Edit Focus on an issue'}).click()
    await hear.getByRole('textbox', {name: 'Focus on an issue'}).fill('Please look at {issue}')
    await hear.getByRole('button', {name: 'Done editing Focus on an issue'}).click()
    await expect.poll(async () => (await project()).focus_prompt).toBe('Please look at {issue}')
    await expect(focus).toContainText("Tabs's own")

    // A standing instruction: added, it goes in the preview; unticked, it doesn't; renamed, and removed.
    await hear.getByRole('textbox', {name: 'New instruction'}).fill('Commit when it works')
    await hear.getByRole('button', {name: 'Add', exact: true}).click()
    await expect.poll(async () => (await project()).instructions.map((i: {text: string}) => i.text)).toEqual(['Commit when it works'])
    await hear.getByRole('button', {name: 'Preview'}).first().click()
    const preview = hear.locator('pre')
    await expect(preview).toContainText('Please look at GRE-42')
    await expect(preview).toContainText('Commit when it works')

    await hear.getByRole('checkbox', {name: 'Tick “Commit when it works” by default'}).click()
    await expect(preview).not.toContainText('Commit when it works')
    expect((await project()).instructions[0].on).toBe(false)

    const line = hear.getByRole('textbox', {name: 'Instruction', exact: true})
    await line.fill('Commit each piece')
    await line.press('Enter')
    await expect.poll(async () => (await project()).instructions[0].text).toBe('Commit each piece')

    await hear.getByRole('button', {name: 'Remove “Commit each piece”'}).click()
    await expect.poll(async () => (await project()).instructions).toEqual([])

    // Reset: it follows the orrery's again.
    await hear.getByRole('button', {name: 'Edit Focus on an issue'}).click()
    await hear.getByRole('button', {name: "Reset to the orrery's"}).click()
    await expect.poll(async () => (await project()).focus_prompt).toBeFalsy()
    await expect(focus).toContainText("the orrery's")
    await expect(preview).not.toContainText('Please look at')
})
