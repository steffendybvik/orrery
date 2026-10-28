import {expect, test} from '@playwright/test'
import {OWNER, hold, makeProject} from './support'

// The owner's chat, with a fake launcher and a fake chat session on the API where Claude would be: the Chat button
// starts one with starts turned off (a chat counts towards nothing), the owner's words reach its session alone, its
// answer shows in the pane, it isn't listed on the Sessions page, and closing the pane ends it. It messages other
// sessions as the owner, when they ask, marked as sent through it.
let starts: unknown = null

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Larder', key: 'LAR'})
    // Orrery isn't let start sessions: a chat needs only the launcher. The files after this one get it back as it was.
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

test("messages other sessions for the owner: idle ones by default, marked as through the chat", async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/larder/launches/stream')
    const streams: ReturnType<typeof hold>[] = []
    try {
        await expect.poll(async () => (await (await request.get('/api/projects/larder/launches')).json()).launchers).toBe(1)
        const opened = await request.post('/api/chats', {data: {project: 'larder'}, headers: OWNER})
        expect(opened.ok(), await opened.text()).toBeTruthy()
        const chat = await opened.json()
        streams.push(hold(baseURL!, `/api/projects/larder/signals/stream?session=e2e-chat2&name=e2e-chat2&started=${chat.id}&chat=yes&format=text`))
        const idle = hold(baseURL!, '/api/projects/larder/signals/stream?session=e2e-idle&name=e2e-idle&format=text')
        const busy = hold(baseURL!, '/api/projects/larder/signals/stream?session=e2e-busy&name=e2e-busy&format=text')
        streams.push(idle, busy)
        await request.post('/api/sessions', {data: {id: 'e2e-idle', project: 'larder', event: 'Stop'}})
        await request.post('/api/sessions', {data: {id: 'e2e-busy', project: 'larder', event: 'UserPromptSubmit'}})
        // Both connected and in their states before the nudge, or it finds nobody listening yet.
        await expect.poll(async () => (await (await request.get('/api/sessions')).json())
            .filter((s: {id: string, listening: boolean}) => s.id.startsWith('e2e-') && s.listening && s.id !== 'e2e-chat2')
            .map((s: {id: string, state: string}) => `${s.id} ${s.state}`).sort()).toEqual(['e2e-busy working', 'e2e-idle idle'])
        const asChat = {'Orrery-Actor': 'claude', 'Orrery-Session': 'e2e-chat2', 'Orrery-Chat': 'yes', 'Orrery-Launch': chat.id}

        const nudged = await request.post('/api/sessions/message', {data: {text: 'Pick up Todo.', projects: ['larder']}, headers: asChat})
        expect(nudged.status(), await nudged.text()).toBe(201)
        const {sent} = await nudged.json()
        expect(sent.map((s: {session: string}) => s.session)).toEqual(['e2e-idle'])
        expect(sent[0].signal).toMatchObject({created_by: expect.any(String), protected: true, via: 'chat'})
        await expect.poll(() => idle.said.text).toContain('Pick up Todo.')
        expect(idle.said.text).toContain('(Sent by the owner through their chat.)')
        expect(busy.said.text).not.toContain('Pick up Todo.')

        // One session by itself, busy or not; never a chat, and only from a chat that's running.
        const one = await request.post('/api/projects/larder/sessions/e2e-busy/message', {data: {text: 'Wrap up first.'}, headers: asChat})
        expect(one.status(), await one.text()).toBe(201)
        await expect.poll(() => busy.said.text).toContain('Wrap up first.')
        expect((await request.post('/api/projects/larder/sessions/e2e-chat2/message', {data: {text: 'Hi'}, headers: asChat})).status()).toBe(404)
        expect((await request.post('/api/sessions/message', {data: {text: 'Hi'}, headers: {...asChat, 'Orrery-Launch': 'nope'}})).status()).toBe(403)

        // The Sessions page says it came through the chat.
        await page.goto('/sessions')
        await expect(page.locator('#session-e2e-busy')).toContainText('message via chat: Wrap up first.')
        await request.post(`/api/chats/${chat.id}/end`, {headers: OWNER})
    } finally {
        for (const stream of streams) stream.stop()
        launcher.stop()
    }
})
