import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Chat} from '#shared/roadmap'

// The owner's chats live in the module, with Nitro's auto-imports stubbed: its launch, and the message to its session.
let chats: typeof import('../server/utils/chats')
let changes: Chat[]
let messages: {project: string, target: string, text: string}[]
let stopped: string[]

beforeEach(async () => {
    changes = []
    messages = []
    stopped = []
    const events = new EventEmitter()
    events.on('chat', chat => changes.push(chat))
    vi.stubGlobal('projectEvents', events)
    vi.stubGlobal('startChat', async (project: string, context: {text: string}) => ({id: 'c1c2c3c4c5c6', project, context}))
    vi.stubGlobal('launchTarget', (id: string) => `launch-${id}`)
    vi.stubGlobal('endLaunch', (_project: string, id: string) => stopped.push(id))
    vi.stubGlobal('useStore', () => ({messageSession: async (project: string, target: string, text: string) => void messages.push({project, target, text})}))
    vi.stubGlobal('notFound', (message: string) => Object.assign(new Error(message), {statusCode: 404}))
    vi.stubGlobal('badRequest', (message: string) => Object.assign(new Error(message), {statusCode: 400}))
    vi.resetModules()
    chats = await import('../server/utils/chats')
})

afterEach(() => vi.unstubAllGlobals())

const owner = {name: 'skoll', owner: true}
const image = 'e961abaa8718ef8efe55380b'

describe("the owner's chat", () => {
    it('starts with its session on its way, and nothing said yet', async () => {
        const chat = await chats.openChat('greenhouse')
        expect(chat).toMatchObject({id: 'c1c2c3c4c5c6', project: 'greenhouse', messages: []})
        expect(chats.listChats()).toEqual([chat])
        expect(changes).toHaveLength(1)
    })

    it("sends the owner's words, and the images pasted with them, to its session alone, and keeps the answer", async () => {
        await chats.openChat('greenhouse')
        await chats.say('c1c2c3c4c5c6', '  What is GRE-4 about?  ', [image], owner)
        expect(messages).toEqual([{project: 'greenhouse', target: 'launch-c1c2c3c4c5c6', text: `What is GRE-4 about?\n\n(An image pasted with this: ${image}. Look with the image tool.)`}])
        chats.reply('c1c2c3c4c5c6', 'It moves the shelves.')
        expect(chats.chatOf('c1c2c3c4c5c6').messages.map(m => [m.from, m.text, m.images])).toEqual([
            ['owner', 'What is GRE-4 about?', [image]],
            ['claude', 'It moves the shelves.', []],
        ])
    })

    it('says the page the owner is on at the end of what its session hears, and keeps it out of the message', async () => {
        await chats.openChat('greenhouse')
        const said = await chats.say('c1c2c3c4c5c6', 'What runs here?', [], owner, {path: '/p/greenhouse/schedules', title: ' Schedules \n· Greenhouse '})
        expect(messages.at(-1)!.text).toBe('What runs here?\n\n(The owner is on /p/greenhouse/schedules: Schedules · Greenhouse.)')
        expect(said).not.toHaveProperty('page')
        await chats.say('c1c2c3c4c5c6', 'And now?', [], owner, {path: '/sessions'})
        expect(messages.at(-1)!.text).toBe('And now?\n\n(The owner is on /sessions.)')
        for (const page of [{path: 'https://elsewhere.example'}, {path: '//elsewhere.example/x'}, {path: '/a b'}, {title: 'No path'}, '/p/greenhouse'])
            await expect(chats.say('c1c2c3c4c5c6', 'Hm', [], owner, page)).rejects.toMatchObject({statusCode: 400})
    })

    it('refuses an empty message, an image that is no upload, and an empty answer', async () => {
        await chats.openChat('greenhouse')
        await expect(chats.say('c1c2c3c4c5c6', ' ', [], owner)).rejects.toMatchObject({statusCode: 400})
        await expect(chats.say('c1c2c3c4c5c6', 'Look', ['../etc/passwd'], owner)).rejects.toMatchObject({statusCode: 400})
        expect(() => chats.reply('c1c2c3c4c5c6', '')).toThrow(/Send the answer/)
        expect(messages).toEqual([])
    })

    it("says why its session can't start, and stops once it can", async () => {
        await chats.openChat('greenhouse')
        chats.chatProblem('c1c2c3c4c5c6', 'Restart the launcher.')
        expect(changes.at(-1)).toMatchObject({id: 'c1c2c3c4c5c6', problem: 'Restart the launcher.'})
        // Said once: the same again changes nothing.
        chats.chatProblem('c1c2c3c4c5c6', 'Restart the launcher.')
        expect(changes).toHaveLength(2)
        chats.chatProblem('c1c2c3c4c5c6', null)
        expect(chats.chatOf('c1c2c3c4c5c6').problem).toBeUndefined()
        expect(changes).toHaveLength(3)
    })

    it('ends when the owner ends it: its session is stopped and the chat goes, saying so', async () => {
        await chats.openChat('greenhouse')
        chats.endChat('c1c2c3c4c5c6')
        expect(stopped).toEqual(['c1c2c3c4c5c6'])
        expect(chats.listChats()).toEqual([])
        expect(changes.at(-1)).toMatchObject({id: 'c1c2c3c4c5c6', ended: true})
        expect(() => chats.chatOf('c1c2c3c4c5c6')).toThrow(/has ended/)
        await expect(chats.say('c1c2c3c4c5c6', 'Still there?', [], owner)).rejects.toMatchObject({statusCode: 404})
    })

    it("speaks for the owner while it runs, marked as the chat, and for nobody otherwise", async () => {
        vi.stubGlobal('getHeader', (event: {headers: Record<string, string>}, name: string) => event.headers[name])
        vi.stubGlobal('forbidden', (message: string) => Object.assign(new Error(message), {statusCode: 403}))
        vi.stubGlobal('useStore', () => ({ownerOf: async () => ({name: 'skoll'})}))
        const as = (launch?: string) => chats.chatOwner({headers: launch ? {'orrery-launch': launch} : {}} as never)
        await expect(as('c1c2c3c4c5c6')).rejects.toMatchObject({statusCode: 403})
        await chats.openChat('greenhouse')
        await expect(as('c1c2c3c4c5c6')).resolves.toEqual({name: 'skoll', owner: true, via: 'chat'})
        await expect(as('nope')).rejects.toMatchObject({statusCode: 403})
        await expect(as()).rejects.toMatchObject({statusCode: 403})
    })

    it('makes what its session asks for with nobody on it, in Todo whatever status it asks for', () => {
        expect(chats.asChatIssue({title: 'Shelf labels', notes: 'From the chat', status: 'in-progress', assignee: 'claude', priority: 'P2', chunk: '3'}))
            .toEqual({title: 'Shelf labels', notes: 'From the chat', priority: 'P2', chunk: '3', status: 'todo'})
        for (const status of [undefined, 'backlog', 'done', 'canceled']) expect(chats.asChatIssue({title: 'Seed trays', status, plan: null})).toEqual({title: 'Seed trays', status: 'todo'})
    })

    it('leaves a proposal one, for the owner to decide', () => {
        expect(chats.asChatIssue({title: 'Grow lights', proposal: 'pending', status: 'todo', assignee: 'claude'})).toEqual({title: 'Grow lights', proposal: 'pending'})
    })
})

