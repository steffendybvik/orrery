import {type APIRequestContext, expect, test} from '@playwright/test'
import {OWNER, hold, makeProject} from './support'

// The owner's chat, with a fake launcher and a fake chat session on the API where Claude would be: the first message
// in the pane starts one with starts turned off (a chat counts towards nothing), the owner's words reach its session
// alone, its answer shows in the pane, it isn't listed on the Sessions page, minimizing the pane leaves it running, and
// closing the pane ends it. It asks the owner before messaging other sessions (sent as theirs, marked as through it,
// on their Send) or changing a setting.
let starts: unknown = null

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Larder', key: 'LAR'})
    // orrery isn't let start sessions: a chat needs only the launcher. The files after this one get it back as it was.
    starts = (await (await request.get('/api/settings')).json()).starts ?? null
    const off = await request.patch('/api/settings', {data: {starts: null}, headers: OWNER})
    expect(off.ok(), await off.text()).toBeTruthy()
})

/** Ends every chat still running, so the next starts alone. */
async function endChats(request: APIRequestContext) {
    for (const {id} of await (await request.get('/api/chats')).json() as {id: string}[]) await request.post(`/api/chats/${id}/end`, {headers: OWNER})
}

test.afterAll(async ({request}) => {
    await request.patch('/api/settings', {data: {starts}, headers: OWNER})
})

test('takes an image dropped anywhere on the pane, showing where it can go, and goes back to the message', async ({page}) => {
    await page.goto('/p/larder')
    await page.getByRole('button', {name: 'Agent', exact: true}).click()
    const pane = page.getByRole('region', {name: 'Chat'})
    const drag = await page.evaluateHandle(() => {
        const transfer = new DataTransfer()
        const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))
        transfer.items.add(new File([png], 'jar.png', {type: 'image/png'}))
        return transfer
    })
    // Over the greeting, far from the message box.
    const greeting = pane.getByRole('heading', {name: 'Ask about Larder'})
    await greeting.dispatchEvent('dragenter', {dataTransfer: drag})
    await expect(pane.getByText('Drop image to add')).toBeVisible()
    await greeting.dispatchEvent('drop', {dataTransfer: drag})
    await expect(pane.getByText('Drop image to add')).toHaveCount(0)
    await expect(pane.getByRole('button', {name: 'Remove image 1'})).toBeVisible()
    await expect(pane.getByLabel('Message')).toBeFocused()
    await pane.getByRole('button', {name: 'Remove image 1'}).click()
    await pane.getByRole('button', {name: 'Close the chat'}).click()
})

