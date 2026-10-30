import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Chat} from '#shared/roadmap'
import {Store} from '../server/utils/store'
import {testDb} from './db'

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
    vi.stubGlobal('currentId', (id: string) => id)
    vi.resetModules()
    chats = await import('../server/utils/chats')
})

afterEach(() => vi.unstubAllGlobals())

const owner = {name: 'skoll', owner: true}
const image = 'e961abaa8718ef8efe55380b'

describe("the owner's chat", () => {
    it('starts with its session on its way, and nothing said yet', async () => {
        const chat = await chats.openChat('greenhouse')
        expect(chat).toMatchObject({id: 'c1c2c3c4c5c6', project: 'greenhouse', messages: [], issues: 'todo'})
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

    it('says when the page the owner is on belongs to another project than the chat (ORR-588)', async () => {
        await chats.openChat('greenhouse')
        await chats.say('c1c2c3c4c5c6', 'File this', [], owner, {path: '/p/personal/issues/PER-3', title: 'PER-3'})
        expect(messages.at(-1)!.text).toBe('File this\n\n(The owner is on /p/personal/issues/PER-3: PER-3. That page is on personal, not this chat\'s project, greenhouse.)')
        await chats.say('c1c2c3c4c5c6', 'And here?', [], owner, {path: '/p/greenhouse?view=board'})
        expect(messages.at(-1)!.text).toBe('And here?\n\n(The owner is on /p/greenhouse?view=board.)')
    })

    it('sends a run of messages held together as one, and keeps its parts (ORR-517)', async () => {
        await chats.openChat('greenhouse')
        const said = await chats.say('c1c2c3c4c5c6', undefined, [], owner, undefined, [' what about ', '', 'the shelves in GRE-4 '])
        expect(messages).toEqual([{project: 'greenhouse', target: 'launch-c1c2c3c4c5c6', text: 'what about\n\nthe shelves in GRE-4'}])
        expect(said).toMatchObject({from: 'owner', text: 'what about\n\nthe shelves in GRE-4', parts: ['what about', 'the shelves in GRE-4']})
        // One part is just a message.
        expect(await chats.say('c1c2c3c4c5c6', undefined, [], owner, undefined, ['and?'])).not.toHaveProperty('parts')
        await expect(chats.say('c1c2c3c4c5c6', undefined, [], owner, undefined, ['ok', 3])).rejects.toMatchObject({statusCode: 400})
        await expect(chats.say('c1c2c3c4c5c6', undefined, [], owner, undefined, [' '])).rejects.toMatchObject({statusCode: 400})
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

    it("clears its session's context when the owner asks, keeping the chat and what was said, with the cut marked (ORR-497)", async () => {
        const launches: unknown[] = []
        const notes: {kind: string}[] = []
        ;(projectEvents as EventEmitter).on('launches', event => launches.push(event))
        vi.stubGlobal('useEventLog', () => ({note: (note: {kind: string}) => notes.push(note)}))
        await chats.openChat('greenhouse')
        await chats.say('c1c2c3c4c5c6', 'What is GRE-4 about?', [], owner)
        const cut = chats.clearChat('c1c2c3c4c5c6')
        expect(launches).toEqual([{type: 'clear', project: 'greenhouse', id: 'c1c2c3c4c5c6'}])
        expect(cut).toMatchObject({from: 'owner', text: '', images: [], cleared: true})
        expect(chats.chatOf('c1c2c3c4c5c6').messages.map(m => m.text)).toEqual(['What is GRE-4 about?', ''])
        expect(changes.at(-1)!.messages.at(-1)).toMatchObject({cleared: true})
        expect(notes.map(n => n.kind)).toEqual(['chat.cleared'])
        // Nothing goes to the session as words: its launcher types /clear.
        expect(messages).toHaveLength(1)
        expect(stopped).toEqual([])
        chats.endChat('c1c2c3c4c5c6')
        expect(() => chats.clearChat('c1c2c3c4c5c6')).toThrow(/has ended/)
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

    it('asks the owner to message sessions, sending only once they press Send, as theirs through the chat', async () => {
        const sent: {project: string, target: string, text: string, via?: string}[] = []
        const notes: {kind: string}[] = []
        type Listed = {id: string, project: string, name: string, state: string, listening: boolean, chat?: boolean}
        let listed: Listed[] = [
            {id: 'abc', project: 'greenhouse', name: 'Nordre', state: 'idle', listening: true},
            {id: 'def', project: 'pantry', name: 'Sudri', state: 'working', listening: true},
            {id: 'c1c2c3c4c5c6', project: 'greenhouse', name: 'Chat', state: 'idle', listening: true, chat: true},
        ]
        vi.stubGlobal('useStore', () => ({messageSession: async (project: string, target: string, text: string, actor: {via?: string}) => void sent.push({project, target, text, ...actor.via ? {via: actor.via} : {}})}))
        vi.stubGlobal('useEventLog', () => ({note: (entry: {kind: string}) => notes.push(entry)}))
        vi.stubGlobal('conflict', (message: string) => Object.assign(new Error(message), {statusCode: 409}))
        vi.stubGlobal('listSessions', () => listed)
        vi.stubGlobal('chatSession', (id: string) => !!listed.find(s => s.id === id)?.chat)
        vi.stubGlobal('hearing', (_project: string, id: string) => !!listed.find(s => s.id === id)?.listening)
        vi.stubGlobal('recipients', (_projects?: string[], states = ['idle']) => listed.filter(s => s.listening && !s.chat && states.includes(s.state)))
        vi.stubGlobal('messaged', () => {})
        await chats.openChat('greenhouse')
        const asked = await chats.askSend('c1c2c3c4c5c6', {message: {text: 'Pick up Todo.'}, why: 'Both are idle.'})
        expect(asked).toMatchObject({from: 'claude', text: 'Both are idle.', send: {text: 'Pick up Todo.', to: ['Nordre'], state: 'asked'}})
        expect(sent).toEqual([])
        // Who fits is worked out again on Send: Sudri has gone idle since.
        listed = listed.map(s => s.id === 'def' ? {...s, state: 'idle'} : s)
        await chats.answer('c1c2c3c4c5c6', asked.id, true, owner)
        expect(sent).toEqual([
            {project: 'greenhouse', target: 'abc', text: 'Pick up Todo.', via: 'chat'},
            {project: 'pantry', target: 'def', text: 'Pick up Todo.', via: 'chat'},
            {project: 'greenhouse', target: 'launch-c1c2c3c4c5c6', text: '(I sent your message to Nordre, Sudri.)'},
        ])
        expect(asked.send).toMatchObject({state: 'allowed', sent: ['Nordre', 'Sudri']})
        await expect(chats.answer('c1c2c3c4c5c6', asked.id, true, owner)).rejects.toMatchObject({statusCode: 409})
        // One session by name, any case; Don't send sends nothing.
        sent.length = 0
        const one = await chats.askSend('c1c2c3c4c5c6', {message: {text: 'Look at PAN-2.', session: 'sudri'}})
        expect(one.send).toMatchObject({session: 'def', project: 'pantry', to: ['Sudri']})
        await chats.answer('c1c2c3c4c5c6', one.id, false, owner)
        expect(sent).toEqual([{project: 'greenhouse', target: 'launch-c1c2c3c4c5c6', text: "(I didn't send your message to Sudri: nothing went.)"}])
        // A session that stopped listening fails on Send, and the request stays asked.
        const later = await chats.askSend('c1c2c3c4c5c6', {message: {text: 'Wrap up.', session: 'Nordre'}})
        listed = listed.map(s => s.id === 'abc' ? {...s, listening: false} : s)
        await expect(chats.answer('c1c2c3c4c5c6', later.id, true, owner)).rejects.toMatchObject({statusCode: 409})
        expect(later.send!.state).toBe('asked')
        // Never another chat, no one unknown, nobody fitting, no text.
        await expect(chats.askSend('c1c2c3c4c5c6', {message: {text: 'Hi', session: 'Chat'}})).rejects.toMatchObject({statusCode: 404})
        await expect(chats.askSend('c1c2c3c4c5c6', {message: {text: 'Hi', session: 'Austri'}})).rejects.toMatchObject({statusCode: 404})
        await expect(chats.askSend('c1c2c3c4c5c6', {message: {text: 'Hi', states: ['waiting']}})).rejects.toMatchObject({statusCode: 409})
        await expect(chats.askSend('c1c2c3c4c5c6', {message: {text: 'Hi', states: ['asleep']}})).rejects.toMatchObject({statusCode: 400})
        await expect(chats.ask('c1c2c3c4c5c6', {message: {text: ' '}})).rejects.toMatchObject({statusCode: 400})
        expect(notes.map(n => n.kind)).toEqual(['chat.asked', 'session.messaged', 'session.messaged', 'chat.answered', 'chat.asked', 'chat.answered', 'chat.asked'])
    })

    it('sends to a session that cleared since it was asked, under its new id (ORR-480)', async () => {
        const sent: string[] = []
        let listed = [{id: 'abc', project: 'greenhouse', name: 'Nordre', state: 'idle', listening: true}]
        const aliases = new Map<string, string>()
        vi.stubGlobal('useStore', () => ({messageSession: async (_project: string, target: string) => void sent.push(target)}))
        vi.stubGlobal('useEventLog', () => ({note: () => {}}))
        vi.stubGlobal('conflict', (message: string) => Object.assign(new Error(message), {statusCode: 409}))
        vi.stubGlobal('listSessions', () => listed)
        vi.stubGlobal('chatSession', () => false)
        vi.stubGlobal('hearing', (_project: string, id: string) => listed.some(s => s.id === id && s.listening))
        vi.stubGlobal('currentId', (id: string) => aliases.get(id) ?? id)
        vi.stubGlobal('messaged', () => {})
        await chats.openChat('greenhouse')
        const asked = await chats.askSend('c1c2c3c4c5c6', {message: {text: 'Look at GRE-3.', session: 'Nordre'}})
        expect(asked.send).toMatchObject({session: 'abc'})
        // Its launcher clears it: a new id, the old one an alias.
        listed = [{...listed[0]!, id: 'xyz'}]
        aliases.set('abc', 'xyz')
        await chats.answer('c1c2c3c4c5c6', asked.id, true, owner)
        expect(sent).toEqual(['xyz', 'launch-c1c2c3c4c5c6'])
        expect(asked.send).toMatchObject({state: 'allowed', sent: ['Nordre']})
    })

    it('sends once however often Send is pressed, and only to the rest after one failed (ORR-455)', async () => {
        const sent: string[] = []
        let failing = 'def'
        const listed = [
            {id: 'abc', project: 'greenhouse', name: 'Nordre', state: 'idle', listening: true},
            {id: 'def', project: 'pantry', name: 'Sudri', state: 'idle', listening: true},
        ]
        vi.stubGlobal('useStore', () => ({messageSession: async (_project: string, target: string) => {
            await new Promise(resolve => setTimeout(resolve, 0))
            if (target === failing) throw Object.assign(new Error('Sudri stopped listening'), {statusCode: 409})
            sent.push(target)
        }}))
        vi.stubGlobal('useEventLog', () => ({note: () => {}}))
        vi.stubGlobal('conflict', (message: string) => Object.assign(new Error(message), {statusCode: 409}))
        vi.stubGlobal('listSessions', () => listed)
        vi.stubGlobal('chatSession', () => false)
        vi.stubGlobal('recipients', () => listed)
        vi.stubGlobal('messaged', () => {})
        await chats.openChat('greenhouse')
        const asked = await chats.askSend('c1c2c3c4c5c6', {message: {text: 'Pick up Todo.'}})
        // Sudri fails after Nordre had it: still asked, with Nordre kept as sent.
        await expect(chats.answer('c1c2c3c4c5c6', asked.id, true, owner)).rejects.toThrow(/stopped listening/)
        expect(asked.send).toMatchObject({state: 'asked', sent: ['Nordre']})
        expect(sent).toEqual(['abc'])
        // Pressed again twice at once: one goes through, to Sudri alone, and the other is refused.
        failing = ''
        const both = await Promise.allSettled([chats.answer('c1c2c3c4c5c6', asked.id, true, owner), chats.answer('c1c2c3c4c5c6', asked.id, true, owner)])
        expect(both.map(b => b.status).sort()).toEqual(['fulfilled', 'rejected'])
        expect(both.find(b => b.status === 'rejected')).toMatchObject({reason: {statusCode: 409}})
        expect(sent).toEqual(['abc', 'def', 'launch-c1c2c3c4c5c6'])
        expect(asked.send).toMatchObject({state: 'allowed', sent: ['Nordre', 'Sudri']})
    })

    it("asks the owner to change a setting, saving it only once they allow it, and telling its session", async () => {
        const saved: object[] = []
        const notes: {kind: string}[] = []
        let tracker: string | null = null
        vi.stubGlobal('useStore', () => ({
            settings: async () => ({tracker, tint: null, handle: null, restrict_proposals: true, advanced: false}),
            updateSettings: async (patch: {tracker?: string}) => {
                saved.push(patch)
                tracker = patch.tracker ?? tracker
            },
            messageSession: async (project: string, target: string, text: string) => void messages.push({project, target, text}),
        }))
        vi.stubGlobal('useEventLog', () => ({note: (entry: {kind: string}) => notes.push(entry)}))
        vi.stubGlobal('conflict', (message: string) => Object.assign(new Error(message), {statusCode: 409}))
        await chats.openChat('greenhouse')
        const url = 'https://tracker.example.com/issue/{id}'
        const asked = await chats.askSetting('c1c2c3c4c5c6', {setting: 'tracker', value: url, why: 'Links ENG-1234 to its task.'})
        expect(asked).toMatchObject({from: 'claude', text: 'Links ENG-1234 to its task.', request: {setting: 'tracker', from: null, to: url, state: 'asked'}})
        expect(saved).toEqual([])
        // Denied saves nothing, and can't be answered again.
        await chats.answer('c1c2c3c4c5c6', asked.id, false, owner)
        expect(saved).toEqual([])
        expect(messages.at(-1)!.text).toMatch(/denied .*nothing changed/)
        await expect(chats.answer('c1c2c3c4c5c6', asked.id, true, owner)).rejects.toMatchObject({statusCode: 409})
        // Allowed saves it as asked.
        const again = await chats.askSetting('c1c2c3c4c5c6', {setting: 'tracker', value: url})
        await chats.answer('c1c2c3c4c5c6', again.id, true, owner)
        expect(saved).toEqual([{tracker: url}])
        expect(chats.chatOf('c1c2c3c4c5c6').messages.find(m => m.id === again.id)!.request!.state).toBe('allowed')
        expect(messages.at(-1)!.text).toContain(`Team tracker is now ${url}, saved`)
        expect(notes.map(n => n.kind)).toEqual(['chat.asked', 'chat.answered', 'chat.asked', 'settings.changed', 'chat.answered'])
        // Asking again for the same setting lets the one before go; an old request expires.
        const first = await chats.askSetting('c1c2c3c4c5c6', {setting: 'advanced', value: true})
        const second = await chats.askSetting('c1c2c3c4c5c6', {setting: 'advanced', value: false})
        await expect(chats.answer('c1c2c3c4c5c6', first.id, true, owner)).rejects.toMatchObject({statusCode: 409})
        vi.useFakeTimers({now: Date.now() + chats.ASK_FOR + 1000})
        await expect(chats.answer('c1c2c3c4c5c6', second.id, true, owner)).rejects.toThrow(/expired/)
        vi.useRealTimers()
        expect(saved).toHaveLength(1)
    })

    it("asks only for the settings a chat may, and as the settings would take them", async () => {
        vi.stubGlobal('useStore', () => ({settings: async () => ({handle: null})}))
        vi.stubGlobal('useEventLog', () => ({note: () => {}}))
        await chats.openChat('greenhouse')
        for (const body of [{setting: 'secrets', value: 'x'}, {setting: 'starts', value: null}, {setting: 'focus_prompt', value: 'Hi'}, {setting: 'tracker'},
            {setting: 'tracker', value: 'not a link'}, {setting: 'advanced', value: 'yes'}])
            await expect(chats.askSetting('c1c2c3c4c5c6', body)).rejects.toMatchObject({statusCode: 400})
        expect((await chats.askSetting('c1c2c3c4c5c6', {setting: 'handle', value: 'Skoll'})).request!.to).toBe('skoll')
    })

    it("asks to make a schedule or change one, checked for the owner, and saves it as theirs only once they allow it", async () => {
        const notes: {kind: string}[] = []
        const made: {project: string, body: unknown, actor: unknown, id?: number}[] = []
        const checked: {body: unknown, actor: {owner: boolean}, id?: number}[] = []
        const nightly = {id: 3, title: 'Nightly triage', kind: 'message', notes: 'Triage', cron: '0 2 * * *', presets: [7], enabled: true}
        vi.stubGlobal('useStore', () => ({
            ownerOf: async () => ({name: 'skoll'}),
            presets: async () => [{id: 7, name: 'Review'}, {id: 8, name: 'Debug an error'}],
            messageSession: async (project: string, target: string, text: string) => void messages.push({project, target, text}),
        }))
        vi.stubGlobal('useScheduler', () => ({
            get: async (_project: string, id: number) => {
                if (id !== 3) throw Object.assign(new Error(`No schedule ${id}`), {statusCode: 404})
                return nightly
            },
            check: async (_project: string, body: {cron?: string}, actor: {owner: boolean}, id?: number) => {
                if (body.cron === 'often') throw Object.assign(new Error('cron'), {statusCode: 400})
                checked.push({body, actor, id})
            },
            create: async (project: string, body: {title: string}, actor: unknown) => (made.push({project, body, actor}), {id: 9, title: body.title, enabled: true}),
            update: async (project: string, id: number, body: unknown, actor: unknown) => (made.push({project, body, actor, id}), {...nightly, enabled: false}),
        }))
        vi.stubGlobal('useEventLog', () => ({note: (entry: {kind: string}) => notes.push(entry)}))
        vi.stubGlobal('conflict', (message: string) => Object.assign(new Error(message), {statusCode: 409}))
        vi.stubGlobal('forbidden', (message: string) => Object.assign(new Error(message), {statusCode: 403}))
        await chats.openChat('greenhouse')
        const fresh = await chats.ask('c1c2c3c4c5c6', {schedule: {title: 'Weekly review', kind: 'session', on: 'issue.status', on_filter: {to: 'in-review'}, presets: [8]}, why: 'As you asked.'})
        expect(fresh).toMatchObject({from: 'claude', text: 'As you asked.', schedule: {title: 'Weekly review', state: 'asked', changes: [
            {field: 'title', to: 'Weekly review'}, {field: 'kind', to: 'session'}, {field: 'on', to: 'issue.status'}, {field: 'on_filter', to: {to: 'in-review'}}, {field: 'presets', to: ['Debug an error']},
        ]}})
        expect(fresh.schedule).not.toHaveProperty('id')
        // Checked as the owner would make it (a session schedule is theirs alone), and nothing saved yet.
        expect(checked[0]).toMatchObject({actor: {name: 'skoll', owner: true}, id: undefined})
        expect(made).toEqual([])
        await chats.answer('c1c2c3c4c5c6', fresh.id, true, owner)
        expect(made).toEqual([{project: 'greenhouse', body: {title: 'Weekly review', kind: 'session', on: 'issue.status', on_filter: {to: 'in-review'}, presets: [8]}, actor: {...owner, via: 'chat'}}])
        expect(chats.chatOf('c1c2c3c4c5c6').messages.find(m => m.id === fresh.id)!.schedule).toMatchObject({id: 9, state: 'allowed'})
        expect(messages.at(-1)!.text).toBe('(I allowed your request: schedule 9 ("Weekly review") is saved.)')
        // A change shows each field from → to; asking again for the same schedule lets the one before go.
        const pause = await chats.ask('c1c2c3c4c5c6', {id: 3, schedule: {enabled: false}})
        const resume = await chats.ask('c1c2c3c4c5c6', {id: 3, schedule: {enabled: true, presets: [8]}})
        expect(pause.schedule!.state).toBe('expired')
        expect(resume.schedule).toMatchObject({id: 3, title: 'Nightly triage', changes: [{field: 'enabled', from: true, to: true}, {field: 'presets', from: ['Review'], to: ['Debug an error']}]})
        await chats.answer('c1c2c3c4c5c6', resume.id, false, owner)
        expect(made).toHaveLength(1)
        expect(messages.at(-1)!.text).toMatch(/denied your request to change schedule 3 .*nothing changed/)
        // What it may not ask for, or what Schedules would refuse, fails as it asks.
        for (const [body, status] of [[{schedule: {}}, 400], [{schedule: {title: 'X', untrusted: true}}, 403], [{schedule: {title: 'X', cron: 'often'}}, 400],
            [{id: 4, schedule: {enabled: false}}, 404], [{id: 'nightly', schedule: {enabled: false}}, 400]] as const)
            await expect(chats.ask('c1c2c3c4c5c6', body)).rejects.toMatchObject({statusCode: status})
        expect(notes.map(n => n.kind)).toEqual(['chat.asked', 'chat.answered', 'chat.asked', 'chat.asked', 'chat.answered'])
    })

    it("asks to add a release or change one, checked as Releases would, and saves it as the owner's only once they allow it", async () => {
        const notes: {kind: string}[] = []
        const saved: {how: string, project: string, version?: string, body: unknown, actor: unknown}[] = []
        const releases = [{version: '1.1.0', branch: 'v1.1.0'}, {version: '1.0.0', branch: 'v1.0.0', frozen_on: '2026-10-20'}]
        vi.stubGlobal('useStore', () => ({
            checkRelease: async (_project: string, body: {version?: string, branch?: string}, version?: string) => {
                if (body.version === '1.1.0' && version === undefined) throw Object.assign(new Error('There is already a release 1.1.0'), {statusCode: 409})
                if (version === undefined) return undefined
                const found = releases.find(r => r.version === version)
                if (!found) throw Object.assign(new Error(`No release ${version}`), {statusCode: 404})
                return found
            },
            listReleases: async () => releases,
            createRelease: async (project: string, body: unknown, actor: unknown) => void saved.push({how: 'create', project, body, actor}),
            updateRelease: async (project: string, version: string, body: unknown, actor: unknown) => void saved.push({how: 'update', project, version, body, actor}),
            messageSession: async (project: string, target: string, text: string) => void messages.push({project, target, text}),
        }))
        vi.stubGlobal('useEventLog', () => ({note: (entry: {kind: string}) => notes.push(entry)}))
        vi.stubGlobal('conflict', (message: string) => Object.assign(new Error(message), {statusCode: 409}))
        vi.stubGlobal('forbidden', (message: string) => Object.assign(new Error(message), {statusCode: 403}))
        await chats.openChat('greenhouse')
        const fresh = await chats.ask('c1c2c3c4c5c6', {release: {version: '1.2.0', branch: 'v1.2.0', position: 1}, why: 'As you asked.'})
        expect(fresh).toMatchObject({from: 'claude', text: 'As you asked.', release: {version: '1.2.0', change: false, state: 'asked', changes: [
            {field: 'version', to: '1.2.0'}, {field: 'branch', to: 'v1.2.0'}, {field: 'position', to: '2nd from the top'},
        ]}})
        expect(saved).toEqual([])
        await chats.answer('c1c2c3c4c5c6', fresh.id, true, owner)
        expect(saved).toEqual([{how: 'create', project: 'greenhouse', body: {version: '1.2.0', branch: 'v1.2.0', position: 1}, actor: {...owner, via: 'chat'}}])
        expect(messages.at(-1)!.text).toBe('(I allowed your request: release 1.2.0 is added.)')
        // A change shows each field from → to, its place too; asking again for the same release lets the one before go.
        const freeze = await chats.ask('c1c2c3c4c5c6', {version: '1.0.0', release: {frozen_on: null}})
        const ship = await chats.ask('c1c2c3c4c5c6', {version: '1.0.0', release: {shipped_on: '2026-10-29', position: 0}})
        expect(freeze.release!.state).toBe('expired')
        expect(ship.release).toMatchObject({version: '1.0.0', change: true, changes: [{field: 'shipped_on', from: null, to: '2026-10-29'}, {field: 'position', from: '2nd from the top', to: 'the top'}]})
        await chats.answer('c1c2c3c4c5c6', ship.id, false, owner)
        expect(saved).toHaveLength(1)
        expect(messages.at(-1)!.text).toMatch(/denied your request to change release 1.0.0: Shipped on to 2026-10-29, Place to the top: nothing changed/)
        // What it may not ask for, or what Releases would refuse, fails as it asks.
        for (const [body, status] of [[{release: {}}, 400], [{release: {version: '1.1.0'}}, 409], [{version: '0.9.0', release: {notes: 'X'}}, 404],
            [{version: '1.0.0', release: {issues: 3}}, 403], [{version: 1, release: {notes: 'X'}}, 400]] as const)
            await expect(chats.ask('c1c2c3c4c5c6', body)).rejects.toMatchObject({statusCode: status})
        expect(notes.map(n => n.kind)).toEqual(['chat.asked', 'chat.answered', 'chat.asked', 'chat.asked', 'chat.answered'])
    })

    it('asks to make a chunk or change one, and saves it as the owner\'s only once they allow it (ORR-510)', async () => {
        const notes: {kind: string}[] = []
        const made: unknown[][] = []
        const shelves = {id: '3', title: 'Shelves', summary: 'Everything on the shelves', priority: null}
        vi.stubGlobal('useStore', () => ({
            chunk: async (_project: string, id: string) => {
                if (id !== '3') throw Object.assign(new Error(`No chunk ${id}`), {statusCode: 404})
                return shelves
            },
            createChunk: async (project: string, body: {title: string}, actor: unknown) => (made.push(['create', project, body, actor]), {id: '7', title: body.title}),
            updateChunk: async (project: string, id: string, body: unknown) => (made.push(['update', project, id, body]), {...shelves, priority: 'P1'}),
            messageSession: async (project: string, target: string, text: string) => void messages.push({project, target, text}),
        }))
        vi.stubGlobal('useEventLog', () => ({note: (entry: {kind: string}) => notes.push(entry)}))
        vi.stubGlobal('conflict', (message: string) => Object.assign(new Error(message), {statusCode: 409}))
        vi.stubGlobal('forbidden', (message: string) => Object.assign(new Error(message), {statusCode: 403}))
        await chats.openChat('greenhouse')
        const fresh = await chats.ask('c1c2c3c4c5c6', {chunk: {title: 'Seed trays', priority: 'P2'}, why: 'As you asked.'})
        expect(fresh).toMatchObject({from: 'claude', text: 'As you asked.', chunk: {title: 'Seed trays', state: 'asked', changes: [{field: 'title', to: 'Seed trays'}, {field: 'priority', to: 'P2'}]}})
        expect(made).toEqual([])
        await chats.answer('c1c2c3c4c5c6', fresh.id, true, owner)
        expect(made).toEqual([['create', 'greenhouse', {title: 'Seed trays', priority: 'P2'}, {...owner, via: 'chat'}]])
        expect(chats.chatOf('c1c2c3c4c5c6').messages.find(m => m.id === fresh.id)!.chunk).toMatchObject({id: '7', state: 'allowed'})
        expect(messages.at(-1)!.text).toBe('(I allowed your request: chunk 7 ("Seed trays") is saved.)')
        // A change shows each field from → to; asking again for the same chunk lets the one before go.
        const first = await chats.ask('c1c2c3c4c5c6', {id: '3', chunk: {priority: 'P2'}})
        const second = await chats.ask('c1c2c3c4c5c6', {id: '3', chunk: {priority: 'P1'}})
        expect(first.chunk!.state).toBe('expired')
        expect(second.chunk).toMatchObject({id: '3', title: 'Shelves', changes: [{field: 'priority', from: null, to: 'P1'}]})
        await chats.answer('c1c2c3c4c5c6', second.id, false, owner)
        expect(made).toHaveLength(1)
        expect(messages.at(-1)!.text).toMatch(/denied your request to change chunk 3 .*nothing changed/)
        // What it may not ask for, or what the chunk routes would refuse, fails as it asks.
        for (const [body, status] of [[{chunk: {}}, 400], [{chunk: {title: 'X', position: 2}}, 403], [{chunk: {summary: 'No name'}}, 400],
            [{chunk: {title: 'X', priority: 'P9'}}, 400], [{id: '4', chunk: {priority: 'P1'}}, 404]] as const)
            await expect(chats.ask('c1c2c3c4c5c6', body)).rejects.toMatchObject({statusCode: status})
        expect(notes.map(n => n.kind)).toEqual(['chat.asked', 'chat.answered', 'chat.asked', 'chat.asked', 'chat.answered'])
    })

    it('makes what its session asks for with nobody on it, in Todo whatever status it asks for', () => {
        expect(chats.asChatIssue({title: 'Shelf labels', notes: 'From the chat', status: 'in-progress', assignee: 'claude', priority: 'P2', chunk: '3'}))
            .toEqual({title: 'Shelf labels', notes: 'From the chat', priority: 'P2', chunk: '3', status: 'todo'})
        for (const status of [undefined, 'backlog', 'done', 'canceled']) expect(chats.asChatIssue({title: 'Seed trays', status, plan: null})).toEqual({title: 'Seed trays', status: 'todo'})
    })

    it('lands what it makes where the owner picked for that chat, whatever status its session asks for', async () => {
        const chat = await chats.openChat('greenhouse', 'backlog')
        expect(chat.issues).toBe('backlog')
        expect(chats.asChatIssue({title: 'Seed trays', status: 'todo'}, chat.id)).toEqual({title: 'Seed trays', status: 'backlog'})
        expect(chats.landChatIssues(chat.id, 'todo')).toMatchObject({issues: 'todo'})
        expect(changes.at(-1)).toMatchObject({issues: 'todo'})
        expect(chats.asChatIssue({title: 'Grow lights', status: 'backlog'}, chat.id)).toEqual({title: 'Grow lights', status: 'todo'})
        // A chat it doesn't know (ended, or orrery restarted) lands in Todo.
        expect(chats.asChatIssue({title: 'Jars', status: 'backlog'}, 'gone')).toEqual({title: 'Jars', status: 'todo'})
    })

    it('reads where its issues land as todo or backlog, todo when not said', () => {
        expect(chats.chatIssuesOf(undefined)).toBe('todo')
        expect(chats.chatIssuesOf('backlog')).toBe('backlog')
        expect(() => chats.chatIssuesOf('in-progress')).toThrow(/"todo" or "backlog"/)
    })

    it("changes an issue's fields, but never its state of work", () => {
        vi.stubGlobal('forbidden', (message: string) => Object.assign(new Error(message), {statusCode: 403}))
        expect(chats.asChatEdit({priority: 'P0', labels: ['chat'], chunk: '3', release: '1.0.0', parent: null, title: 'Jars', notes: 'Glass'}))
            .toEqual({priority: 'P0', labels: ['chat'], chunk: '3', release: '1.0.0', parent: null, title: 'Jars', notes: 'Glass'})
        for (const field of ['status', 'assignee', 'proposal', 'project', 'position', 'plan', 'choices'])
            expect(() => chats.asChatEdit({priority: 'P1', [field]: 'x'})).toThrow(expect.objectContaining({statusCode: 403}))
        expect(() => chats.asChatEdit('P0')).toThrow(expect.objectContaining({statusCode: 400}))
    })

    it('leaves a proposal one, for the owner to decide', () => {
        expect(chats.asChatIssue({title: 'Grow lights', proposal: 'pending', status: 'todo', assignee: 'claude'})).toEqual({title: 'Grow lights', proposal: 'pending'})
    })
})

describe("the owner's chat moving issues", () => {
    let store: Store
    let notes: {kind: string, message: string}[]

    beforeEach(async () => {
        store = new Store(testDb())
        await store.nameOwner({name: 'Skoll'})
        const owner = {name: 'skoll', owner: true}
        await store.createProject({name: 'Greenhouse', key: 'GRE'}, owner)
        for (const title of ['Shelf labels', 'Grow lights', 'Water timer']) await store.createIssue('greenhouse', {title, status: 'todo'}, owner)
        await store.createIssue('greenhouse', {title: 'A greenhouse cat', proposal: 'pending'})
        store.messageSession = async (project: string, target: string, text: string) => void messages.push({project, target, text})
        notes = []
        vi.stubGlobal('useStore', () => store)
        vi.stubGlobal('useEventLog', () => ({note: (entry: {kind: string, message: string}) => notes.push(entry)}))
        vi.stubGlobal('conflict', (message: string) => Object.assign(new Error(message), {statusCode: 409}))
        vi.stubGlobal('forbidden', (message: string) => Object.assign(new Error(message), {statusCode: 403}))
        await chats.openChat('greenhouse')
    })

    const state = async (id: string) => {
        const issue = await store.issue('greenhouse', id)
        return [issue.column, issue.assignee ?? null]
    }

    it('asks with each from → to, and moves them as the owner only once they allow it', async () => {
        const asked = await chats.ask('c1c2c3c4c5c6', {move: {ids: ['GRE-1', 'GRE-2'], status: 'done', assignee: 'owner'}, why: 'Both shipped in #360.'})
        expect(asked).toMatchObject({text: 'Both shipped in #360.', move: {state: 'asked', body: {ids: ['GRE-1', 'GRE-2'], status: 'done', assignee: 'skoll'}, changes: [
            {issue: 'GRE-1', title: 'Shelf labels', field: 'status', from: 'todo', to: 'done'},
            {issue: 'GRE-1', title: 'Shelf labels', field: 'assignee', from: null, to: 'skoll'},
            {issue: 'GRE-2', title: 'Grow lights', field: 'status', from: 'todo', to: 'done'},
            {issue: 'GRE-2', title: 'Grow lights', field: 'assignee', from: null, to: 'skoll'},
        ]}})
        expect(await state('GRE-1')).toEqual(['todo', null])
        await chats.answer('c1c2c3c4c5c6', asked.id, true, {name: 'skoll', owner: true})
        expect([await state('GRE-1'), await state('GRE-2')]).toEqual([['done', 'skoll'], ['done', 'skoll']])
        expect((await store.listActivity('greenhouse', 'GRE-1')).at(-1)).toMatchObject({created_by: 'skoll', protected: true})
        expect(messages.at(-1)!.text).toBe('(I allowed your request: GRE-1, GRE-2 are now in done, assigned to skoll, saved.)')
        expect(notes.map(n => n.message)).toEqual(['The chat asked to put GRE-1, GRE-2 in done, assigned to skoll', "skoll allowed the chat's request to put GRE-1, GRE-2 in done, assigned to skoll"])
    })

    it('moves nothing when denied, and only what would change', async () => {
        await store.updateIssue('greenhouse', 'GRE-2', {status: 'backlog'}, {name: 'skoll', owner: true})
        const asked = await chats.ask('c1c2c3c4c5c6', {move: {ids: ['GRE-1', 'GRE-2'], status: 'backlog'}})
        expect(asked.move).toMatchObject({body: {ids: ['GRE-1'], status: 'backlog'}, changes: [{issue: 'GRE-1', from: 'todo', to: 'backlog'}]})
        await chats.answer('c1c2c3c4c5c6', asked.id, false, {name: 'skoll', owner: true})
        expect(await state('GRE-1')).toEqual(['todo', null])
        expect(messages.at(-1)!.text).toBe("(I denied your request to put GRE-1 in backlog: nothing changed.)")
        await expect(chats.ask('c1c2c3c4c5c6', {move: {ids: ['GRE-2'], status: 'backlog'}})).rejects.toMatchObject({statusCode: 409})
    })

    it("never asks to move a proposal waiting on the owner, nor a status that isn't one", async () => {
        await expect(chats.ask('c1c2c3c4c5c6', {move: {ids: ['GRE-1', 'GRE-4'], status: 'todo'}})).rejects.toMatchObject({statusCode: 403, message: expect.stringMatching(/GRE-4 is a proposal/)})
        await expect(chats.ask('c1c2c3c4c5c6', {move: {ids: ['GRE-1'], status: 'shipped'}})).rejects.toMatchObject({statusCode: 400})
        for (const move of [{ids: [], status: 'done'}, {ids: ['GRE-1']}, {ids: ['GRE-1'], assignee: 3}])
            await expect(chats.ask('c1c2c3c4c5c6', {move})).rejects.toMatchObject({statusCode: 400})
        await expect(chats.ask('c1c2c3c4c5c6', {move: {ids: ['GRE-9'], status: 'done'}})).rejects.toMatchObject({statusCode: 404})
    })

    it("shows no change on a request whose issues haven't moved", async () => {
        const asked = await chats.ask('c1c2c3c4c5c6', {move: {ids: ['GRE-1'], status: 'done'}})
        await store.updateIssue('greenhouse', 'GRE-1', {priority: 'P1'}, {name: 'skoll', owner: true})
        await chats.answer('c1c2c3c4c5c6', asked.id, true, {name: 'skoll', owner: true})
        expect(asked.move).toMatchObject({state: 'allowed'})
        expect(asked.move!.drifted).toBeUndefined()
        expect(messages.at(-1)!.text).toBe('(I allowed your request: GRE-1 is now in done, saved.)')
    })

    it('moves an issue that changed while it waited only once the owner has seen it and goes ahead anyway', async () => {
        const asked = await chats.ask('c1c2c3c4c5c6', {move: {ids: ['GRE-1', 'GRE-2'], status: 'todo', assignee: 'claude'}})
        await store.updateIssue('greenhouse', 'GRE-1', {status: 'done'}, {name: 'skoll', owner: true})
        const told = messages.length
        await chats.answer('c1c2c3c4c5c6', asked.id, true, {name: 'skoll', owner: true})
        expect(asked.move).toMatchObject({state: 'asked', drifted: [{issue: 'GRE-1', field: 'status', from: 'todo', to: 'done'}]})
        expect(await state('GRE-1')).toEqual(['done', null])
        expect(await state('GRE-2')).toEqual(['todo', null])
        expect(messages.length).toBe(told)
        // Changed further since it was shown: it shows that, and still waits.
        await store.updateIssue('greenhouse', 'GRE-2', {assignee: 'freya'}, {name: 'skoll', owner: true})
        await chats.answer('c1c2c3c4c5c6', asked.id, true, {name: 'skoll', owner: true}, true)
        expect(asked.move).toMatchObject({state: 'asked', drifted: [{issue: 'GRE-1', field: 'status'}, {issue: 'GRE-2', field: 'assignee', from: null, to: 'freya'}]})
        expect(await state('GRE-2')).toEqual(['todo', 'freya'])
        await chats.answer('c1c2c3c4c5c6', asked.id, true, {name: 'skoll', owner: true}, true)
        expect(asked.move!.state).toBe('allowed')
        expect([await state('GRE-1'), await state('GRE-2')]).toEqual([['todo', 'claude'], ['todo', 'claude']])
        expect(messages.at(-1)!.text).toBe('(I allowed your request: GRE-1, GRE-2 are now in todo, assigned to claude, saved. Before that, GRE-1 was in todo when you asked and is in done now. GRE-2 was assigned to nobody when you asked and is assigned to freya now.)')
    })

    it('tells the session what had changed when the owner denies it, and shows the change as it happens', async () => {
        const asked = await chats.ask('c1c2c3c4c5c6', {move: {ids: ['GRE-1'], status: 'backlog'}})
        await store.updateIssue('greenhouse', 'GRE-1', {status: 'done'}, {name: 'skoll', owner: true})
        chats.heardForMoves({event: {type: 'issue.status', project: 'greenhouse', subject: 'GRE-1'} as never})
        await vi.waitFor(() => expect(asked.move!.drifted).toEqual([{issue: 'GRE-1', field: 'status', from: 'todo', to: 'done'}]))
        await chats.answer('c1c2c3c4c5c6', asked.id, false, {name: 'skoll', owner: true})
        expect(asked.move!.state).toBe('denied')
        expect(messages.at(-1)!.text).toBe('(I denied your request to put GRE-1 in backlog: nothing changed. GRE-1 was in todo when you asked and is in done now.)')
    })

    it('still denies a request whose issue has been deleted', async () => {
        const asked = await chats.ask('c1c2c3c4c5c6', {move: {ids: ['GRE-1'], status: 'backlog'}})
        await store.deleteIssue('greenhouse', 'GRE-1', {name: 'skoll', owner: true})
        await chats.answer('c1c2c3c4c5c6', asked.id, false, {name: 'skoll', owner: true})
        expect(asked.move!.state).toBe('denied')
    })

    it('takes the warning away when the issue goes back as it was', async () => {
        const asked = await chats.ask('c1c2c3c4c5c6', {move: {ids: ['GRE-1'], status: 'backlog'}})
        await store.updateIssue('greenhouse', 'GRE-1', {status: 'done'}, {name: 'skoll', owner: true})
        await chats.answer('c1c2c3c4c5c6', asked.id, true, {name: 'skoll', owner: true})
        await store.updateIssue('greenhouse', 'GRE-1', {status: 'todo'}, {name: 'skoll', owner: true})
        await chats.answer('c1c2c3c4c5c6', asked.id, true, {name: 'skoll', owner: true})
        expect(asked.move!.drifted).toBeUndefined()
        expect(asked.move!.state).toBe('allowed')
    })

    const skoll = {name: 'skoll', owner: true}
    const chatId = 'c1c2c3c4c5c6'

    it('holds a setting that changed while it waited until the owner goes ahead anyway', async () => {
        const asked = await chats.ask(chatId, {setting: 'tint', value: 'teal'})
        await store.updateSettings({tint: 'rose'}, skoll)
        await chats.answer(chatId, asked.id, true, skoll)
        expect(asked.request).toMatchObject({state: 'asked', drifted: [{label: 'Background tint', from: '(none)', to: 'rose'}]})
        expect((await store.settings()).tint).toBe('rose')
        await chats.answer(chatId, asked.id, true, skoll, true)
        expect(asked.request!.state).toBe('allowed')
        expect((await store.settings()).tint).toBe('teal')
        expect(messages.at(-1)!.text).toBe('(That had changed since you asked: Background tint was (none) and is rose now.)')
    })

    it('holds a chunk change the same way, and tells the session on Deny too', async () => {
        const {id} = await store.createChunk('greenhouse', {title: 'Shelves'}, skoll)
        const asked = await chats.ask(chatId, {id, chunk: {title: 'Racks'}})
        await store.updateChunk('greenhouse', id, {title: 'Benches'})
        await chats.answer(chatId, asked.id, true, skoll)
        expect(asked.chunk).toMatchObject({state: 'asked', drifted: [{label: 'Name', from: 'Shelves', to: 'Benches'}]})
        expect((await store.chunk('greenhouse', id)).title).toBe('Benches')
        await chats.answer(chatId, asked.id, false, skoll)
        expect(asked.chunk!.state).toBe('denied')
        expect(messages.at(-1)!.text).toBe('(That had changed since you asked: Name was Shelves and is Benches now.)')
    })

    it('holds a release change the same way, and asks nothing of one that is new', async () => {
        await store.updateProject('greenhouse', {release_mode: 'own'}, skoll)
        await store.createRelease('greenhouse', {version: '1.0.0'}, skoll)
        const asked = await chats.ask(chatId, {version: '1.0.0', release: {branch: 'v1'}})
        await store.updateRelease('greenhouse', '1.0.0', {branch: 'v2'}, skoll)
        await chats.answer(chatId, asked.id, true, skoll)
        expect(asked.release).toMatchObject({state: 'asked', drifted: [{label: 'Branch', from: '(none)', to: 'v2'}]})
        await chats.answer(chatId, asked.id, true, skoll, true)
        expect((await store.listReleases('greenhouse')).find(r => r.version === '1.0.0')!.branch).toBe('v1')
        const fresh = await chats.ask(chatId, {release: {version: '2.0.0'}})
        await chats.answer(chatId, fresh.id, true, skoll)
        expect(fresh.release).toMatchObject({state: 'allowed'})
        expect(fresh.release!.drifted).toBeUndefined()
    })

    it('holds a schedule change the same way', async () => {
        const nightly = {id: 3, title: 'Nightly', cron: '0 2 * * *', presets: []}
        const updated: unknown[] = []
        vi.stubGlobal('useScheduler', () => ({
            get: async () => nightly,
            check: async () => {},
            update: async (_project: string, _id: number, body: unknown) => (updated.push(body), {...nightly, ...body as object, enabled: true}),
        }))
        const asked = await chats.ask(chatId, {id: 3, schedule: {cron: '0 3 * * *'}})
        nightly.cron = '0 4 * * *'
        await chats.answer(chatId, asked.id, true, skoll)
        expect(asked.schedule).toMatchObject({state: 'asked', drifted: [{label: 'Cron', from: '0 2 * * *', to: '0 4 * * *'}]})
        expect(updated).toEqual([])
        await chats.answer(chatId, asked.id, true, skoll, true)
        expect(updated).toEqual([{cron: '0 3 * * *'}])
    })

    it('saves a request as before when nothing has changed', async () => {
        const asked = await chats.ask(chatId, {setting: 'tint', value: 'teal'})
        await chats.answer(chatId, asked.id, true, skoll)
        expect(asked.request!.state).toBe('allowed')
        expect(asked.request!.drifted).toBeUndefined()
        expect(messages.at(-1)!.text).not.toContain('changed since')
    })

    it('keeps those moved when one fails on Allow, and moves only the rest when allowed again', async () => {
        const asked = await chats.ask('c1c2c3c4c5c6', {move: {ids: ['GRE-1', 'GRE-3'], assignee: 'claude'}})
        // Asking again for one of them lets the one before go.
        const again = await chats.ask('c1c2c3c4c5c6', {move: {ids: ['GRE-1', 'GRE-3'], assignee: 'claude'}})
        expect(chats.chatOf('c1c2c3c4c5c6').messages.find(m => m.id === asked.id)!.move!.state).toBe('expired')
        await store.updateIssue('greenhouse', 'GRE-3', {proposal: 'pending'}, {name: 'skoll', owner: true})
        await expect(chats.answer('c1c2c3c4c5c6', again.id, true, {name: 'skoll', owner: true})).rejects.toMatchObject({statusCode: 403})
        expect(chats.chatOf('c1c2c3c4c5c6').messages.find(m => m.id === again.id)!.move).toMatchObject({state: 'asked', moved: ['GRE-1']})
        expect(await state('GRE-1')).toEqual(['todo', 'claude'])
        await store.updateIssue('greenhouse', 'GRE-3', {proposal: null}, {name: 'skoll', owner: true})
        // Putting it up as a proposal assigned it to the owner, so that's shown first; GRE-1, moved already, isn't.
        await chats.answer('c1c2c3c4c5c6', again.id, true, {name: 'skoll', owner: true})
        expect(chats.chatOf('c1c2c3c4c5c6').messages.find(m => m.id === again.id)!.move!.drifted).toEqual([{issue: 'GRE-3', field: 'assignee', from: null, to: 'skoll'}])
        await chats.answer('c1c2c3c4c5c6', again.id, true, {name: 'skoll', owner: true}, true)
        expect(await state('GRE-3')).toEqual(['todo', 'claude'])
    })
})

describe("a chat session's writes", () => {
    type Event = {method: string, path: string, headers: Record<string, string>}
    let guard: (event: Event) => Promise<void>

    beforeEach(async () => {
        vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
        vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
        vi.stubGlobal('chatSession', () => false)
        vi.stubGlobal('chatWrite', (event: Event) => event.headers['orrery-chat'] === 'yes')
        vi.stubGlobal('forbidden', (message: string) => Object.assign(new Error(message), {statusCode: 403}))
        vi.resetModules()
        guard = (await import('../server/middleware/chat')).default as unknown as typeof guard
    })

    const refused = async (method: string, path: string, chat = true) => {
        try {
            await guard({method, path, headers: chat ? {'orrery-chat': 'yes'} : {}})
        } catch (error) {
            return (error as {statusCode: number}).statusCode
        }
    }

    it('make issues, comment, answer in the chat, ask the owner for things, and read anything; nothing else', async () => {
        expect(await refused('POST', '/api/projects/greenhouse/issues')).toBeUndefined()
        // It asks to message sessions (a request); only the owner's Send sends it (ORR-416).
        expect(await refused('POST', '/api/sessions/message')).toBe(403)
        expect(await refused('POST', '/api/projects/greenhouse/sessions/abc/message')).toBe(403)
        expect(await refused('POST', '/api/projects/greenhouse/sessions/abc/stop')).toBe(403)
        expect(await refused('POST', '/api/projects/greenhouse/launches')).toBe(403)
        // A chunk only through the owner's Allow (ORR-510), never made or changed straight.
        expect(await refused('POST', '/api/projects/greenhouse/chunks')).toBe(403)
        expect(await refused('PATCH', '/api/projects/greenhouse/chunks/3')).toBe(403)
        // It asks to change a setting or send a message; the owner's answer, and the settings themselves, aren't its.
        expect(await refused('POST', '/api/chats/c1c2c3c4c5c6/requests')).toBeUndefined()
        expect(await refused('POST', '/api/chats/c1c2c3c4c5c6/requests/4')).toBe(403)
        expect(await refused('PATCH', '/api/settings')).toBe(403)
        expect(await refused('POST', '/api/database/move')).toBe(403)
        expect(await refused('PUT', '/api/secrets/GITHUB')).toBe(403)
        expect(await refused('POST', '/api/projects/greenhouse/issues/GRE-4/comments')).toBeUndefined()
        expect(await refused('POST', '/api/chats/c1c2c3c4c5c6/replies')).toBeUndefined()
        expect(await refused('POST', '/api/chats/c1c2c3c4c5c6/clear')).toBe(403)
        expect(await refused('GET', '/api/projects/greenhouse/docs')).toBeUndefined()
        expect(await refused('PATCH', '/api/projects/greenhouse/issues/GRE-4')).toBeUndefined()
        expect(await refused('PATCH', '/api/projects/greenhouse/issues/GRE-4/comments/3')).toBe(403)
        expect(await refused('POST', '/api/projects/greenhouse/issues/GRE-4/focus')).toBe(403)
        expect(await refused('PUT', '/api/projects/greenhouse/docs/shelving')).toBe(403)
        expect(await refused('POST', '/api/egress')).toBe(403)
        expect(await refused('POST', '/api/chats/c1c2c3c4c5c6/messages')).toBe(403)
        expect(await refused('PATCH', '/api/chats/c1c2c3c4c5c6')).toBe(403)
        // Anyone else's go on to their own checks.
        expect(await refused('PATCH', '/api/projects/greenhouse/issues/GRE-4', false)).toBeUndefined()
    })
})
