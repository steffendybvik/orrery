import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody, setResponseStatus} from 'h3'
import type {Chat, Project} from '#shared/roadmap'
import ChatPane from '~/components/ChatPane.vue'

// The owner's chat pane (ChatPane): the corner button, the greeting, and how what's typed goes. Quick messages in a row
// are held and go as one once typing stops (ORR-517), ⌘-Enter sends at once, Esc in an empty box takes the last one back,
// a slash command goes at once and `/clear` clears, what couldn't go waits for Retry (ORR-530), and closing puts what's
// held back in the box (ORR-523). The pane is open or closed, and says nothing of whether its chat is live (ORR-883). useChat.test.ts holds the composable, and chat.spec.ts the flows in a browser (ORR-792).
const HOLD_MS = 2000
const chat = (id: string, more: Partial<Chat> = {}) => ({id, project: 'shed', started_at: '2026-11-04T10:00:00Z', issues: 'todo', messages: [], ...more}) as unknown as Chat
const project = (id: string, name: string) =>
    ({id, name, key: id.slice(0, 3).toUpperCase(), releases: [], docs: [], release_mode: 'none', board: {milestones: [], kinds: {}}}) as unknown as Project

const posted: {path: string, body: unknown}[] = []
let refuse = ''
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))
registerEndpoint('/api/projects/shed/launches', () => ({launchers: 1, versions: [''], minimum: '', folders: [], repos: [], every: false, started: 0, starting: 0, total: 0}))
registerEndpoint('/api/chats', async event => {
    if (event.method === 'GET') return []
    const body = await readBody(event) as {project: string}
    posted.push({path: '/api/chats', body})
    return chat('c2', {project: body.project})
})
registerEndpoint('/api/chats/c2/messages', async event => {
    if (refuse) {
        setResponseStatus(event, 409)
        return {message: refuse}
    }
    posted.push({path: 'messages', body: await readBody(event)})
    return {}
})
registerEndpoint('/api/chats/c2/clear', () => {
    posted.push({path: 'clear', body: null})
    return {}
})
/** An upload on its way, landing on `uploaded()`. */
let landing: (() => void) | null = null
let uploads = 0
registerEndpoint('/api/uploads', () => new Promise(resolve => {
    const id = `u${++uploads}`
    landing = () => resolve({id, url: `/api/uploads/${id}`, markdown: `![](/api/uploads/${id})`})
}))
async function uploaded() {
    // The image is read with a FileReader before it's sent, which a busy runner can take a while over: wait for the request.
    await vi.waitFor(() => expect(landing).not.toBeNull())
    landing!()
    landing = null
    await flushPromises()
}
registerEndpoint('/api/chats/c2/end', () => {
    posted.push({path: 'end', body: null})
    return {}
})

beforeEach(() => {
    posted.length = 0
    refuse = ''
    localStorage.clear()
    clearNuxtState(['chats', 'chat-open', 'chat-picked', 'chat-blank', 'chat-project', 'chat-pinned', 'chat-failed', 'chat-heard', 'chat-large', 'chat-lands', 'launch-state'])
    useRoadmaps().projects.value = [project('shed', 'Shed')]
    useRoadmaps().ready.value = true
})
// A pane left mounted would read the state the next test clears.
const mounted: {unmount: () => void}[] = []
const mountPane = async () => {
    const pane = await mountSuspended(ChatPane)
    mounted.push(pane)
    return pane
}
afterEach(() => {
    for (const pane of mounted.splice(0)) pane.unmount()
    vi.useRealTimers()
})

async function mount() {
    const pane = await mountPane()
    useChat().open.value = true
    await flushPromises()
    const box = () => pane.find('textarea[aria-label="Message"]')
    async function type(text: string, key: Record<string, unknown> = {}) {
        await box().setValue(text)
        await box().trigger('keydown', {key: 'Enter', ...key})
        await flushPromises()
    }
    return {pane, box, type}
}
/** Lets the hold run out, and what it sends land. */
async function wait(ms = HOLD_MS) {
    await vi.advanceTimersByTimeAsync(ms)
    await flushPromises()
}
/** Until what's on its way has landed: a request's answer takes several turns of the event loop, which fake timers leave be. */
async function flushPromises() {
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve))
}
const messages = () => posted.filter(p => p.path === 'messages').map(p => p.body as {text?: string, parts?: string[]})