test('chats with a session that answers on the page, and is listed nowhere', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/larder/launches/stream')
    let session: ReturnType<typeof hold> | undefined
    try {
        await expect.poll(async () => (await (await request.get('/api/projects/larder/launches')).json()).launchers).toBe(1)
        await page.goto('/p/larder')
        await page.getByRole('button', {name: 'Agent', exact: true}).click()
        const pane = page.getByRole('region', {name: 'Chat'})
        // It opens ready to type into, on the project you're on, with things to ask.
        await expect(pane.getByRole('heading', {name: 'Ask about Larder'})).toBeVisible()
        await pane.getByRole('button', {name: 'How do schedules work?'}).click()
        await expect(pane.getByLabel('Message')).toHaveValue('How do schedules work?')

        // The first message starts the chat, and reaches its session once it connects.
        await pane.getByLabel('Message').fill('What is on the top shelf?')
        await pane.getByLabel('Message').press('Enter')
        await expect.poll(() => launcher.said.text).toContain('"chat":true')
        await expect(pane).toContainText('Starting the session…')
        const [chat] = await (await request.get('/api/chats')).json()
        // As its launcher starts it: catching up from the launch's `after`, so what was said before it connected reaches it.
        const after = launcher.said.text.match(/"after":(\d+)/)![1]
        session = hold(baseURL!, `/api/projects/larder/signals/stream?session=e2e-chat&name=e2e-chat&started=${chat.id}&chat=yes&after=${after}&format=text`)
        await expect.poll(() => session!.said.text).toContain('What is on the top shelf?')
        // With the page the owner is on, so it knows what "this" is.
        expect(session.said.text).toContain('(The owner is on /p/larder')
        // It takes the message up, as its hooks say.
        await request.post('/api/sessions', {data: {id: 'e2e-chat', project: 'larder', event: 'UserPromptSubmit'}})
        await expect(pane.getByLabel('Thinking…')).toBeVisible()
        // Its answer comes back through its channel's reply tool.
        const answered = await request.post(`/api/chats/${chat.id}/replies`, {
            data: {text: 'Jars of **jam**.'},
            headers: {'Orrery-Actor': 'claude', 'Orrery-Chat': 'yes', 'Orrery-Launch': chat.id},
        })
        expect(answered.ok(), await answered.text()).toBeTruthy()
        await expect(pane.locator('strong', {hasText: 'jam'})).toBeVisible()
        // Answered partway through its turn, it's still working: the dots stay, after the reply, until the turn ends.
        await expect(pane.getByLabel('Thinking…')).toBeVisible()
        expect(await pane.locator('ol > li').last().getAttribute('aria-label')).toBe('Thinking…')
        await request.post('/api/sessions', {data: {id: 'e2e-chat', project: 'larder', event: 'Stop'}})
        await expect(pane.getByLabel('Thinking…')).toHaveCount(0)
        // Copy under the reply takes its Markdown as written, not the page's text.
        await page.evaluate(() => {
            const copied: string[] = (window as unknown as {copied: string[]}).copied = []
            navigator.clipboard.writeText = async text => { copied.push(text) }
        })
        await pane.getByText('Jars of').hover()
        await pane.getByRole('button', {name: 'Copy this reply'}).click()
        await expect(pane.getByRole('button', {name: 'Copy this reply'})).toHaveText('Copied')
        expect(await page.evaluate(() => (window as unknown as {copied: string[]}).copied)).toEqual(['Jars of **jam**.'])
        // Anything but making issues, commenting and answering is refused.
        const moved = await request.post('/api/projects/larder/issues/LAR-1/focus', {data: {}, headers: {'Orrery-Actor': 'claude', 'Orrery-Chat': 'yes'}})
        expect(moved.status()).toBe(403)
        // It changes an issue's fields when the owner asks, but never its state of work.
        const shelf = await (await request.post('/api/projects/larder/issues', {data: {title: 'Label the shelf'}, headers: OWNER})).json()
        const urgent = await request.patch(`/api/projects/larder/issues/${shelf.id}`, {data: {priority: 'P0'}, headers: {'Orrery-Actor': 'claude', 'Orrery-Chat': 'yes', 'Orrery-Launch': chat.id}})
        expect(urgent.ok(), await urgent.text()).toBeTruthy()
        expect((await urgent.json()).priority).toBe('P0')
        const finished = await request.patch(`/api/projects/larder/issues/${shelf.id}`, {data: {status: 'done'}, headers: {'Orrery-Actor': 'claude', 'Orrery-Chat': 'yes', 'Orrery-Launch': chat.id}})
        expect(finished.status()).toBe(403)

        // It isn't one of the sessions: not listed, and nothing for the limit. Leaving the page leaves it running.
        await page.goto('/sessions')
        await expect(page.getByRole('heading', {name: 'Sessions'}).first()).toBeVisible()
        await expect(page.locator('#session-e2e-chat')).toHaveCount(0)
        expect((await (await request.get('/api/projects/larder/launches')).json()).total).toBe(0)

        // With a chat running, the button says so.
        await page.getByRole('button', {name: 'Agent (a chat is running)'}).click()
        await expect(pane).toContainText('Jars of')
        // It can be made larger, and back.
        const narrow = (await pane.boundingBox())!.width
        await pane.getByRole('button', {name: 'Make the chat larger'}).click()
        await expect.poll(async () => (await pane.boundingBox())!.width).toBeGreaterThan(narrow)
        await pane.getByRole('button', {name: 'Make the chat smaller'}).click()
        // Minimizing it, by its button or Esc, hides the pane and leaves the chat running, conversation and all.
        await pane.getByRole('button', {name: 'Minimize the chat, leaving it running'}).click()
        await expect(pane).toHaveCount(0)
        expect(await (await request.get('/api/chats', {headers: OWNER})).json()).toHaveLength(1)
        await page.getByRole('button', {name: 'Agent (a chat is running)'}).click()
        await expect(pane).toContainText('Jars of')
        await pane.getByLabel('Message').press('Escape')
        await expect(pane).toHaveCount(0)
        expect(launcher.said.text).not.toContain('event: stop')
        await page.getByRole('button', {name: 'Agent (a chat is running)'}).click()
        await expect(pane).toContainText('Jars of')
        // Closing the pane ends the chat, and it opens again ready for another.
        await pane.getByRole('button', {name: 'End the chat and close it'}).click()
        await expect.poll(() => launcher.said.text).toContain('event: stop')
        await expect.poll(async () => (await request.get('/api/chats', {headers: OWNER})).json()).toEqual([])
        await page.getByRole('button', {name: 'Agent', exact: true}).click()
        await expect(pane.getByRole('heading', {name: /^Ask about/})).toBeVisible()
    } finally {
        session?.stop()
        launcher.stop()
    }
})

