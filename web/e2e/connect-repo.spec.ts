import {expect, test} from '@playwright/test'
import {OWNER, hold, makeProject} from './support'

// Connect a repo with a click (ORR-708), on the page: with no launcher that can open a picker, the install line; with one
// (a stand-in holding its stream), the owner's click asks it, it says the folder's name, the page ticks projects, and it
// hears them. The folder itself is never in anything orrery sends or shows.

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Lighthouse', key: 'LHT'})
    await makeProject(request, {name: 'Foghorn', key: 'FGH'})
})

test('shows the install line with no launcher that can do it', async ({page}) => {
    await page.goto('/connect')
    const card = page.getByTestId('connect-repo')
    await expect(card.getByText('First, on this machine: install the launcher')).toBeVisible()
    await expect(card.getByRole('button', {name: 'Connect a repo'})).toHaveCount(0)
    // The other way in stays.
    await expect(page.getByText('Paste this into a session in the repo')).toBeVisible()
})

test('asks a launcher to pick a folder, ticks its projects, and sends them to it', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/connects/stream?host=lamp-room')
    await expect.poll(() => launcher.said.text).toContain('event: ready')
    const token = JSON.parse(/event: ready\ndata: (.+)\n/.exec(launcher.said.text)![1]!).token as string
    const report = (id: string, data: object) => request.post(`/api/connects/${id}/report`, {data, headers: {'Orrery-Launcher': token}})
    try {
        await page.goto('/connect')
        const card = page.getByTestId('connect-repo')
        await card.getByRole('button', {name: 'Connect a repo'}).click()
        await expect.poll(() => launcher.said.text).toContain('event: pick')
        const id = JSON.parse(/event: pick\ndata: (.+)\n/.exec(launcher.said.text)![1]!).id as string
        await expect(card.getByText('Asking your launcher')).toBeVisible()

        expect((await (await report(id, {state: 'picking'})).json()).claimed).toBe(true)
        await expect(card.getByText('in the picker on lamp-room')).toBeVisible()

        await report(id, {state: 'picked', folder: 'lighthouse', projects: ['foghorn']})
        await expect(card.getByRole('heading', {name: /lighthouse/})).toBeVisible()
        await expect(card.getByRole('checkbox', {name: /Foghorn.*already connected/})).toBeDisabled()
        await expect(card.getByRole('checkbox', {name: /Foghorn/})).toBeChecked()
        await card.getByRole('checkbox', {name: /Lighthouse/}).check()
        await card.getByRole('textbox', {name: "A new project's name"}).fill('Beacon')
        await card.getByRole('button', {name: 'Make it'}).click()
        await expect(card.getByRole('checkbox', {name: /Beacon/})).toBeChecked()
        await card.getByRole('button', {name: 'Set it up'}).click()

        await expect.poll(() => launcher.said.text).toContain('event: write')
        const write = JSON.parse(/event: write\ndata: (.+)\n/.exec(launcher.said.text)![1]!)
        expect(write.projects.map((p: {id: string}) => p.id).sort()).toEqual(['beacon', 'foghorn', 'lighthouse'])
        expect(write.token).toBeUndefined()
        expect(write.dir).toBeUndefined()

        await report(id, {state: 'done', written: ['.mcp.json', 'CLAUDE.md'], unchanged: ['.claude/settings.json'], opened: true})
        await expect(card.getByRole('heading', {name: /lighthouse is connected/})).toBeVisible()
        await expect(card.getByText('Wrote .mcp.json, CLAUDE.md')).toBeVisible()
        await expect(card.getByText('Claude is open in a terminal')).toBeVisible()
    } finally {
        launcher.stop()
    }
})

test('says so when the picker is cancelled, and refuses an agent', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/connects/stream?host=lamp-room')
    await expect.poll(() => launcher.said.text).toContain('event: ready')
    const token = JSON.parse(/event: ready\ndata: (.+)\n/.exec(launcher.said.text)![1]!).token as string
    try {
        expect((await request.post('/api/connects', {data: {}, headers: {'Orrery-Actor': 'claude'}})).status()).toBe(403)
        const made = await (await request.post('/api/connects', {data: {}, headers: OWNER})).json()
        // It takes no folder, so nothing can name one.
        expect(made.folder).toBeUndefined()
        await page.goto('/connect')
        const card = page.getByTestId('connect-repo')
        await request.post(`/api/connects/${made.id}/report`, {data: {state: 'picking'}, headers: {'Orrery-Launcher': token}})
        await expect(card.getByText('in the picker on lamp-room')).toBeVisible()
        await request.post(`/api/connects/${made.id}/report`, {data: {state: 'canceled'}, headers: {'Orrery-Launcher': token}})
        await expect(card.getByText('Nothing was written')).toBeVisible()
        await expect(card.getByRole('button', {name: 'Connect a repo'})).toBeVisible()
    } finally {
        launcher.stop()
    }
})

test('the MCP server tab lists the tools, who gets each, what asks first and the environment', async ({page}) => {
    await page.goto('/connect')
    await page.getByRole('radio', {name: 'MCP server'}).click()
    await expect(page).toHaveURL(/\/connect\?tab=mcp$/)
    const row = (name: string) => page.locator(`[data-tool="${name}"]`)
    await expect(row('start_issue')).toContainText('Starts an issue')
    await expect(row('egress').getByRole('cell').nth(1)).toHaveText('On request')
    await expect(row('reply').getByRole('cell').nth(2)).toHaveText('Yes')
    await expect(page.getByRole('region', {name: 'What asks you first'})).toContainText('start_session')
    await expect(page.getByRole('region', {name: 'Environment'})).toContainText('ORRERY_HEAR')

    await page.reload()
    await expect(row('start_issue')).toBeVisible()
    await page.getByRole('radio', {name: 'Connect', exact: true}).click()
    await expect(page.getByRole('heading', {name: 'Give a session its roadmap'})).toBeVisible()
})
