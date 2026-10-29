import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
// @ts-expect-error: the channel is plain JavaScript, run by node from other repos
import {instructionsFor} from '../../channel/instructions.mjs'
// @ts-expect-error: the channel is plain JavaScript, run by node from other repos
import {toolsFor} from '../../channel/tools.mjs'
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
        const work = ['issues', 'issue', 'create_issue', 'update_issue', 'start_issue', 'finish_issue', 'comment', 'chunks', 'releases', 'docs', 'doc',
            'write_doc', 'presets', 'preset', 'schedules', 'sessions', 'secrets', 'egress', 'events', 'guide', 'resolve_event']
        expect(tools(['greenhouse']).map(t => t.name)).toEqual(work)
        expect(tools(['greenhouse'], {untrusted: true}).map(t => t.name)).toEqual([...work, 'github_issues'])
        expect(tools(['greenhouse'], {chat: true}).map(t => t.name)).toEqual(['issues', 'issue', 'create_issue', 'comment', 'chunks', 'releases', 'docs',
            'doc', 'presets', 'preset', 'schedules', 'sessions', 'events', 'guide', 'start_session', 'stop_session', 'extend_session', 'reply',
            'edit_issue', 'move_issues', 'image', 'message_sessions', 'update_settings', 'create_schedule', 'update_schedule', 'create_release',
            'update_release', 'create_chunk', 'update_chunk', 'message_session'])
    })

    it('stays within its budget, for one project and for several', () => {
        expect(size(tools(['greenhouse']))).toBeLessThanOrEqual(11_400)
        expect(size(tools(['greenhouse', 'pantry']))).toBeLessThanOrEqual(12_900)
        expect(size(tools(['greenhouse'], {untrusted: true}))).toBeLessThanOrEqual(12_000)
        expect(size(tools(['greenhouse'], {chat: true}))).toBeLessThanOrEqual(21_400)
        expect(size(tools(['greenhouse', 'pantry'], {chat: true}))).toBeLessThanOrEqual(22_700)
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
        expect(size(instructionsFor({base, serves: 'project "greenhouse"'}))).toBeLessThanOrEqual(2_000)
        expect(size(instructionsFor({base, serves: 'projects "greenhouse", "pantry"', several: true}))).toBeLessThanOrEqual(2_100)
        expect(size(instructionsFor({base, serves: 'project "greenhouse"', chat: true}))).toBeLessThanOrEqual(1_100)
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