test("asks before messaging other sessions, and sends only on the owner's Send, marked as through the chat", async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/larder/launches/stream')
    const streams: ReturnType<typeof hold>[] = []
    try {
        await expect.poll(async () => (await (await request.get('/api/projects/larder/launches')).json()).launchers).toBe(1)
        // The pane opens on the chat running, so this one alone.
        await endChats(request)
        const opened = await request.post('/api/chats', {data: {project: 'larder'}, headers: OWNER})
        expect(opened.ok(), await opened.text()).toBeTruthy()
        const chat = await opened.json()
        const own = hold(baseURL!, `/api/projects/larder/signals/stream?session=e2e-chat2&name=e2e-chat2&started=${chat.id}&chat=yes&format=text`)
        const idle = hold(baseURL!, '/api/projects/larder/signals/stream?session=e2e-idle&name=e2e-idle&format=text')
        const busy = hold(baseURL!, '/api/projects/larder/signals/stream?session=e2e-busy&name=e2e-busy&format=text')
        streams.push(own, idle, busy)
        // Both connected, then in their states, before the nudge: a state said before its stream connects can be lost.
        const listening = async () => (await (await request.get('/api/sessions')).json())
            .filter((s: {id: string, listening: boolean}) => ['e2e-idle', 'e2e-busy'].includes(s.id) && s.listening)
            .map((s: {id: string, state: string}) => `${s.id} ${s.state}`).sort()
        await expect.poll(async () => (await listening()).map(l => l.split(' ')[0])).toEqual(['e2e-busy', 'e2e-idle'])
        await request.post('/api/sessions', {data: {id: 'e2e-idle', project: 'larder', event: 'Stop'}})
        await request.post('/api/sessions', {data: {id: 'e2e-busy', project: 'larder', event: 'UserPromptSubmit'}})
        await expect.poll(listening).toEqual(['e2e-busy working', 'e2e-idle idle'])
        const asChat = {'Orrery-Actor': 'claude', 'Orrery-Session': 'e2e-chat2', 'Orrery-Chat': 'yes', 'Orrery-Launch': chat.id}
        const ask = async (message: object) => {
            const asked = await request.post(`/api/chats/${chat.id}/requests`, {data: {message}, headers: asChat})
            expect(asked.status(), await asked.text()).toBe(201)
            return (await asked.json()).send as {to: string[]}
        }

        // It can't message a session itself, by either route, whatever it says it is (ORR-416).
        expect((await request.post('/api/sessions/message', {data: {text: 'Hi'}, headers: asChat})).status()).toBe(403)
        expect((await request.post('/api/projects/larder/sessions/e2e-idle/message', {data: {text: 'Hi'}, headers: asChat})).status()).toBe(403)
        expect((await request.post('/api/sessions/message', {data: {text: 'Hi'}, headers: {...asChat, 'Orrery-Actor': OWNER['Orrery-Actor']}})).status()).toBe(403)

        await page.goto('/p/larder')
        await page.getByRole('button', {name: 'Agent (a chat is running)'}).click()
        const pane = page.getByRole('region', {name: 'Chat'})
        // Idle ones by default: shown with who it goes to, and sent only on Send.
        expect((await ask({text: 'Pick up Todo.', projects: ['larder']})).to).toEqual(['e2e-idle'])
        const nudge = pane.getByRole('group', {name: 'Send a message to e2e-idle'}).last()
        await expect(nudge).toContainText('Pick up Todo.')
        expect(idle.said.text).not.toContain('Pick up Todo.')
        await nudge.getByRole('button', {name: 'Send', exact: true}).click()
        await expect(nudge).toContainText('Sent to e2e-idle')
        await expect.poll(() => idle.said.text).toContain('Pick up Todo.')
        expect(idle.said.text).toContain('(Sent by the owner through their chat.)')
        expect(busy.said.text).not.toContain('Pick up Todo.')
        await expect.poll(() => own.said.text).toContain('I sent your message to e2e-idle')

        // One session by itself, busy or not; Don't send sends nothing; never a chat, and the chat can't send its own.
        expect((await ask({text: 'Wrap up first.', session: 'e2e-busy'})).to).toEqual(['e2e-busy'])
        const wrap = pane.getByRole('group', {name: 'Send a message to e2e-busy'}).last()
        await wrap.getByRole('button', {name: "Don't send"}).click()
        await expect(wrap).toContainText('Not sent')
        await expect.poll(() => own.said.text).toContain("I didn't send your message")
        expect(busy.said.text).not.toContain('Wrap up first.')
        expect((await request.post(`/api/chats/${chat.id}/requests`, {data: {message: {text: 'Hi', session: 'e2e-chat2'}}, headers: asChat})).status()).toBe(404)
        const again = await (await request.post(`/api/chats/${chat.id}/requests`, {data: {message: {text: 'Wrap up first.', session: 'e2e-busy'}}, headers: asChat})).json()
        expect((await request.post(`/api/chats/${chat.id}/requests/${again.id}`, {data: {allow: true}, headers: asChat})).status()).toBe(403)
        await pane.getByRole('group', {name: 'Send a message to e2e-busy'}).last().getByRole('button', {name: 'Send', exact: true}).click()
        await expect.poll(() => busy.said.text).toContain('Wrap up first.')

        // The Sessions page says it came through the chat.
        await page.goto('/sessions')
        await expect(page.locator('#session-e2e-busy')).toContainText('message via chat: Wrap up first.')
    } finally {
        await endChats(request)
        for (const stream of streams) stream.stop()
        launcher.stop()
    }
})

