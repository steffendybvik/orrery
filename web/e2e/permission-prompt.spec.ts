import {expect, test} from '@playwright/test'
import {hold, makeProject, projectApi} from './support'

// A session at a permission prompt pops up on any page (ORR-489), with a fake launcher and channel on the API where
// Claude would be: one orrery started shows the prompt from its pane, and Allow and Open tmux go to its launcher; one
// started by hand says what it wants without them; × hides it until it asks again.
test.describe.configure({mode: 'serial'})

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
        // The popup asks for the screen; the launcher sends it, and the prompt shows word for word.
        await expect.poll(() => launcher.said.text).toContain('event: view')
        await expect.poll(async () => (await request.post('/api/projects/pantry/launches/e2e489e2e489/screen', {data: {screen: PANE}})).json()).toEqual({watching: true})
        await expect(popup.locator('pre')).toContainText('rm -rf web/.output')
        await expect(popup.locator('pre')).not.toContainText("I'll clear the build output")
        await popup.getByRole('button', {name: 'Open tmux'}).click()
        await expect.poll(() => launcher.said.text).toContain('event: watch')
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
    await popup.getByRole('button', {name: 'Hide until it asks again'}).click()
    await expect(popup).toBeHidden()
    await request.post('/api/sessions', {data: {id: 'e2e-h', project: 'pantry', event: 'PreToolUse'}})
    await ask()
    await expect(popup).toBeVisible()
    await request.post('/api/sessions', {data: {id: 'e2e-h', project: 'pantry', event: 'SessionEnd'}})
})
