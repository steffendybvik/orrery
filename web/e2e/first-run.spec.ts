import {expect, test} from '@playwright/test'
import {projectApi} from './support'

// A fresh orrery opened for the first time: the owner names themselves, makes a project from the page, and My issues
// (home, with `/now` sent there), Getting started and Connect show what they should. The other spec files run after
// this one (the `first-run` project in playwright.config.ts), so they find the owner named Ada Lovelace.
test.describe.configure({mode: 'serial'})

const api = projectApi('greenhouse')

test('asks where to keep the data, then the owner\'s name, on first open', async ({page, request}) => {
    await page.goto('/')
    // On SQLite it asks where to keep the data first; on Postgres (set as it starts) it doesn't.
    const where = page.getByRole('dialog', {name: 'Where to keep its data'})
    if (!process.env.E2E_POSTGRES_URL) {
        await where.getByRole('button', {name: /Postgres/}).click()
        await expect(where.getByLabel('Postgres URL')).toBeVisible()
        await where.getByRole('button', {name: 'Back'}).click()
        await where.getByRole('button', {name: /On this machine/}).click()
    }
    await expect(where).toBeHidden()
    const dialog = page.getByRole('dialog', {name: 'Your name'})
    await dialog.getByLabel('Your name').fill('Ada Lovelace')
    await dialog.getByRole('button').last().click()
    await expect(dialog).toBeHidden()
    expect(await (await request.get('/api/owner')).json()).toMatchObject({name: 'ada_lovelace', named: true})
    // A new orrery opens on Getting started: the owner's step ticked, a project the one to do.
    await expect(page.getByRole('heading', {name: 'Getting started'})).toBeVisible()
    await expect(page.getByRole('progressbar', {name: 'Steps done'})).toHaveAttribute('aria-valuenow', '1')
    await expect(page.getByRole('button', {name: 'Try it with a demo project'})).toBeVisible()
})

test('makes a project', async ({page}) => {
    await page.goto('/')
    await page.getByRole('button', {name: 'New project'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New project'})
    await dialog.getByLabel('Name').fill('Greenhouse')
    await dialog.getByRole('button', {name: /Create project/}).click()
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
    await page.getByRole('button', {name: 'Working with Claude after all?'}).click()
    await page.goto('/mine')
    await expect(card).toBeVisible()
    await page.goto('/connect?project=greenhouse')
    await expect(page.getByText(/Set this repo up for orrery: read .*\/connect\/greenhouse\.md/)).toBeVisible()
    await api(request, 'patch', `/issues/${urgent.id}`, {status: 'done'})
})