test('asks the owner to change a setting, and saves it only on their Allow', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/larder/launches/stream')
    let session: ReturnType<typeof hold> | undefined
    try {
        await expect.poll(async () => (await (await request.get('/api/projects/larder/launches')).json()).launchers).toBe(1)
        // The pane opens on the chat running, so this one alone.
        await endChats(request)
        const chat = await (await request.post('/api/chats', {data: {project: 'larder'}, headers: OWNER})).json()
        session = hold(baseURL!, `/api/projects/larder/signals/stream?session=e2e-chat3&name=e2e-chat3&started=${chat.id}&chat=yes&format=text`)
        const asChat = {'Orrery-Actor': 'claude', 'Orrery-Session': 'e2e-chat3', 'Orrery-Chat': 'yes', 'Orrery-Launch': chat.id}
        const tracker = async () => (await (await request.get('/api/settings')).json()).tracker
        const url = 'https://tracker.example.com/issue/{id}'
        const ask = async (value: unknown) => {
            const asked = await request.post(`/api/chats/${chat.id}/requests`, {data: {setting: 'tracker', value}, headers: asChat})
            expect(asked.status(), await asked.text()).toBe(201)
            return (await asked.json()).id as number
        }

        await page.goto('/p/larder')
        await page.getByRole('button', {name: 'Agent (a chat is running)'}).click()
        const pane = page.getByRole('region', {name: 'Chat'})
        // Denied: nothing saved, and its session hears so.
        await ask(url)
        const card = pane.getByRole('group', {name: 'Change Team tracker'}).last()
        await expect(card).toContainText(url)
        await card.getByRole('button', {name: 'Deny'}).click()
        await expect(card).toContainText('Denied')
        await expect.poll(() => session!.said.text).toContain('denied your request')
        expect(await tracker()).toBeNull()

        // The chat's session can't allow its own request.
        const own = await ask(url)
        expect((await request.post(`/api/chats/${chat.id}/requests/${own}`, {data: {allow: true}, headers: asChat})).status()).toBe(403)
        expect((await request.post(`/api/chats/${chat.id}/requests/${own}`, {data: {allow: true}, headers: {...OWNER, 'Orrery-Chat': 'yes'}})).status()).toBe(403)
        expect(await tracker()).toBeNull()
        // Settings, secrets and the database stay out of its reach.
        expect((await request.patch('/api/settings', {data: {tracker: url}, headers: asChat})).status()).toBe(403)
        expect((await request.post(`/api/chats/${chat.id}/requests`, {data: {setting: 'starts', value: null}, headers: asChat})).status()).toBe(400)

        // Allowed by the owner: saved.
        await pane.getByRole('group', {name: 'Change Team tracker'}).last().getByRole('button', {name: 'Allow'}).click()
        await expect.poll(tracker).toBe(url)
        await expect(pane.getByRole('group', {name: 'Change Team tracker'}).last()).toContainText('Allowed and saved')
        await expect.poll(() => session!.said.text).toContain('Team tracker is now')
    } finally {
        await endChats(request)
        await request.patch('/api/settings', {data: {tracker: null}, headers: OWNER})
        session?.stop()
        launcher.stop()
    }
})

