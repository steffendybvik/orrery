import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
// @ts-expect-error: the channel is plain JavaScript, run by node from other repos
import {instructionsFor} from '../../channel/instructions.mjs'
// @ts-expect-error: the channel is plain JavaScript, run by node from other repos
import {toolsFor} from '../../channel/tools.mjs'
import {chatBrief} from '../server/utils/chats'
import {signalPayload} from '../server/utils/signal-payload'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// How much context orrery adds to a session (ORR-548): what Claude carries on every turn (the tool list, the server's
// instructions) and what each signal brings. Sizes are in characters (a token is about four). Each budget is set just
// above today's size, so growing one is a deliberate change that shows in review; lower it as cuts land (ORR-542).
type Tool = {name: string, description: string, inputSchema: {properties?: Record<string, {description?: string}>}}

const size = (value: unknown) => typeof value === 'string' ? value.length : JSON.stringify(value).length
const tools = (projects: string[], options: object = {}) => toolsFor(projects, options) as Tool[]

describe('the tool list a session carries on every turn', () => {
    it('gives each kind of session these tools, so adding one is a choice', () => {
        // The chat's planning reads (chunks, presets, preset, schedules) are the chat's alone (ORR-544).
        // A work session's rarer tools (asking for a schedule, secrets and egress, the event log) wait behind more_tools
        // (ORR-625), and come in its list once it asks for their group.
        const work = ['issues', 'issue', 'create_issue', 'update_issue', 'start_issue', 'finish_issue', 'comment', 'releases', 'docs', 'doc',
            'write_doc', 'sessions', 'guide']
        expect(tools(['greenhouse']).map(t => t.name)).toEqual([...work, 'more_tools'])
        expect(tools(['greenhouse'], {loaded: ['schedules', 'secrets', 'debug']}).map(t => t.name)).toEqual(['issues', 'issue', 'create_issue',
            'update_issue', 'start_issue', 'finish_issue', 'comment', 'releases', 'docs', 'doc', 'write_doc', 'sessions', 'secrets', 'egress',
            'events', 'guide', 'resolve_event', 'create_schedule', 'update_schedule'])
        expect(tools(['greenhouse'], {loaded: ['debug']}).map(t => t.name)).toEqual([...work.slice(0, -1), 'events', 'guide', 'resolve_event', 'more_tools'])
        // An untrusted one has only what orrery lets it do: read, raise proposals and comment on them, and read GitHub issues.
        expect(tools(['greenhouse'], {untrusted: true}).map(t => t.name)).toEqual(['issues', 'issue', 'create_issue', 'comment', 'releases', 'docs',
            'doc', 'sessions', 'guide', 'github_issues'])
        // The chat's requests (sessions, messages, settings, schedules, releases, chunks) sit behind request and
        // request_fields, read when it needs one (ORR-624).
        expect(tools(['greenhouse'], {chat: true}).map(t => t.name)).toEqual(['issues', 'issue', 'create_issue', 'comment', 'chunks', 'releases', 'docs',
            'doc', 'presets', 'preset', 'schedules', 'sessions', 'events', 'guide', 'reply', 'edit_issue', 'move_issues', 'image', 'request', 'request_fields'])
    })

    it('stays within its budget, for one project and for several', () => {
        // A work session's and an untrusted run's were cut by a third and more (ORR-625): 9,708 and 9,444 before.
        expect(size(tools(['greenhouse']))).toBeLessThanOrEqual(6_000)
        expect(size(tools(['greenhouse', 'pantry']))).toBeLessThanOrEqual(6_900)
        expect(size(tools(['greenhouse'], {loaded: ['schedules', 'secrets', 'debug']}))).toBeLessThanOrEqual(8_900)
        expect(size(tools(['greenhouse'], {untrusted: true}))).toBeLessThanOrEqual(4_500)
        // The chat's fell from about 20,100 when its requests went behind request (ORR-624).
        expect(size(tools(['greenhouse'], {chat: true}))).toBeLessThanOrEqual(8_900)
        expect(size(tools(['greenhouse', 'pantry'], {chat: true}))).toBeLessThanOrEqual(10_100)
    })

    it('has no description, of a tool or of its arguments, longer than a short paragraph', () => {
        for (const chat of [false, true]) {
            for (const tool of tools(['greenhouse'], {chat})) {
                expect(tool.description.length, tool.name).toBeLessThanOrEqual(480)
                for (const [name, argument] of Object.entries(tool.inputSchema.properties ?? {})) {
                    expect(argument.description?.length ?? 0, `${tool.name}.${name}`).toBeLessThanOrEqual(480)
                }
            }
        }
    })
})

describe("the server's instructions a session carries on every turn", () => {
    const base = 'http://localhost:9000'

    it('stay within their budget, for a work session and for the chat', () => {
        expect(size(instructionsFor({base, serves: 'project "greenhouse"'}))).toBeLessThanOrEqual(1_100)
        expect(size(instructionsFor({base, serves: 'projects "greenhouse", "pantry"', several: true}))).toBeLessThanOrEqual(1_250)
        // The chat's grew by the asking rule its tools no longer each repeat (ORR-624).
        expect(size(instructionsFor({base, serves: 'project "greenhouse"', chat: true}))).toBeLessThanOrEqual(1_300)
        expect(size(instructionsFor({base, serves: 'project "greenhouse"', untrusted: true}))).toBeLessThanOrEqual(420)
    })

    it("and the chat's brief, its start context, says only what they don't (ORR-624)", () => {
        // It was about 3,500 when it repeated the instructions and every tool's asking.
        expect(size(chatBrief('greenhouse'))).toBeLessThanOrEqual(650)
    })

    it('tell several projects apart only when there are several', () => {
        expect(instructionsFor({base, serves: 'project "greenhouse"'})).not.toContain('HUB-12')
        expect(instructionsFor({base, serves: 'projects "greenhouse", "pantry"', several: true})).toContain('HUB-12')
    })
})

describe('what a signal brings', () => {
    const me = {name: 'skoll', owner: true}
    const api = 'http://orrery.test/api/projects/shop'
    let store: Store

    beforeEach(async () => {
        store = new Store(testDb())
        await store.createProject({name: 'shop', key: 'SHO', release_mode: 'own'}, me)
        await store.createIssue('shop', {title: 'Pay with cards', priority: 'P2', status: 'todo', notes: 'Card payments at the till.'}, me)
        vi.stubGlobal('useScheduler', () => ({get: async () => ({id: 7, title: 'Nightly triage'})}))
    })

    afterEach(() => vi.unstubAllGlobals())

    it('stays within its budget besides what the owner wrote, for a message and a focus', async () => {
        const words = 'Wrap up first.'
        const message = await signalPayload(store, 'shop', await store.messageSession('shop', 's-1', words, {...me, via: 'chat'}), {api})
        expect(size(message) - words.length).toBeLessThanOrEqual(320)
        const focus = await signalPayload(store, 'shop', await store.focus('shop', 'SHO-1', {note: words}, me), {api})
        expect(size(focus) - words.length).toBeLessThanOrEqual(540)
    })
})
