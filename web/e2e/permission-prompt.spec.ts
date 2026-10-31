import {expect, test} from '@playwright/test'
import {hold, makeProject, projectApi} from './support'

// A session at a permission prompt pops up on any page (ORR-489), with a fake launcher and channel on the API where
// Claude would be: one orrery started shows the command from its prompt, and Allow and Open tmux go to its launcher; one
// started by hand says what it wants without them; × hides it until it asks again. Either says the tool it asks for, as
// its hook said (ORR-562).

const api = projectApi('pantry')
const PANE = `● I'll clear the build output.

╭────────────────────────────────────────╮
│ Bash command                           │
│                                        │
│   rm -rf web/.output                   │
│                                        │
│ Do you want to proceed?                │
│ ❯ 1. Yes                               │
│   2. Yes, and don't ask again for rm   │
│   3. No (esc)                          │
╰────────────────────────────────────────╯`

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Pantry', key: 'PAN'})
})

test('a session orrery started pops up with its prompt, and Allow and Open tmux go to its launcher', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/pantry/launches/stream')
    let stream: ReturnType<typeof hold> | undefined
    try {
        await expect.poll(async () => (await api(request, 'get', '/launches')).launchers).toBe(1)
        await request.post('/api/projects/pantry/launches/running', {data: {launches: [{id: 'e2e489e2e489', tmux: 'orrery-e2e-allow'}]}})
        stream = hold(baseURL!, '/api/projects/pantry/signals/stream?session=e2e-p&name=pantry%20shelf&started=e2e489e2e489&format=text')
        await page.goto('/p/pantry')
        await request.post('/api/sessions', {data: {id: 'e2e-p', project: 'pantry', event: 'Notification', message: 'Claude needs your permission to use Bash'}})
        const popup = page.getByRole('alertdialog', {name: 'pantry shelf needs permission'})
        await expect(popup).toContainText('Claude needs your permission to use Bash')
        // The popup asks for the screen; the launcher sends it, and the command it asks to run shows, not the screen.
        await expect.poll(() => launcher.said.text).toContain('event: view')
        await expect.poll(async () => (await request.post('/api/projects/pantry/launches/e2e489e2e489/screen', {data: {screen: PANE}})).json()).toEqual({watching: true})
        await expect(popup.getByText('rm -rf web/.output', {exact: true})).toBeVisible()
        await expect(popup).not.toContainText("I'll clear the build output")
        await expect(popup).not.toContainText('Do you want to proceed?')
        // What Allow answers is the screen, so a hook's word for the session doesn't take its place (ORR-572).
        await request.post('/api/sessions', {data: {id: 'e2e-p', project: 'pantry', event: 'PermissionRequest', tool: {name: 'Read', detail: 'README.md'}}})
        await expect.poll(async () => (await (await request.get('/api/sessions')).json()).find((s: {id: string}) => s.id === 'e2e-p')?.asking?.detail).toBe('README.md')
        await expect(popup).not.toContainText('README.md')
        await expect(popup.locator('[data-asking]')).toHaveCount(0)
        await expect(popup.getByText('rm -rf web/.output', {exact: true})).toBeVisible()
        await popup.getByRole('button', {name: 'Open tmux'}).click()
        await expect.poll(() => launcher.said.text).toContain('event: watch')
        await popup.getByRole('button', {name: 'Deny'}).click()
        await expect.poll(() => launcher.said.text).toContain('event: deny')
        await popup.getByRole('button', {name: 'Allow'}).click()
        await expect.poll(() => launcher.said.text).toContain('event: allow')
        // It carries on, and the popup goes.
        await request.post('/api/sessions', {data: {id: 'e2e-p', project: 'pantry', event: 'PreToolUse'}})
        await expect(popup).toBeHidden()
    } finally {
        stream?.stop()
        launcher.stop()
    }
})

test('one started by hand says what it wants without the buttons, and × hides it until it asks again', async ({page, request}) => {
    await page.goto('/schedules')
    const ask = () => request.post('/api/sessions', {data: {id: 'e2e-h', project: 'pantry', event: 'Notification', name: 'by hand', message: 'Claude needs your permission to use Edit'}})
    await ask()
    const popup = page.getByRole('alertdialog', {name: 'by hand needs permission'})
    await expect(popup).toContainText('Claude needs your permission to use Edit')
    await expect(popup).toContainText('Started in a terminal: answer it there.')
    await expect(popup.getByRole('button', {name: 'Allow'})).toHaveCount(0)
    // No channel, so no card for its name to link to (ORR-716).
    await expect(popup.getByRole('link', {name: 'by hand'})).toHaveCount(0)
    await popup.getByRole('button', {name: 'Hide until it asks again'}).click()
    await expect(popup).toBeHidden()
    await request.post('/api/sessions', {data: {id: 'e2e-h', project: 'pantry', event: 'PreToolUse'}})
    await ask()
    await expect(popup).toBeVisible()
    await request.post('/api/sessions', {data: {id: 'e2e-h', project: 'pantry', event: 'SessionEnd'}})
})

test('says the tool it asks for and what it would do, on the popup and its card', async ({page, request, baseURL}) => {
    const said = (data: Record<string, unknown>) => request.post('/api/sessions', {data: {id: 'e2e-t', project: 'pantry', name: 'tool user', ...data}})
    await page.goto('/sessions')
    await said({event: 'SessionStart'})
    const channel = hold(baseURL!, '/api/projects/pantry/signals/stream?session=e2e-t&name=tool%20user&format=text')
    await said({event: 'PreToolUse', tool: {name: 'Bash', detail: 'git push --force origin main'}})
    await said({event: 'Notification', message: 'Claude needs your permission'})
    const popup = page.getByRole('alertdialog', {name: 'tool user needs permission'})
    await expect(popup.locator('[data-asking]')).toContainText('Bash')
    await expect(popup.getByText('git push --force origin main', {exact: true})).toBeVisible()
    await expect(page.locator('#session-e2e-t')).toContainText('for Bash')
    // The dialog's own word wins, an MCP tool by its server and name.
    await said({event: 'PermissionRequest', tool: {name: 'mcp__orrery__comment'}})
    await expect(popup.locator('[data-asking]')).toHaveText('orrery · comment')
    await said({event: 'PreToolUse', tool: {name: 'mcp__orrery__comment'}})
    await expect(popup).toBeHidden()
    channel.stop()
    await said({event: 'SessionEnd'})
})