test('asks the owner to make or pause a schedule, and saves it as theirs only on their Allow', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/larder/launches/stream')
    let session: ReturnType<typeof hold> | undefined
    const schedules = async () => (await (await request.get('/api/projects/larder/schedules')).json()) as {id: number, title: string, enabled: boolean, created_by: string}[]
    try {
        await expect.poll(async () => (await (await request.get('/api/projects/larder/launches')).json()).launchers).toBe(1)
        await endChats(request)
        const chat = await (await request.post('/api/chats', {data: {project: 'larder'}, headers: OWNER})).json()
        session = hold(baseURL!, `/api/projects/larder/signals/stream?session=e2e-chat-sched&name=e2e-chat-sched&started=${chat.id}&chat=yes&format=text`)
        const asChat = {'Orrery-Actor': 'claude', 'Orrery-Session': 'e2e-chat-sched', 'Orrery-Chat': 'yes', 'Orrery-Launch': chat.id}
        const ask = async (data: object) => {
            const asked = await request.post(`/api/chats/${chat.id}/requests`, {data, headers: asChat})
            expect(asked.status(), await asked.text()).toBe(201)
            return (await asked.json()).id as number
        }

        await page.goto('/p/larder')
        await page.getByRole('button', {name: 'Agent (a chat is running)'}).click()
        const pane = page.getByRole('region', {name: 'Chat'})
        // What Schedules would refuse, or the chat may not set, fails as it asks; it can't make one itself.
        expect((await request.post(`/api/chats/${chat.id}/requests`, {data: {schedule: {title: 'Bad', cron: 'often'}}, headers: asChat})).status()).toBe(400)
        expect((await request.post(`/api/chats/${chat.id}/requests`, {data: {schedule: {title: 'Outsiders', untrusted: true}}, headers: asChat})).status()).toBe(403)
        expect((await request.post('/api/projects/larder/schedules', {data: {title: 'Sneaky', cron: '0 9 * * 1'}, headers: asChat})).status()).toBe(403)

        // Allowed: made, as the owner's.
        await ask({schedule: {title: 'Stock check', kind: 'message', notes: 'Count the jars.', cron: '0 9 * * 1', timezone: 'UTC'}})
        const card = pane.getByRole('group', {name: 'Make schedule Stock check'})
        await expect(card).toContainText('0 9 * * 1')
        await expect(card).toContainText('Count the jars.')
        expect(await schedules()).toEqual([])
        await card.getByRole('button', {name: 'Allow'}).click()
        await expect(card).toContainText('Allowed and saved')
        await expect.poll(async () => (await schedules()).map(s => [s.title, s.enabled, s.created_by])).toEqual([['Stock check', true, OWNER['Orrery-Actor']]])
        await expect.poll(() => session!.said.text).toContain('("Stock check") is saved')

        // Pausing it, denied: nothing changes.
        const [made] = await schedules()
        await ask({id: made!.id, schedule: {enabled: false}})
        const pause = pane.getByRole('group', {name: 'Change schedule Stock check'}).last()
        await expect(pause).toContainText('Running')
        await pause.getByRole('button', {name: 'Deny'}).click()
        await expect(pause).toContainText('Denied')
        expect((await schedules())[0]!.enabled).toBe(true)
    } finally {
        await endChats(request)
        for (const s of await schedules()) await request.delete(`/api/projects/larder/schedules/${s.id}`, {headers: OWNER})
        session?.stop()
        launcher.stop()
    }
})

test('asks the owner to move or assign issues, and moves them as theirs only on their Allow', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/larder/launches/stream')
    let session: ReturnType<typeof hold> | undefined
    const made: string[] = []
    const issue = async (id: string) => (await (await request.get(`/api/projects/larder/issues/${id}`)).json()) as {column: string, assignee?: string}
    try {
        for (const title of ['Label the jars', 'Fix the shelf']) {
            const created = await request.post('/api/projects/larder/issues', {data: {title, status: 'todo'}, headers: OWNER})
            made.push((await created.json()).id)
        }
        await expect.poll(async () => (await (await request.get('/api/projects/larder/launches')).json()).launchers).toBe(1)
        await endChats(request)
        const chat = await (await request.post('/api/chats', {data: {project: 'larder'}, headers: OWNER})).json()
        session = hold(baseURL!, `/api/projects/larder/signals/stream?session=e2e-chat-move&name=e2e-chat-move&started=${chat.id}&chat=yes&format=text`)
        const asChat = {'Orrery-Actor': 'claude', 'Orrery-Session': 'e2e-chat-move', 'Orrery-Chat': 'yes', 'Orrery-Launch': chat.id}
        // It can't move one itself, only ask.
        expect((await request.patch(`/api/projects/larder/issues/${made[0]}`, {data: {status: 'done'}, headers: asChat})).status()).toBe(403)
        const asked = await request.post(`/api/chats/${chat.id}/requests`, {data: {move: {ids: made, status: 'done', assignee: 'owner'}, why: 'Both are done.'}, headers: asChat})
        expect(asked.status(), await asked.text()).toBe(201)

        await page.goto('/p/larder')
        await page.getByRole('button', {name: 'Agent (a chat is running)'}).click()
        const card = page.getByRole('region', {name: 'Chat'}).getByRole('group', {name: `Move ${made.join(', ')}`})
        await expect(card).toContainText('Label the jars')
        await expect(card).toContainText('Todo')
        await expect(card).toContainText('Done')
        expect((await issue(made[0]!)).column).toBe('todo')
        await card.getByRole('button', {name: 'Allow'}).click()
        await expect(card).toContainText('Allowed and saved')
        for (const id of made) await expect.poll(async () => [(await issue(id)).column, (await issue(id)).assignee]).toEqual(['done', OWNER['Orrery-Actor']])
        await expect.poll(() => session!.said.text).toContain('are now in done')
    } finally {
        await endChats(request)
        for (const id of made) await request.delete(`/api/projects/larder/issues/${id}`, {headers: OWNER})
        session?.stop()
        launcher.stop()
    }
})

