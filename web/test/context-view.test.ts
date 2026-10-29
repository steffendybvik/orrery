import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
// @ts-expect-error: the channel is plain JavaScript, run by node from other repos
import {instructionsFor} from '../../channel/instructions.mjs'
// @ts-expect-error: as above
import {toolsFor} from '../../channel/tools.mjs'

// What orrery puts into a session's context, part by part (ORR-549), with Nitro's auto-imports stubbed: the session as
// it is, and the context it was started with.
let view: typeof import('../server/utils/context-view')
let session: {project: string, also?: string[], started?: {launch: string}} | undefined
let chat: boolean
let untrusted: boolean

beforeEach(async () => {
    session = {project: 'orrery', started: {launch: 'l1'}}
    chat = false
    untrusted = false
    vi.stubGlobal('sessionNow', () => session)
    vi.stubGlobal('chatSession', () => chat)
    vi.stubGlobal('untrustedSession', () => untrusted)
    vi.stubGlobal('currentId', (id: string) => id)
    vi.stubGlobal('launchContext', () => ({presets: ['Review'], text: 'Review the open PRs.'}))
    vi.stubGlobal('contextBlock', (context: {text: string}) => `Started with: ${context.text}`)
    vi.resetModules()
    view = await import('../server/utils/context-view')
})

afterEach(() => vi.unstubAllGlobals())

describe('the context view', () => {
    it("shows a work session the channel's own instructions and tools, each with its size, biggest tool first", () => {
        const work = view.contextView('work', ['orrery'], 'http://o')
        expect(work.parts[0]).toMatchObject({id: 'instructions', text: instructionsFor({base: 'http://o', projects: ['orrery']})})
        const tools = work.parts.filter(p => p.group === 'tools')
        expect(tools.map(t => t.title).sort()).toEqual(toolsFor(['orrery']).map((t: {name: string}) => t.name).sort())
        expect(tools.map(t => t.chars)).toEqual(tools.map(t => t.chars).toSorted((a, b) => b - a))
        for (const p of work.parts) expect(p).toMatchObject({chars: p.text.length, tokens: Math.ceil(p.text.length / 4)})
        expect(work.chars).toBe(work.parts.reduce((sum, p) => sum + p.chars, 0))
        expect(work.parts.some(p => p.group === 'start')).toBe(false)
    })

    it("gives the chat and an untrusted run their own tools and the chat its own instructions", () => {
        const names = (kind: 'chat' | 'untrusted') => view.contextView(kind, ['orrery'], 'http://o').parts.filter(p => p.group === 'tools').map(p => p.title).sort()
        expect(names('chat')).toEqual(toolsFor(['orrery'], {chat: true}).map((t: {name: string}) => t.name).sort())
        expect(names('untrusted')).toEqual(toolsFor(['orrery'], {untrusted: true}).map((t: {name: string}) => t.name).sort())
        expect(view.contextView('chat', ['orrery'], 'http://o').parts[0]!.text).toContain("owner's chat")
    })

    it('shows a running session its kind, the projects it hears and the context it was started with', () => {
        session = {project: 'orrery', also: ['hub'], started: {launch: 'l1'}}
        chat = true
        const running = view.sessionContextView('s1', 'http://o')!
        expect(running).toMatchObject({kind: 'chat', projects: ['orrery', 'hub'], session: 's1'})
        expect(running.parts.at(-1)).toMatchObject({id: 'start', text: 'Started with: Review the open PRs.'})
        session = undefined
        expect(view.sessionContextView('gone', 'http://o')).toBeUndefined()
    })
})
