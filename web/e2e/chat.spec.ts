import {expect, test} from '@playwright/test'
import {OWNER, hold, makeProject} from './support'

// The owner's chat, with a fake launcher and a fake chat session on the API where Claude would be: the Chat button
// starts one with starts turned off (a chat counts towards nothing), the owner's words reach its session alone, its
// answer shows in the pane, it isn't listed on the Sessions page, and closing the pane ends it.
let starts: unknown = null

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Larder', key: 'LAR'})
    // orrery isn't let start sessions: a chat needs only the launcher. The files after this one get it back as it was.
    starts = (await (await request.get('/api/settings')).json()).starts ?? null
    const off = await request.patch('/api/settings', {data: {starts: null}, headers: OWNER})
    expect(off.ok(), await off.text()).toBeTruthy()
})

test.afterAll(async ({request}) => {
    await request.patch('/api/settings', {data: {starts}, headers: OWNER})
})

test('chats with a session that answers on the page, and is listed nowhere', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/larder/launches/stream')
    let session: ReturnType<typeof hold> | undefined
    try {
        await expect.poll(async () => (await (await request.get('/api/projects/larder/launches')).json()).launchers).toBe(1)
        await page.goto('/p/larder')
        await page.getByRole('button', {name: 'Chat', exact: true}).click()
        const pane = page.getByRole('region', {name: 'Chat'})
        await pane.getByRole('button', {name: 'Chat about Larder'}).click()
        await expect.poll(() => launcher.said.text).toContain('"chat":true')
        const [chat] = await (await request.get('/api/chats')).json()
        session = hold(baseURL!, `/api/projects/larder/signals/stream?session=e2e-chat&name=e2e-chat&started=${chat.id}&chat=yes&format=text`)
        await expect(pane).toContainText('Ready')

        await pane.getByLabel('Message').fill('What is on the top shelf?')
        await pane.getByLabel('Message').press('Enter')
        await expect.poll(() => session!.said.text).toContain('What is on the top shelf?')
        // With the page the owner is on, so it knows what "this" is.
        expect(session.said.text).toContain('(The owner is on /p/larder')
        // It takes the message up, as its hooks say.
        await request.post('/api/sessions', {data: {id: 'e2e-chat', project: 'larder', event: 'UserPromptSubmit'}})
        await expect(pane).toContainText('Thinking…')
        // Its answer comes back through its channel's reply tool.
        const answered = await request.post(`/api/chats/${chat.id}/replies`, {
            data: {text: 'Jars of **jam**.'},
            headers: {'Orrery-Actor': 'claude', 'Orrery-Chat': 'yes', 'Orrery-Launch': chat.id},
        })
        expect(answered.ok(), await answered.text()).toBeTruthy()
        await expect(pane.locator('strong', {hasText: 'jam'})).toBeVisible()
        // Anything but making issues, commenting and answering is refused.
        const moved = await request.post('/api/projects/larder/issues/LAR-1/focus', {data: {}, headers: {'Orrery-Actor': 'claude', 'Orrery-Chat': 'yes'}})
        expect(moved.status()).toBe(403)

        // It isn't one of the sessions: not listed, and nothing for the limit. Leaving the page leaves it running.
        await page.goto('/sessions')
        await expect(page.getByRole('heading', {name: 'Sessions'}).first()).toBeVisible()
        await expect(page.locator('#session-e2e-chat')).toHaveCount(0)
        expect((await (await request.get('/api/projects/larder/launches')).json()).total).toBe(0)

        // With a chat running, the button says so.
        await page.getByRole('button', {name: 'Chat A chat is running'}).click()
        await expect(pane).toContainText('Jars of')
        // It can be made larger, and back.
        const narrow = (await pane.boundingBox())!.width
        await pane.getByRole('button', {name: 'Make the chat larger'}).click()
        await expect.poll(async () => (await pane.boundingBox())!.width).toBeGreaterThan(narrow)
        await pane.getByRole('button', {name: 'Make the chat smaller'}).click()
        // Closing the pane ends the chat, and it opens again ready for another.
        await pane.getByRole('button', {name: 'End the chat and close it'}).click()
        await expect.poll(() => launcher.said.text).toContain('event: stop')
        await expect.poll(async () => (await request.get('/api/chats', {headers: OWNER})).json()).toEqual([])
        await page.getByRole('button', {name: 'Chat', exact: true}).click()
        await expect(pane.getByRole('button', {name: /^Chat about/})).toBeVisible()
    } finally {
        session?.stop()
        launcher.stop()
    }
})