test('asks the owner to add or ship a release, and saves it only on their Allow', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/larder/launches/stream')
    let session: ReturnType<typeof hold> | undefined
    const releases = async () => (await (await request.get('/api/projects/larder/releases')).json()) as {version: string, branch?: string, shipped_on?: string}[]
    try {
        await request.patch('/api/projects/larder', {data: {release_mode: 'own'}, headers: OWNER})
        await expect.poll(async () => (await (await request.get('/api/projects/larder/launches')).json()).launchers).toBe(1)
        await endChats(request)
        const chat = await (await request.post('/api/chats', {data: {project: 'larder'}, headers: OWNER})).json()
        session = hold(baseURL!, `/api/projects/larder/signals/stream?session=e2e-chat-rel&name=e2e-chat-rel&started=${chat.id}&chat=yes&format=text`)
        const asChat = {'Orrery-Actor': 'claude', 'Orrery-Session': 'e2e-chat-rel', 'Orrery-Chat': 'yes', 'Orrery-Launch': chat.id}
        const ask = async (data: object) => {
            const asked = await request.post(`/api/chats/${chat.id}/requests`, {data, headers: asChat})
            expect(asked.status(), await asked.text()).toBe(201)
        }

        await page.goto('/p/larder')
        await page.getByRole('button', {name: 'Agent (a chat is running)'}).click()
        const pane = page.getByRole('region', {name: 'Chat'})
        // What Releases would refuse fails as it asks; it can't make one itself.
        expect((await request.post(`/api/chats/${chat.id}/requests`, {data: {release: {version: 'one two'}}, headers: asChat})).status()).toBe(400)
        expect((await request.post('/api/projects/larder/releases', {data: {version: '0.1.0'}, headers: asChat})).status()).toBe(403)

        // Allowed: added.
        await ask({release: {version: '0.1.0', branch: 'v0.1.0'}})
        const card = pane.getByRole('group', {name: 'Add release 0.1.0'})
        await expect(card).toContainText('v0.1.0')
        expect(await releases()).toEqual([])
        await card.getByRole('button', {name: 'Allow'}).click()
        await expect(card).toContainText('Allowed and saved')
        await expect.poll(async () => (await releases()).map(r => [r.version, r.branch])).toEqual([['0.1.0', 'v0.1.0']])
        await expect.poll(() => session!.said.text).toContain('release 0.1.0 is added')

        // Shipping it, denied: nothing changes.
        await ask({version: '0.1.0', release: {shipped_on: '2026-10-29'}})
        const ship = pane.getByRole('group', {name: 'Change release 0.1.0'})
        await expect(ship).toContainText('Shipped on')
        await ship.getByRole('button', {name: 'Deny'}).click()
        await expect(ship).toContainText('Denied')
        expect((await releases())[0]!.shipped_on).toBeUndefined()
    } finally {
        await endChats(request)
        for (const r of await releases()) await request.delete(`/api/projects/larder/releases/${r.version}`, {headers: OWNER})
        await request.patch('/api/projects/larder', {data: {release_mode: 'none'}, headers: OWNER})
        session?.stop()
        launcher.stop()
    }
})

// Where the chat's issues land (ORR-408): the owner picks Todo or Backlog beside Send, before the chat starts or
// during it, and it's remembered for the next one. The server holds the chat to it, whatever status its session asks
// for, and the session can't change it.
test('lands the issues it makes in Todo or Backlog, as picked beside Send', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/larder/launches/stream')
    const chatSays = (chat: string) => ({'Orrery-Actor': 'claude', 'Orrery-Chat': 'yes', 'Orrery-Launch': chat})
    const statusOf = async (id: string) => (await (await request.get(`/api/projects/larder/issues/${id}`)).json()).status
    try {
        await expect.poll(async () => (await (await request.get('/api/projects/larder/launches')).json()).launchers).toBe(1)
        await page.goto('/p/larder')
        await page.getByRole('button', {name: 'Agent', exact: true}).click()
        const pane = page.getByRole('region', {name: 'Chat'})
        // Todo by default; Backlog picked before the first message, and kept through a reload.
        await pane.getByRole('button', {name: 'New issues → Todo'}).click()
        await page.getByRole('menuitem', {name: 'New issues → Backlog'}).click()
        await page.reload()
        await page.getByRole('button', {name: 'Agent', exact: true}).click()
        await expect(pane.getByRole('button', {name: 'New issues → Backlog'})).toBeVisible()

        await pane.getByLabel('Message').fill('File one for the jam jars')
        await pane.getByLabel('Message').press('Enter')
        await expect.poll(() => launcher.said.text).toContain('"chat":true')
        const [chat] = await (await request.get('/api/chats')).json()
        expect(chat.issues).toBe('backlog')
        const jars = await (await request.post('/api/projects/larder/issues', {data: {title: 'Jam jars', status: 'todo'}, headers: chatSays(chat.id)})).json()
        expect(await statusOf(jars.id)).toBe('backlog')

        // Switched to Todo while it runs: what it makes next lands there, whatever it asks for.
        await pane.getByRole('button', {name: 'New issues → Backlog'}).click()
        await page.getByRole('menuitem', {name: 'New issues → Todo'}).click()
        await expect.poll(async () => (await (await request.get('/api/chats')).json())[0].issues).toBe('todo')
        const lids = await (await request.post('/api/projects/larder/issues', {data: {title: 'Jar lids', status: 'in-progress'}, headers: chatSays(chat.id)})).json()
        expect(await statusOf(lids.id)).toBe('todo')

        // Its session can't pick for the owner.
        expect((await request.patch(`/api/chats/${chat.id}`, {data: {issues: 'backlog'}, headers: chatSays(chat.id)})).status()).toBe(403)
        await request.post(`/api/chats/${chat.id}/end`, {headers: OWNER})
    } finally {
        launcher.stop()
    }
})