describe("a chat session's writes", () => {
    type Event = {method: string, path: string, headers: Record<string, string>}
    let guard: (event: Event) => void

    beforeEach(async () => {
        vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
        vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
        vi.stubGlobal('chatSession', () => false)
        vi.stubGlobal('chatWrite', (event: Event) => event.headers['orrery-chat'] === 'yes')
        vi.stubGlobal('forbidden', (message: string) => Object.assign(new Error(message), {statusCode: 403}))
        vi.resetModules()
        guard = (await import('../server/middleware/chat')).default as unknown as typeof guard
    })

    const refused = (method: string, path: string, chat = true) => {
        try {
            guard({method, path, headers: chat ? {'orrery-chat': 'yes'} : {}})
        } catch (error) {
            return (error as {statusCode: number}).statusCode
        }
    }

    it('make issues, comment, answer in the chat, message sessions, and read anything; nothing else', () => {
        expect(refused('POST', '/api/projects/greenhouse/issues')).toBeUndefined()
        expect(refused('POST', '/api/sessions/message')).toBeUndefined()
        expect(refused('POST', '/api/projects/greenhouse/sessions/abc/message')).toBeUndefined()
        expect(refused('POST', '/api/projects/greenhouse/sessions/abc/stop')).toBe(403)
        expect(refused('POST', '/api/projects/greenhouse/launches')).toBe(403)
        expect(refused('POST', '/api/projects/greenhouse/issues/GRE-4/comments')).toBeUndefined()
        expect(refused('POST', '/api/chats/c1c2c3c4c5c6/replies')).toBeUndefined()
        expect(refused('GET', '/api/projects/greenhouse/docs')).toBeUndefined()
        expect(refused('PATCH', '/api/projects/greenhouse/issues/GRE-4')).toBe(403)
        expect(refused('PUT', '/api/projects/greenhouse/docs/shelving')).toBe(403)
        expect(refused('POST', '/api/egress')).toBe(403)
        expect(refused('POST', '/api/chats/c1c2c3c4c5c6/messages')).toBe(403)
        // Anyone else's go on to their own checks.
        expect(refused('PATCH', '/api/projects/greenhouse/issues/GRE-4', false)).toBeUndefined()
    })
})
