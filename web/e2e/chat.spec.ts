import {expect, test} from '@playwright/test'
import {OWNER, hold, makeProject} from './support'

// The owner's chat, with a fake launcher and a fake chat session on the API where Claude would be: the Chat button
// starts one with starts turned off (a chat counts towards nothing), the owner's words reach its session alone, its
// answer shows in the pane, it isn't listed on the Sessions page, and End chat stops it.
test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Pantry', key: 'PAN'})
    // Orrery isn't let start sessions: a chat needs only the launcher.
    const off = await request.patch('/api/settings', {data: {starts: null}, headers: OWNER})
    expect(off.ok(), await off.text()).toBeTruthy()
})

test('chats with a session that answers on the page, and is listed nowhere', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/pantry/launches/stream')
    let session: ReturnType<typeof hold> | undefined
    try {
        await expect.poll(async () => (await (await request.get('/api/projects/pantry/launches')).json()).launchers).toBe(1)
        await page.goto('/p/pantry')
        await page.getByRole('button', {name: 'Chat', exact: true}).click()
        const pane = page.getByRole('region', {name: 'Chat'})
        await pane.getByRole('button', {name: 'Chat about Pantry'}).click()
        await expect.poll(() => launcher.said.text).toContain('"chat":true')
        const [chat] = await (await request.get('/api/chats')).json()
        session = hold(baseURL!, `/api/projects/pantry/signals/stream?session=e2e-chat&name=e2e-chat&started=${chat.id}&chat=yes&format=text`)
        await expect(pane).toContainText('Ready')

        await pane.getByLabel('Message').fill('What is on the top shelf?')
        await pane.getByLabel('Message').press('Enter')
        await expect.poll(() => session!.said.text).toContain('What is on the top shelf?')
        // It takes the message up, as its hooks say.
        await request.post('/api/sessions', {data: {id: 'e2e-chat', project: 'pantry', event: 'UserPromptSubmit'}})
        await expect(pane).toContainText('Thinking…')
        // Its answer comes back through its channel's reply tool.
        const answered = await request.post(`/api/chats/${chat.id}/replies`, {
            data: {text: 'Jars of **jam**.'},
            headers: {'Orrery-Actor': 'claude', 'Orrery-Chat': 'yes', 'Orrery-Launch': chat.id},
        })
        expect(answered.ok(), await answered.text()).toBeTruthy()
        await expect(pane.locator('strong', {hasText: 'jam'})).toBeVisible()
        // Anything but making issues, commenting and answering is refused.
        const moved = await request.post('/api/projects/pantry/issues/PAN-1/focus', {data: {}, headers: {'Orrery-Actor': 'claude', 'Orrery-Chat': 'yes'}})
        expect(moved.status()).toBe(403)

        // It isn't one of the sessions: not listed, and nothing for the limit.
        await pane.getByRole('button', {name: 'Close the chat; it keeps running'}).click()
        await page.goto('/sessions')
        await expect(page.getByRole('heading', {name: 'Sessions'}).first()).toBeVisible()
        await expect(page.locator('#session-e2e-chat')).toHaveCount(0)
        expect((await (await request.get('/api/projects/pantry/launches')).json()).total).toBe(0)

        // With a chat running, the button says so.
        await page.getByRole('button', {name: 'Chat A chat is running'}).click()
        await expect(pane).toContainText('Jars of')
        await pane.getByRole('button', {name: 'End chat'}).click()
        await expect.poll(() => launcher.said.text).toContain('event: stop')
        await expect(pane).toContainText('This chat has ended.')
        expect(await (await request.get('/api/chats', {headers: OWNER})).json()).toEqual([])
    } finally {
        session?.stop()
        launcher.stop()
    }
})