// `/clear` in the chat (ORR-497): it doesn't reach the session as words. Its launcher types `/clear` into it, and the
// pane marks the cut, keeping what was said above it, greyed. Any other slash command goes as words.
test("clears its session's context on /clear, marking the cut and keeping what was said", async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/larder/launches/stream')
    let session: ReturnType<typeof hold> | undefined
    try {
        await expect.poll(async () => (await (await request.get('/api/projects/larder/launches')).json()).launchers).toBe(1)
        await endChats(request)
        await page.goto('/p/larder')
        await page.getByRole('button', {name: 'Agent', exact: true}).click()
        const pane = page.getByRole('region', {name: 'Chat'})
        await pane.getByLabel('Message').fill('What is in the cellar?')
        await pane.getByLabel('Message').press('Enter')
        await expect.poll(() => launcher.said.text).toContain('"chat":true')
        const [chat] = await (await request.get('/api/chats')).json()
        const after = launcher.said.text.match(/"after":(\d+)/)![1]
        session = hold(baseURL!, `/api/projects/larder/signals/stream?session=e2e-clear&name=e2e-clear&started=${chat.id}&chat=yes&after=${after}&format=text`)
        await expect.poll(() => session!.said.text).toContain('What is in the cellar?')

        await pane.getByLabel('Message').fill('/clear')
        await pane.getByLabel('Message').press('Enter')
        await expect.poll(() => launcher.said.text).toContain('event: clear')
        expect(launcher.said.text).toContain(`"id":"${chat.id}"`)
        await expect(pane.getByRole('separator', {name: 'Context cleared'})).toBeVisible()
        await expect(pane.getByLabel('Message')).toHaveValue('')
        // What was said stays, greyed; the chat runs on, and its session never heard "/clear" as words.
        await expect(pane.getByText('What is in the cellar?')).toBeVisible()
        await expect(pane.getByLabel('Thinking…')).toHaveCount(0)
        expect((await (await request.get(`/api/chats/${chat.id}`)).json()).messages.at(-1)).toMatchObject({cleared: true})

        await pane.getByLabel('Message').fill('/compact')
        await pane.getByLabel('Message').press('Enter')
        await expect.poll(() => session!.said.text).toContain('/compact')
        expect(session.said.text).not.toContain('/clear')
        await request.post(`/api/chats/${chat.id}/end`, {headers: OWNER})
    } finally {
        session?.stop()
        launcher.stop()
    }
})

