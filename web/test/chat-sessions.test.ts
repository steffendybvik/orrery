import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// The owner's chat asking to start, stop or give more time to a session (ORR-509), with Nitro's auto-imports stubbed:
// nothing happens until the owner allows it, and then it's done as theirs, through the chat, as the page would.
let chats: typeof import('../server/utils/chats')
let messages: {target: string, text: string}[]
let started: {project: string, issue?: string, statuses?: string[], release?: string, context?: {presets: string[]}, via?: string}[]
let stopped: {project: string, id: string}[]
let extended: {project: string, launch: string, minutes: number}[]
type Listed = {id: string, project: string, name: string, state: string, listening: boolean, reachable?: boolean, chat?: boolean, started?: {launch: string, stops_at?: string}}
let listed: Listed[]

const error = (statusCode: number) => (message: string) => Object.assign(new Error(message), {statusCode})

beforeEach(async () => {
    messages = []
    started = []
    stopped = []
    extended = []
    listed = [
        {id: 'abc', project: 'greenhouse', name: 'Nordre', state: 'idle', listening: true, started: {launch: 'l1', stops_at: '2999-01-01T10:00:00.000Z'}},
        {id: 'def', project: 'greenhouse', name: 'Sudri', state: 'working', listening: true, reachable: true},
        {id: 'ghi', project: 'greenhouse', name: 'Austri', state: 'idle', listening: false},
        {id: 'c1c2c3c4c5c6', project: 'greenhouse', name: 'Chat', state: 'idle', listening: true, chat: true},
    ]
    vi.stubGlobal('projectEvents', new EventEmitter())
    vi.stubGlobal('startChat', async (project: string) => ({id: 'c1c2c3c4c5c6', project}))
    vi.stubGlobal('launchTarget', (id: string) => `launch-${id}`)
    vi.stubGlobal('useStore', () => ({
        messageSession: async (_project: string, target: string, text: string) => void messages.push({target, text}),
        projectId: async (id: string) => {
            if (!['greenhouse', 'pantry'].includes(id)) throw error(404)(`No project ${id}`)
            return id
        },
    }))
    vi.stubGlobal('useEventLog', () => ({note: () => {}}))
    for (const [name, code] of [['notFound', 404], ['badRequest', 400], ['conflict', 409], ['forbidden', 403]] as const) vi.stubGlobal(name, error(code))
    vi.stubGlobal('currentId', (id: string) => id)
    vi.stubGlobal('listSessions', () => listed)
    vi.stubGlobal('chatSession', (id: string) => !!listed.find(s => s.id === id)?.chat)
    vi.stubGlobal('contextFor', async (_project: string, presets: number[], instructions: string) => {
        if (presets.some(p => p !== 3)) throw error(400)(`No preset ${presets.join(', ')}`)
        return presets.length || instructions ? {presets: presets.map(() => 'Review'), text: instructions} : undefined
    })
    vi.stubGlobal('startLaunch', async (project: string, {actor, ...focus}: {actor: {via?: string}, issue?: string}) => {
        started.push({project, ...focus, via: actor.via})
        return {id: 'new1'}
    })
    vi.stubGlobal('stopSession', (project: string, id: string) => void stopped.push({project, id}))
    vi.stubGlobal('extendLaunchBy', (project: string, launch: string, minutes: number) => void extended.push({project, launch, minutes}))
    vi.resetModules()
    // The real check, as Start session's route makes it: launches.ts needs its counters to load.
    vi.stubGlobal('counter', (await import('../server/utils/events')).counter)
    vi.stubGlobal('startInput', (await import('../server/utils/launches')).startInput)
    chats = await import('../server/utils/chats')
    await chats.openChat('greenhouse')
})

afterEach(() => vi.unstubAllGlobals())

const owner = {name: 'skoll', owner: true}
const CHAT = 'c1c2c3c4c5c6'

