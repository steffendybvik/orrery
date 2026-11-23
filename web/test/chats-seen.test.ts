import type {H3Event} from 'h3'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// A chat is its project's (ORR-1347): one on a project in another person's workspace is a 404, the owner's too.
const chats = [{id: 'c-mine', project: 'mine'}, {id: 'c-theirs', project: 'theirs'}]
const eventOf = (path: string, who?: {person: string, owner: boolean}) => ({path, context: {who}}) as unknown as H3Event
let held: (event: H3Event) => Promise<void>

beforeEach(async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('listChats', () => chats)
    vi.stubGlobal('needsSeen', async (_event: H3Event, project: string) => {
        if (project !== 'mine') throw Object.assign(new Error(`No project ${project}`), {statusCode: 404})
    })
    vi.stubGlobal('notFound', (message: string) => Object.assign(new Error(message), {statusCode: 404}))
    vi.resetModules()
    held = (await import('../server/middleware/chats-seen')).default as unknown as typeof held
})
afterEach(() => vi.unstubAllGlobals())

describe('chats-seen', () => {
    const sam = {person: 'sam', owner: true}

    it("lets a chat on a project you see through, and 404s another person's", async () => {
        await expect(held(eventOf('/api/chats/c-mine', sam))).resolves.toBeUndefined()
        await expect(held(eventOf('/api/chats/c-theirs/messages', sam))).rejects.toMatchObject({statusCode: 404, message: 'No chat c-theirs'})
    })

    it('leaves the list, an unknown chat, and anyone with login off to their routes', async () => {
        await expect(held(eventOf('/api/chats', sam))).resolves.toBeUndefined()
        await expect(held(eventOf('/api/chats/c-none', sam))).resolves.toBeUndefined()
        await expect(held(eventOf('/api/chats/c-theirs'))).resolves.toBeUndefined()
    })
})