// A run of messages (ORR-517): Enter holds each under the box, and they go together, as one, once the owner stops
// typing for a moment; ⌘/Ctrl-Enter sends at once, and ✕ takes one back.
test('holds a run of messages and sends them together, at once on ⌘-Enter', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/larder/launches/stream')
    let session: ReturnType<typeof hold> | undefined
    try {
        await expect.poll(async () => (await (await request.get('/api/projects/larder/launches')).json()).launchers).toBe(1)
        await endChats(request)
        await page.goto('/p/larder')
        await page.getByRole('button', {name: 'Agent', exact: true}).click()
        const pane = page.getByRole('region', {name: 'Chat'})
        const box = pane.getByLabel('Message')
        await box.fill('what about')
        await box.press('Enter')
        await box.fill('the jam')
        await box.press('Enter')
        // Held, they show at once as sent, with the thinking dots, and nothing about the wait (ORR-535).
        await expect(pane.getByText('what about', {exact: true})).toBeVisible()
        await expect(pane.getByText('the jam', {exact: true})).toBeVisible()
        await expect(pane.getByLabel('Thinking…')).toBeVisible()
        await expect(pane.getByText(/after you stop typing|Send now/)).toHaveCount(0)
        // Esc in the empty box takes the last one back before it goes: it's in the box again.
        await box.fill('oops')
        await box.press('Enter')
        await expect(pane.getByText('oops', {exact: true})).toBeVisible()
        await box.press('Escape')
        await expect(box).toHaveValue('oops')
        await expect(pane.getByText('oops', {exact: true})).toHaveCount(0)
        await box.fill('')

        // Once the owner stops typing, both go as one message, still shown as two.
        await expect.poll(() => launcher.said.text, {timeout: 8000}).toContain('"chat":true')
        const [chat] = await (await request.get('/api/chats')).json()
        const after = launcher.said.text.match(/"after":(\d+)/)![1]
        session = hold(baseURL!, `/api/projects/larder/signals/stream?session=e2e-run&name=e2e-run&started=${chat.id}&chat=yes&after=${after}&format=text`)
        // One message (the text stream puts it on one line).
        await expect.poll(() => session!.said.text).toContain('(to you): what about the jam (The owner is on')
        expect(session.said.text).not.toContain('oops')
        expect((await (await request.get(`/api/chats/${chat.id}`)).json()).messages[0]).toMatchObject({text: 'what about\n\nthe jam', parts: ['what about', 'the jam']})
        await expect(pane.getByText('what about', {exact: true})).toBeVisible()
        await expect(pane.getByText('the jam', {exact: true})).toBeVisible()

        // ⌘-Enter (Ctrl-Enter) sends at once, with no wait.
        await box.fill('and the honey?')
        const sent = Date.now()
        await box.press('ControlOrMeta+Enter')
        await expect.poll(() => session!.said.text).toContain('and the honey?')
        expect(Date.now() - sent).toBeLessThan(1500)
        await request.post(`/api/chats/${chat.id}/end`, {headers: OWNER})
    } finally {
        session?.stop()
        launcher.stop()
    }
})

// A run that can't go (ORR-530): no launcher, so the chat can't start. It's tried once, then says so (the only time
// holding shows, ORR-535) and waits for Retry, and a slash command waits behind it rather than going first.
test("holds a run that couldn't go until the owner tries again, and keeps a slash command behind it", async ({page, request, baseURL}) => {
    await endChats(request)
    await expect.poll(async () => (await (await request.get('/api/projects/larder/launches')).json()).launchers).toBe(0)
    const starts: string[] = []
    page.on('request', r => {
        if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/chats') starts.push(r.url())
    })
    await page.goto('/p/larder')
    await page.getByRole('button', {name: 'Agent', exact: true}).click()
    const pane = page.getByRole('region', {name: 'Chat'})
    const box = pane.getByLabel('Message')
    await box.fill('what about the jam')
    await box.press('Enter')
    await expect(pane.getByText('what about the jam', {exact: true})).toBeVisible()
    await expect(pane.getByText('Not sent')).toBeVisible({timeout: 5000})
    await expect(pane.getByLabel('Thinking…')).toHaveCount(0)
    // Tried once, not again every few seconds.
    await page.waitForTimeout(4500)
    expect(starts).toHaveLength(1)
    // A slash command stays in the box while the run ahead of it can't go.
    await box.fill('/compact')
    await box.press('Enter')
    await expect(box).toHaveValue('/compact')
    expect(starts).toHaveLength(2)
    await box.fill('')

    // With a launcher, Retry sends the run.
    const launcher = hold(baseURL!, '/api/projects/larder/launches/stream')
    try {
        await expect.poll(async () => (await (await request.get('/api/projects/larder/launches')).json()).launchers).toBe(1)
        await pane.getByRole('button', {name: 'Retry'}).click()
        await expect.poll(() => launcher.said.text).toContain('"chat":true')
        await expect(pane.getByText('Not sent')).toHaveCount(0)
        await endChats(request)
    } finally {
        launcher.stop()
    }
})

// What's held never goes on its own once the pane is closed: it's back in the box, and no chat starts (ORR-523).
test('closing the pane with messages held puts them back in the box, and starts no chat', async ({page, request}) => {
    await endChats(request)
    await page.goto('/p/larder')
    const corner = page.getByRole('button', {name: 'Agent', exact: true})
    await corner.click()
    const pane = page.getByRole('region', {name: 'Chat'})
    const box = pane.getByLabel('Message')
    let starts = 0
    await page.route('**/api/chats', route => {
        if (route.request().method() === 'POST') starts++
        return route.fallback()
    })
    await box.fill('the pantry')
    await box.press('Enter')
    await expect(pane.getByText('the pantry', {exact: true})).toBeVisible()
    await pane.getByRole('button', {name: 'Close the chat'}).click()
    await page.waitForTimeout(3000)
    expect(starts).toBe(0)
    await corner.click()
    await expect(box).toHaveValue('the pantry')
    await box.fill('')
    await pane.getByRole('button', {name: 'Close the chat'}).click()
    expect((await (await request.get('/api/chats')).json()).length).toBe(0)
})