describe('ChatPane', () => {
    it('is the Agent button until opened, then greets with things to ask', async () => {
        const pane = await mountPane()
        const button = pane.find('button')
        expect(button.text()).toContain('Agent')
        await button.trigger('click')
        expect(useChat().open.value).toBe(true)
        expect(pane.find('section[aria-label="Chat"]').exists()).toBe(true)
        expect(pane.text()).toContain("What's left in the next release?")
    })

    it('holds quick messages in a row and sends them as one once typing stops, starting the chat on the project', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
        const {pane, type} = await mount()
        await type('The door sticks')
        await wait(HOLD_MS / 2)
        await type('in the wet')
        // Shown as sent, with the spinner, while it waits.
        expect(pane.text()).toContain('The door sticks')
        expect(pane.find('[aria-label="Thinking…"]').exists()).toBe(true)
        await wait(HOLD_MS - 100)
        expect(posted).toEqual([])
        await wait(200)
        expect(posted[0]).toEqual({path: '/api/chats', body: {project: 'shed', issues: 'todo'}})
        expect(messages()).toEqual([expect.objectContaining({parts: ['The door sticks', 'in the wet']})])
    })

    it('sends at once on ⌘-Enter, and Shift-Enter is a new line rather than a message', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
        const {box, type} = await mount()
        await box().setValue('one')
        await box().trigger('keydown', {key: 'Enter', shiftKey: true})
        expect((box().element as HTMLTextAreaElement).value).toBe('one')
        await type('Plane the door', {metaKey: true})
        expect(messages()).toEqual([expect.objectContaining({text: 'Plane the door'})])
    })

    it('takes the last held message back into an empty box on Esc, so it never goes', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
        const {box, type} = await mount()
        await type('Paint it red')
        await box().trigger('keydown', {key: 'Escape'})
        expect((box().element as HTMLTextAreaElement).value).toBe('Paint it red')
        await wait(HOLD_MS * 2)
        expect(posted).toEqual([])
    })

    it('sends a slash command at once after what was held, and /clear clears the running chat instead of going to it', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
        const {box, type} = await mount()
        await type('Hello')
        await type('/compact')
        expect(messages().map(m => m.text)).toEqual(['Hello', '/compact'])
        await type('/clear')
        expect(posted.at(-1)).toEqual({path: 'clear', body: null})
        expect(messages()).toHaveLength(2)
        expect((box().element as HTMLTextAreaElement).value).toBe('')
    })

    it('says Not sent with Retry when a message can\'t go, and Retry sends it', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
        const {pane, type} = await mount()
        refuse = 'No launcher is running for shed'
        await type('Oil the hinge')
        await wait()
        expect(pane.text()).toContain('Not sent')
        // It doesn't try again on its own.
        await wait(HOLD_MS * 3)
        expect(messages()).toEqual([])
        refuse = ''
        await pane.findAll('button').find(b => b.text() === 'Retry')!.trigger('click')
        await flushPromises()
        expect(messages()).toEqual([expect.objectContaining({text: 'Oil the hinge'})])
        expect(pane.text()).not.toContain('Not sent')
    })

    it('leaves the chat running when the pane closes: what was held still goes to it (ORR-878)', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
        const {pane, box, type} = await mount()
        await type('Fix the latch', {metaKey: true})
        await type('and the bolt')
        await pane.find('button[aria-label="Close the chat, leaving it running"]').trigger('click')
        await flushPromises()
        expect(posted.some(p => p.path === 'end')).toBe(false)
        expect(useChat().open.value).toBe(false)
        expect(useChat().chat.value?.ended).toBeFalsy()
        await wait(HOLD_MS * 2)
        expect(messages()).toEqual([expect.objectContaining({text: 'Fix the latch'}), expect.objectContaining({text: 'and the bolt'})])
        useChat().open.value = true
        await flushPromises()
        expect((box().element as HTMLTextAreaElement).value).toBe('')
    })

    it('takes a message in an ended chat, sending it there rather than starting another (ORR-884)', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
        useChat().arrived(chat('c2', {ended: true, ended_at: '2026-11-04T11:00:00Z', messages: [{id: 1, at: '2026-11-04T10:00:00Z', from: 'owner', text: 'Oil the hinge', images: []}]} as Partial<Chat>))
        useChat().view('c2')
        const {pane, type} = await mount()
        expect(pane.text()).not.toContain('This chat has ended')
        await type('And the latch?')
        await wait()
        expect(messages()).toEqual([expect.objectContaining({text: 'And the latch?'})])
        expect(posted.some(p => p.path === '/api/chats')).toBe(false)
    })

    it('is open or closed: no Minimize, Esc closes it with the chat running, and nothing says it is ready (ORR-883)', async () => {
        useChat().arrived(chat('c2', {messages: [{id: 1, at: '2026-11-04T10:00:00Z', from: 'owner', text: 'Oil the hinge', images: []}]} as Partial<Chat>))
        useRoadmaps().chatSessions.value = {shed: [{id: 's1', name: 'shed · Ask', state: 'idle', started: {launch: 'c2'}} as never]}
        const {pane, box} = await mount()
        expect(pane.find('[data-testid="chat-name"]').exists()).toBe(true)
        expect(pane.find('header').text()).not.toContain('Ready')
        expect(pane.findAll('button').some(b => /Minimize/.test(b.attributes('aria-label') ?? ''))).toBe(false)
        await box().trigger('keydown', {key: 'Escape'})
        await flushPromises()
        expect(useChat().open.value).toBe(false)
        expect(posted.some(p => p.path === 'end')).toBe(false)
        expect(useChat().chat.value?.ended).toBeFalsy()
        const corner = pane.find('button[title^="Chat about a project"]')
        expect(corner.text()).toBe('Agent')
        expect(corner.find('svg').classes()).not.toContain('animate-pulse')
    })

    it("leaves the focus in a field elsewhere: an image landing doesn't pull it back to the box (ORR-834)", async () => {
        const pane = await mountSuspended(ChatPane, {attachTo: document.body})
        mounted.push(pane)
        useChat().open.value = true
        await flushPromises()
        const box = pane.find('textarea[aria-label="Message"]').element as HTMLTextAreaElement
        expect(document.activeElement).toBe(box)
        const picker = pane.find('input[type="file"]')
        const image = () => Object.defineProperty(picker.element, 'files', {value: [new File(['x'], 'jar.png', {type: 'image/png'})], configurable: true})

        // Picked while in the box, it goes back to the box.
        image()
        await picker.trigger('change')
        await uploaded()
        expect(pane.findAll('button[aria-label^="Remove image"]')).toHaveLength(1)
        expect(document.activeElement).toBe(box)

        // The owner has gone on to type in another field (a session's Message box) as it lands: the focus stays there.
        const other = document.createElement('textarea')
        document.body.append(other)
        image()
        await picker.trigger('change')
        other.focus()
        await uploaded()
        expect(pane.findAll('button[aria-label^="Remove image"]')).toHaveLength(2)
        expect(document.activeElement).toBe(other)
        other.remove()
    })
})
