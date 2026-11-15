import {expect, test} from './test'
import {OWNER, projectApi} from './support'

// A fresh orrery opened for the first time: the owner goes through the welcome, makes a project from the page, and My issues
// (home, with `/now` sent there), Getting started and Connect show what they should. The other spec files run after
// this one (the `first-run` project in playwright.config.ts), so they find the owner named Ada Lovelace.
test.describe.configure({mode: 'serial'})

const api = projectApi('greenhouse')

test('walks the owner through the welcome on first open, and asks nothing about the database', async ({page, request}) => {
    await page.goto('/')
    // Which database it runs on is set only as it starts (ORR-1187), so it never asks where to keep the data.
    await expect(page.getByRole('dialog', {name: 'Where to keep its data'})).toHaveCount(0)
    // The welcome (ORR-1194), a step a screen: the name, connecting an agent, and a first project. Naming the workspace
    // is its owner's step, so with login off, as here, where nobody is a member, it isn't one (WelcomeDialog.test.ts).
    const dialog = page.getByRole('dialog', {name: 'Welcome'})
    await expect(dialog.getByText('Step 1 of 3')).toBeVisible()
    await dialog.getByLabel('Your name').fill('Ada Lovelace')
    // Not a developer: Advanced goes off, and the pages for looking into problems leave the sidebar.
    await expect(dialog.getByRole('radio', {name: /Yes/})).toBeChecked()
    await dialog.getByRole('radio', {name: /No/}).check()
    await dialog.getByRole('button', {name: 'Continue'}).click()
    // Saved once Continue's request lands, which a busy machine takes a moment over.
    await expect.poll(async () => (await request.get('/api/owner')).json()).toMatchObject({name: 'ada_lovelace', named: true})
    // The agent's install line, waiting for this computer until it connects, and skippable.
    await expect(dialog.getByText('Step 2 of 3')).toBeVisible()
    await expect(dialog.getByText(/launcher --install/)).toBeVisible()
    await expect(dialog.getByText('Waiting for this computer')).toBeVisible()
    await dialog.getByRole('button', {name: 'Continue without it'}).click()
    // A first project or the demo; left for now, as the next test makes one from the page.
    await expect(dialog.getByText('Step 3 of 3')).toBeVisible()
    await expect(dialog.getByRole('button', {name: 'Try a demo project instead'})).toBeVisible()
    await dialog.getByRole('button', {name: 'Skip for now'}).click()
    await expect(dialog).toBeHidden()
    // Once done it doesn't come back.
    await page.reload()
    await expect(page.getByRole('heading', {name: 'Getting started'})).toBeVisible()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).advanced).toBe(false)
    await expect(page.getByRole('link', {name: 'Events'})).toBeHidden()
    // The other spec files expect Advanced on, as it starts.
    await request.patch('/api/settings', {data: {advanced: true}, headers: OWNER})
    // A new orrery opens on Getting started: the owner's step ticked, a project the one to do.
    await expect(page.getByRole('heading', {name: 'Getting started'})).toBeVisible()
    await expect(page.getByRole('progressbar', {name: 'Steps done'})).toHaveAttribute('aria-valuenow', '1')
    await expect(page.getByRole('button', {name: 'Try it with a demo project'})).toBeVisible()
    // And the one line that sets the machine up, from any folder, while no launcher is connected (ORR-1067).
    const machine = page.locator('[data-step="machine"]')
    await expect(machine.getByText('Set up this machine once')).toBeVisible()
    await expect(machine.getByText(/launcher --install/)).toBeVisible()
    // It asks which AI agent you run, Claude Code unless you pick another (ORR-1075): another gets the route with no
    // adapter in place of the install line, and Connect an agent follows; Claude Code is put back for the specs after.
    const picker = page.locator('[data-step="agent"]')
    await expect(picker.getByRole('radio', {name: 'Claude Code'})).toBeChecked()
    await picker.getByRole('radio', {name: 'Another agent'}).click()
    await expect(page.locator('[data-other-agent]').getByText(/bootstrap\.mjs channel/)).toBeVisible()
    await expect(machine).toBeHidden()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).agent).toBe('other')
    await page.goto('/connect')
    await expect(page.locator('[data-other-agent]')).toBeVisible()
    await expect(page.getByRole('heading', {name: 'Connect a repo'})).toBeHidden()
    await page.goto('/settings#agent')
    await page.locator('#agent').getByRole('radio', {name: 'Claude Code'}).click()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).agent).toBe('claude')
    await page.goto('/connect')
    await expect(page.locator('[data-other-agent]')).toBeHidden()
})

test('picks the welcome up in another browser, and makes a project from it', async ({page, request}) => {
    // Skipped in one browser, it's left in that one only: here it picks up again, at the steps not done. Named, the
    // owner now owns the workspace, so naming it is one of them, offered as Personal.
    await page.goto('/')
    const dialog = page.getByRole('dialog', {name: 'Welcome'})
    await expect(dialog.getByRole('heading', {name: 'Name your workspace'})).toBeVisible()
    await expect(dialog.getByLabel('Workspace name')).toHaveValue('Personal')
    await dialog.getByRole('button', {name: 'Skip', exact: true}).click()
    expect((await (await request.get('/api/workspaces')).json())[0].name).toBe('Default')
    await dialog.getByRole('button', {name: 'Continue without it'}).click()
    await dialog.getByLabel('Project name').fill('Greenhouse')
    await dialog.getByRole('button', {name: 'Make it'}).click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/p\/greenhouse/)
    await expect(page.getByRole('heading', {name: 'Greenhouse'})).toBeVisible()
})

test('My issues and Connect show what they should', async ({page, request}) => {
    const urgent = await api(request, 'post', '/issues', {title: 'The shelf fell down', status: 'todo', priority: 'P0'})
    // Now is gone (ORR-425): its old address lands on My issues.
    await page.goto('/now')
    await expect(page).toHaveURL('/mine')
    await expect(page.getByText('The shelf fell down')).toBeVisible()
    // Getting started is a card on My issues until it's done; someone only planning is set without the steps for Claude.
    const card = page.getByRole('region', {name: 'Getting started'})
    await page.goto('/mine')
    await expect(card.getByText('Connect a folder', {exact: true})).toBeVisible()
    await card.getByRole('button', {name: "Just planning? You're set"}).click()
    await expect(card).toBeHidden()
    await page.goto('/getting-started')
    await page.getByRole('button', {name: 'Working with agents after all?'}).click()
    await page.goto('/mine')
    await expect(card).toBeVisible()
    await page.goto('/connect?project=greenhouse')
    await expect(page.getByText(/Set this repo up for orrery: read .*\/connect\/greenhouse\.md/)).toBeVisible()
    await api(request, 'patch', `/issues/${urgent.id}`, {status: 'done'})
})