describe('a session the chat asks about', () => {
    it('starts only on Allow, as Start session would, as the owner through the chat', async () => {
        const asked = await chats.ask(CHAT, {session: {action: 'start', issue: 'GRE-4', presets: [3], instructions: 'Keep it small.'}, why: 'You asked for one on GRE-4.'})
        expect(asked.session).toEqual({action: 'start', project: 'greenhouse', start: {issue: 'GRE-4', presets: [3], instructions: 'Keep it small.'}, presets: ['Review'], state: 'asked'})
        expect(asked.text).toBe('You asked for one on GRE-4.')
        expect(started).toEqual([])
        await chats.answer(CHAT, asked.id, true, owner)
        expect(started).toEqual([{project: 'greenhouse', issue: 'GRE-4', context: {presets: ['Review'], text: 'Keep it small.'}, via: 'chat'}])
        expect(asked.session).toMatchObject({state: 'allowed', launch: 'new1'})
        expect(messages.at(-1)).toEqual({target: `launch-${CHAT}`, text: '(I allowed your request: a session is starting on greenhouse.)'})
    })

    it('starts nothing when denied, and checks what it asks as the page would', async () => {
        const asked = await chats.ask(CHAT, {session: {action: 'start', project: 'pantry', statuses: ['todo'], release: '1.0.0'}})
        expect(asked.session).toMatchObject({project: 'pantry', start: {statuses: ['todo'], release: '1.0.0'}})
        await chats.answer(CHAT, asked.id, false, owner)
        expect(started).toEqual([])
        expect(messages.at(-1)!.text).toBe("(I denied your request to start a session on pantry, working through todo in 1.0.0: nothing happened.)")
        await expect(chats.ask(CHAT, {session: {action: 'start', issue: 'GRE-4', statuses: ['todo']}})).rejects.toMatchObject({statusCode: 400})
        await expect(chats.ask(CHAT, {session: {action: 'start', presets: [9]}})).rejects.toMatchObject({statusCode: 400})
        await expect(chats.ask(CHAT, {session: {action: 'start', project: 'nowhere'}})).rejects.toMatchObject({statusCode: 404})
        await expect(chats.ask(CHAT, {session: {action: 'watch', name: 'Nordre'}})).rejects.toMatchObject({statusCode: 400})
    })

    it('stops one by its name on Allow, and not a chat, nor one nothing can reach', async () => {
        const asked = await chats.ask(CHAT, {session: {action: 'stop', name: 'sudri'}})
        expect(asked.session).toEqual({action: 'stop', project: 'greenhouse', session: 'def', name: 'Sudri', state: 'asked'})
        await chats.answer(CHAT, asked.id, true, owner)
        expect(stopped).toEqual([{project: 'greenhouse', id: 'def'}])
        expect(messages.at(-1)!.text).toBe('(I allowed your request: Sudri is stopping.)')
        await expect(chats.ask(CHAT, {session: {action: 'stop', name: 'Chat'}})).rejects.toMatchObject({statusCode: 404})
        await expect(chats.ask(CHAT, {session: {action: 'stop', name: 'Austri'}})).rejects.toMatchObject({statusCode: 409})
    })

    it('gives one orrery started more time on Allow, 30 minutes unless it says, and an earlier ask about it expires', async () => {
        const first = await chats.ask(CHAT, {session: {action: 'extend', name: 'Nordre'}})
        expect(first.session).toMatchObject({minutes: 30})
        const second = await chats.ask(CHAT, {session: {action: 'extend', name: 'Nordre', minutes: 60}})
        expect(first.session!.state).toBe('expired')
        await chats.answer(CHAT, second.id, true, owner)
        expect(extended).toEqual([{project: 'greenhouse', launch: 'l1', minutes: 60}])
        await expect(chats.ask(CHAT, {session: {action: 'extend', name: 'Sudri'}})).rejects.toMatchObject({statusCode: 409})
        await expect(chats.ask(CHAT, {session: {action: 'extend', name: 'Nordre', minutes: 0}})).rejects.toMatchObject({statusCode: 400})
    })
})
