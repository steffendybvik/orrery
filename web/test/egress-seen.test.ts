import type {H3Event} from 'h3'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Egress names its project in the body (ORR-1359), so the path's guards don't hold it: it fills in the secrets of the
// workspace that project is in. A project in a workspace the caller isn't in, a member's, their session's or the
// server owner's, is answered as one that isn't here, before any secret is read, so no name or project leaks either.
const WORKSPACES: Record<string, string> = {rockets: 'default', acme: 'theirs'}
const egress = vi.fn(async (body: {project?: string}) => ({status: 200, project: body.project}))
type Who = {person: string, owner: boolean, via: 'browser' | 'agent'}
const eventOf = (body: unknown, who?: Who, headers: Record<string, string> = {}) =>
    ({body, headers, context: {who}}) as unknown as H3Event
const session = (workspace: string) => ({'orrery-session': 's-1', 'orrery-workspace': workspace})
let route: (event: H3Event) => Promise<unknown>

beforeEach(async () => {
    egress.mockClear()
    const error = (statusCode: number) => (message: string) => Object.assign(new Error(message), {statusCode})
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', async (event: {body: unknown}) => event.body)
    vi.stubGlobal('actorOf', async () => ({name: 'claude'}))
    vi.stubGlobal('useSecrets', () => ({egress}))
    vi.stubGlobal('getHeader', (event: {headers: Record<string, string>}, name: string) => event.headers[name])
    vi.stubGlobal('sessionHeader', (event: {headers: Record<string, string>}) => event.headers['orrery-session'])
    vi.stubGlobal('notFound', error(404))
    vi.stubGlobal('createError', (e: {statusCode: number, message: string}) => Object.assign(new Error(e.message), e))
    // Asked as the caller, the API lists the projects of the workspaces they're in: here only `default`'s.
    vi.stubGlobal('readAsAsker', async () => [{id: 'rockets'}])
    vi.stubGlobal('useStore', () => ({
        projectId: async (id: string) => {
            if (!(id in WORKSPACES)) throw error(404)(`No project "${id}"`)
            return id
        },
        projectWorkspace: async (id: string) => WORKSPACES[id],
    }))
    vi.resetModules()
    const held = await import('../server/utils/workspace-held')
    vi.stubGlobal('sessionWorkspace', held.sessionWorkspace)
    const sees = await import('../server/utils/member-sees')
    vi.stubGlobal('seenProjectOf', sees.seenProjectOf)
    route = (await import('../server/api/egress.post')).default as unknown as typeof route
})
afterEach(() => vi.unstubAllGlobals())

const request = (project: string) => ({url: 'https://api.github.com/user/repos', headers: {Authorization: 'Bearer {{secret:GITHUB_TOKEN}}'}, project})

describe('egress for a project in another workspace', () => {
    it.each([
        ['a member', {person: 'bo-egress', owner: false, via: 'browser'}],
        ["a member's agent key", {person: 'bo-egress-key', owner: false, via: 'agent'}],
        ["the server's owner", {person: 'sam-egress', owner: true, via: 'browser'}],
    ] as [string, Who][])('is a 404 for %s, the same as a project that isn\'t here, and sends nothing', async (_who, who) => {
        const theirs = await route(eventOf(request('acme'), who)).catch(e => e)
        const none = await route(eventOf(request('ghost'), who)).catch(e => e)
        expect(theirs).toMatchObject({statusCode: 404, message: 'No project "acme"'})
        expect(none).toMatchObject({statusCode: 404, message: 'No project "ghost"'})
        expect(egress).not.toHaveBeenCalled()
    })

    it('goes ahead for a project the caller sees', async () => {
        const who: Who = {person: 'bo-egress-own', owner: false, via: 'browser'}
        expect(await route(eventOf(request('rockets'), who))).toEqual({status: 200, project: 'rockets'})
    })

    it('is a 404 for a session held to another workspace, even with login off', async () => {
        await expect(route(eventOf(request('acme'), undefined, session('default')))).rejects.toMatchObject({statusCode: 404, message: 'No project "acme"'})
        expect(await route(eventOf(request('acme'), undefined, session('theirs')))).toEqual({status: 200, project: 'acme'})
        expect(egress).toHaveBeenCalledTimes(1)
    })

    it('leaves a request naming no project to egress, which asks for one', async () => {
        await route(eventOf({url: 'https://api.github.com/', project: ''}, {person: 'bo-egress-none', owner: false, via: 'browser'}))
        expect(egress).toHaveBeenCalledWith({url: 'https://api.github.com/', project: ''}, {name: 'claude'})
    })
})
