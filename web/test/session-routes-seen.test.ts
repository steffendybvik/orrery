import type {H3Event} from 'h3'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// The session routes name their project in the body, or by the session (ORR-1373), so the path's guards don't hold
// them, and `needsBoard` lets the server's owner onto any board. A hook's report on a project in another workspace, and
// a channel's tool call for a session that isn't here or is on such a project, are answered as for one that isn't here,
// before anything is registered or kept.
const WORKSPACES: Record<string, string> = {rockets: 'default', acme: 'theirs'}
type Who = {person: string, owner: boolean, via: 'browser' | 'agent'}
const OWNER: Who = {person: 'sam-sessions', owner: true, via: 'browser'}
const MEMBER: Who = {person: 'bo-sessions', owner: false, via: 'agent'}
const eventOf = (body: unknown, who?: Who, params: Record<string, string> = {}) =>
    ({body, headers: {}, params, context: {who}}) as unknown as H3Event
let reported: Record<string, unknown>[]
let noted: string[]
let sessions: {id: string, project: string}[]

beforeEach(async () => {
    reported = []
    noted = []
    sessions = [{id: 's-ours', project: 'rockets'}, {id: 's-theirs', project: 'acme'}]
    const error = (statusCode: number) => (message: string) => Object.assign(new Error(message), {statusCode})
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', async (event: {body: unknown}) => event.body)
    vi.stubGlobal('getHeader', (event: {headers: Record<string, string>}, name: string) => event.headers[name])
    vi.stubGlobal('sessionHeader', () => undefined)
    vi.stubGlobal('param', (event: {params: Record<string, string>}, name: string) => event.params[name])
    vi.stubGlobal('badRequest', error(400))
    vi.stubGlobal('notFound', error(404))
    vi.stubGlobal('createError', (e: {statusCode: number, message: string}) => Object.assign(new Error(e.message), e))
    vi.stubGlobal('setResponseStatus', () => {})
    // The owner is on every board, as `onBoard` has it: this guard alone would let them through.
    vi.stubGlobal('needsBoard', async () => {})
    vi.stubGlobal('holdSession', async () => {})
    // Asked as the caller, the API lists the projects of the workspaces they're in: here only `default`'s.
    vi.stubGlobal('readAsAsker', async () => [{id: 'rockets'}])
    vi.stubGlobal('useStore', () => ({
        projectId: async (id: string) => {
            if (!(id in WORKSPACES)) throw error(404)(`No project "${id}"`)
            return id
        },
        projectWorkspace: async (id: string) => WORKSPACES[id],
    }))
    vi.stubGlobal('launchUntrusted', () => false)
    vi.stubGlobal('report', (input: Record<string, unknown>) => {
        reported.push(input)
        return {id: input.id, project: input.project}
    })
    for (const name of ['considerClear', 'carryOn', 'pickWhenIdle', 'clearDone', 'noteContextCut'])
        vi.stubGlobal(name, (...args: unknown[]) => void noted.push(`${name} ${args.join(' ')}`))
    vi.stubGlobal('listSessions', () => sessions)
    vi.stubGlobal('noteContext', (...args: unknown[]) => void noted.push(`noteContext ${args.join(' ')}`))
    vi.resetModules()
    const held = await import('../server/utils/workspace-held')
    vi.stubGlobal('sessionWorkspace', held.sessionWorkspace)
    const sees = await import('../server/utils/member-sees')
    vi.stubGlobal('seenProjectOf', sees.seenProjectOf)
})
afterEach(() => vi.unstubAllGlobals())

const hook = async (event: H3Event) =>
    ((await import('../server/api/sessions/index.post')).default as unknown as (e: H3Event) => Promise<unknown>)(event)
const calls = async (event: H3Event) =>
    ((await import('../server/api/sessions/[session]/calls.post')).default as unknown as (e: H3Event) => Promise<unknown>)(event)

describe("a hook's report on another workspace's project", () => {
    it.each([["the server's owner", OWNER], ["a member's agent key", MEMBER]] as [string, Who][])(
        'is a 404 for %s, the same as a project that isn\'t here, and registers nothing', async (_who, who) => {
            const theirs = await hook(eventOf({project: 'acme', event: 'Stop', id: 's-new'}, who)).catch(e => e)
            const none = await hook(eventOf({project: 'ghost', event: 'Stop', id: 's-new'}, who)).catch(e => e)
            expect(theirs).toMatchObject({statusCode: 404, message: 'No project "acme"'})
            expect(none).toMatchObject({statusCode: 404, message: 'No project "ghost"'})
            expect(reported).toEqual([])
            expect(noted).toEqual([])
        })

    it('goes ahead on a project the asker sees', async () => {
        await hook(eventOf({project: 'rockets', event: 'Stop', id: 's-new'}, OWNER))
        expect(reported).toMatchObject([{id: 's-new', project: 'rockets'}])
        expect(noted).toContain('pickWhenIdle rockets s-new')
    })
})

describe("a channel's tool call", () => {
    const call = {tool: 'issue', text: 'ORR-1: …'}

    it('is a 404 for a session that isn\'t here, and keeps nothing', async () => {
        await expect(calls(eventOf(call, OWNER, {session: 's-ghost'}))).rejects.toMatchObject({statusCode: 404})
        await expect(calls(eventOf(call, undefined, {session: 's-ghost'}))).rejects.toMatchObject({statusCode: 404})
        expect(noted).toEqual([])
    })

    it("is a 404 for a session on another workspace's project, the owner's call too", async () => {
        for (const who of [OWNER, MEMBER])
            await expect(calls(eventOf(call, who, {session: 's-theirs'}))).rejects.toMatchObject({statusCode: 404})
        expect(noted).toEqual([])
    })

    it("is kept for a session on a project the asker sees", async () => {
        await calls(eventOf(call, OWNER, {session: 's-ours'}))
        expect(noted).toEqual(['noteContext s-ours tool issue ORR-1: …'])
    })
})
