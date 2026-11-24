import type {H3Event} from 'h3'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Connecting a folder writes the ticked projects' ids and keys into it (ORR-1375). It looks them up among every
// project on the server, so only one the asker sees, in the workspace they act in, is found: any other is the same 404
// as one that isn't here.
const WORKSPACES: Record<string, string> = {rockets: 'default', acme: 'theirs'}
type Who = {person: string, owner: boolean, via: 'browser' | 'agent'}
const OWNER: Who = {person: 'sam-connect', owner: true, via: 'browser'}
const eventOf = (projects: string[], who?: Who) => ({body: {projects}, headers: {}, params: {connect: 'c1'}, context: {who}}) as unknown as H3Event
let written: unknown[]

beforeEach(async () => {
    written = []
    const error = (statusCode: number) => (message: string) => Object.assign(new Error(message), {statusCode})
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', async (event: {body: unknown}) => event.body)
    vi.stubGlobal('getHeader', (event: {headers: Record<string, string>}, name: string) => event.headers[name])
    vi.stubGlobal('param', (event: {params: Record<string, string>}, name: string) => event.params[name])
    vi.stubGlobal('authorize', async () => {})
    vi.stubGlobal('checkInput', (body: unknown) => body)
    vi.stubGlobal('notFound', error(404))
    vi.stubGlobal('sessionWorkspace', () => undefined)
    // Asked as the caller, the API lists the workspaces they're in and those workspaces' projects: here only `default`.
    vi.stubGlobal('readAsAsker', async (_event: unknown, path: string) => path.startsWith('/api/workspaces') ? [{id: 'default'}] : [{id: 'rockets'}])
    vi.stubGlobal('useStore', () => ({
        listProjects: async () => Object.keys(WORKSPACES).map(id => ({id, key: id.slice(0, 3).toUpperCase()})),
        projectId: async (id: string) => {
            if (!(id in WORKSPACES)) throw error(404)(`No project "${id}"`)
            return id
        },
        projectWorkspace: async (id: string) => WORKSPACES[id],
    }))
    vi.stubGlobal('settingsNow', async () => ({id: 'orrery-1', terminal: 'iterm'}))
    vi.stubGlobal('useRuntimeConfig', () => ({public: {environment: 'personal'}}))
    vi.stubGlobal('writeConnect', (...args: unknown[]) => {
        written.push(args)
        return {state: 'writing'}
    })
    vi.resetModules()
    const sees = await import('../server/utils/member-sees')
    vi.stubGlobal('seenProjectOf', sees.seenProjectOf)
    vi.stubGlobal('askerWorkspace', sees.askerWorkspace)
})
afterEach(() => vi.unstubAllGlobals())

const write = async (event: H3Event) => (await import('../server/api/connects/[connect]/write.post')).default(event)

describe('connecting a folder (ORR-1375)', () => {
    it("answers another workspace's project as one that isn't here, and writes nothing", async () => {
        await expect(write(eventOf(['rockets', 'acme'], OWNER))).rejects.toMatchObject({statusCode: 404, message: 'No project acme'})
        await expect(write(eventOf(['nowhere'], OWNER))).rejects.toMatchObject({statusCode: 404, message: 'No project nowhere'})
        expect(written).toEqual([])
    })

    it('writes the projects the asker sees in their workspace', async () => {
        await write(eventOf(['rockets'], OWNER))
        expect(written).toHaveLength(1)
        expect((written[0] as unknown[])[1]).toEqual([{id: 'rockets', key: 'ROC'}])
    })

    it('finds any project with login off, as before', async () => {
        await write(eventOf(['rockets', 'acme']))
        expect((written[0] as unknown[])[1]).toEqual([{id: 'rockets', key: 'ROC'}, {id: 'acme', key: 'ACM'}])
    })
})
