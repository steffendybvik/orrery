import type {H3Event} from 'h3'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// `POST /api/egress` looks its secrets up in the project its body names, so that has to be one the asker sees: another
// person's is a 404 before any secret is read (ORR-1352). The guard itself, `seenProjectOf`, is tested in
// egress-seen.test.ts (ORR-1359).
let route: (event: H3Event) => Promise<unknown>
let body: unknown
const egress = vi.fn(async () => ({status: 200}))
const event = {} as H3Event

beforeEach(async () => {
    egress.mockClear()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', async () => body)
    vi.stubGlobal('actorOf', async () => ({name: 'ana'}))
    vi.stubGlobal('useSecrets', () => ({egress}))
    vi.stubGlobal('seenProjectOf', async (_event: H3Event, project: string) => {
        if (project !== 'mine') throw Object.assign(new Error(`No project "${project}"`), {statusCode: 404})
        return project
    })
    vi.resetModules()
    route = (await import('../server/api/egress.post')).default as unknown as typeof route
})
afterEach(() => vi.unstubAllGlobals())

describe('POST /api/egress', () => {
    it('makes the request for a project the asker sees, and for one that names none', async () => {
        for (const sent of [{url: 'https://a.example', project: 'mine'}, {url: 'https://a.example'}, null]) {
            body = sent
            await expect(route(event)).resolves.toEqual({status: 200})
        }
        expect(egress).toHaveBeenCalledTimes(3)
    })

    it("answers another person's project as one that isn't there, and reads none of its secrets", async () => {
        body = {url: 'https://a.example', project: 'theirs'}
        await expect(route(event)).rejects.toMatchObject({statusCode: 404, message: 'No project "theirs"'})
        expect(egress).not.toHaveBeenCalled()
    })
})
