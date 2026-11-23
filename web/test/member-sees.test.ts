import type {H3Event} from 'h3'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {listedSees, memberSees, needsSeen, projectsListedTo, reposSeen, workspaceAsked} from '../server/utils/member-sees'

// What anyone signed in can read on the routes this server answers itself (ORR-1195, ORR-1347): the projects the API
// lists for them, asked as them, the server's owner too; with login off, every one.
const asked = vi.fn(async () => [{id: 'rockets'}])
const eventOf = (who?: {person: string, owner: boolean, via: 'browser' | 'agent'}, workspace?: string, key?: string) =>
    ({context: {who}, workspace, key}) as unknown as H3Event

beforeEach(() => {
    asked.mockReset()
    asked.mockImplementation(async () => [{id: 'rockets'}])
    vi.stubGlobal('readAsAsker', asked)
    vi.stubGlobal('getHeader', (event: {workspace?: string, key?: string}, name: string) =>
        name === 'orrery-workspace' ? event.workspace : name === 'authorization' && event.key ? `Bearer ${event.key}` : undefined)
    vi.stubGlobal('createError', (e: {statusCode: number, message: string}) => Object.assign(new Error(e.message), e))
})
afterEach(() => vi.unstubAllGlobals())

describe('memberSees', () => {
    it('holds nobody back with login off, and asks nothing', async () => {
        expect(await memberSees(eventOf())).toBeUndefined()
        expect(asked).not.toHaveBeenCalled()
    })

    it('gives a member the projects the API lists for them, and a 404 for any other', async () => {
        const bo = eventOf({person: 'bo-sees', owner: false, via: 'browser'})
        expect([...await memberSees(bo) ?? []]).toEqual(['rockets'])
        await expect(needsSeen(bo, 'rockets')).resolves.toBeUndefined()
        await expect(needsSeen(bo, 'primes')).rejects.toMatchObject({statusCode: 404})
        // The miss asked again, in case it was made a moment ago.
        expect(asked).toHaveBeenCalledTimes(2)
    })

    // Owning the server gives no way into another person's workspace (decision 6 of decision-workspaces).
    it("holds the server's owner to what the API lists for them too", async () => {
        const sam = eventOf({person: 'sam-sees', owner: true, via: 'browser'})
        expect([...await memberSees(sam) ?? []]).toEqual(['rockets'])
        await expect(needsSeen(sam, 'theirs')).rejects.toMatchObject({statusCode: 404})
        expect(asked).toHaveBeenCalledWith(sam, '/api/projects?every=1')
    })

    it('reaches a project made since it last asked', async () => {
        const bo = eventOf({person: 'bo-new', owner: false, via: 'browser'})
        await memberSees(bo)
        asked.mockResolvedValueOnce([{id: 'rockets'}, {id: 'fresh'}])
        await expect(needsSeen(bo, 'fresh')).resolves.toBeUndefined()
    })

    it("keeps an agent key's answer apart from its person's page", async () => {
        await memberSees(eventOf({person: 'kit', owner: false, via: 'browser'}))
        asked.mockResolvedValueOnce([{id: 'one'}])
        expect([...await memberSees(eventOf({person: 'kit', owner: false, via: 'agent'}, undefined, 'key-1')) ?? []]).toEqual(['one'])
        expect(asked).toHaveBeenCalledTimes(2)
    })

    it('gives a member nothing, and the owner everything, when the API gives no answer', async () => {
        asked.mockResolvedValue(undefined as never)
        expect([...await memberSees(eventOf({person: 'bo-none', owner: false, via: 'browser'})) ?? ['?']]).toEqual([])
        expect(await memberSees(eventOf({person: 'sam-none', owner: true, via: 'browser'}))).toBeUndefined()
    })
})

// Two people's workspaces never show in each other's lists (ORR-1347): each is asked of the API as them.
describe('two people', () => {
    it("lists neither one's projects nor repos to the other", async () => {
        const lists: Record<string, {id: string, repo: string}[]> = {
            ann: [{id: 'ann-board', repo: 'ann/Repo'}],
            ben: [{id: 'ben-board', repo: 'ben/repo'}],
        }
        asked.mockImplementation((async (event: H3Event) => lists[(event.context.who as {person: string}).person]) as never)
        const ann = eventOf({person: 'ann', owner: true, via: 'browser'})
        const ben = eventOf({person: 'ben', owner: false, via: 'browser'})
        expect(await projectsListedTo(ann, async () => [...lists.ann!, ...lists.ben!])).toEqual(lists.ann)
        expect(await projectsListedTo(ben, async () => [...lists.ann!, ...lists.ben!])).toEqual(lists.ben)
        expect([...await reposSeen(ann) ?? []]).toEqual(['ann/repo'])
        expect([...await reposSeen(ben) ?? []]).toEqual(['ben/repo'])
        await expect(needsSeen(ann, 'ben-board')).rejects.toMatchObject({statusCode: 404})
        await expect(needsSeen(ben, 'ann-board')).rejects.toMatchObject({statusCode: 404})
        expect([...await listedSees(ann) ?? []]).toEqual(['ann-board'])
        expect([...await listedSees(ben) ?? []]).toEqual(['ben-board'])
    })

    it('lists every project with login off', async () => {
        expect(await projectsListedTo(eventOf(), async () => [{id: 'a'}, {id: 'b'}])).toEqual([{id: 'a'}, {id: 'b'}])
        expect(await reposSeen(eventOf())).toBeUndefined()
    })
})

// A list across projects, as the Sessions page reads it, holds the one workspace the page is in, the owner's too
// (ORR-1251): the API lists its projects alone, so asking is kept per person and workspace.
describe('listedSees', () => {
    it('holds nobody back with login off', async () => {
        expect(await listedSees(eventOf())).toBeUndefined()
        expect(asked).not.toHaveBeenCalled()
    })

    it("asks the API for the owner too, and keeps each workspace's answer apart", async () => {
        const home = eventOf({person: 'sam-listed', owner: true, via: 'browser'})
        expect([...await listedSees(home) ?? []]).toEqual(['rockets'])
        asked.mockResolvedValueOnce([{id: 'primes'}])
        expect([...await listedSees(eventOf({person: 'sam-listed', owner: true, via: 'browser'}, 'acme')) ?? []]).toEqual(['primes'])
        expect([...await listedSees(home) ?? []]).toEqual(['rockets'])
        expect(asked).toHaveBeenCalledTimes(2)
    })

    it('holds nobody back when the API gives no answer', async () => {
        asked.mockResolvedValueOnce(undefined as never)
        expect(await listedSees(eventOf({person: 'nobody-answers', owner: true, via: 'browser'}))).toBeUndefined()
    })
})

// A route that writes as this server passes on the workspace a page names (ORR-1369): only one the asker is in.
describe('workspaceAsked', () => {
    it("passes on one of the asker's workspaces, and 404s another person's", async () => {
        asked.mockResolvedValue([{id: 'default'}, {id: 'mine'}] as never)
        const sam = (workspace?: string) => eventOf({person: 'sam-ws', owner: true, via: 'browser'}, workspace)
        expect(await workspaceAsked(sam('mine'))).toBe('mine')
        expect(asked).toHaveBeenCalledWith(expect.anything(), '/api/workspaces')
        await expect(workspaceAsked(sam('bob'))).rejects.toMatchObject({statusCode: 404, message: 'No workspace bob'})
    })

    it('names none when none is asked, and holds nobody back with login off', async () => {
        expect(await workspaceAsked(eventOf({person: 'sam-ws', owner: true, via: 'browser'}))).toBeUndefined()
        expect(await workspaceAsked(eventOf(undefined, 'any'))).toBe('any')
        expect(asked).not.toHaveBeenCalled()
    })

    it('refuses when the API gives no answer', async () => {
        asked.mockResolvedValue(undefined as never)
        await expect(workspaceAsked(eventOf({person: 'sam-ws', owner: true, via: 'browser'}, 'mine'))).rejects.toMatchObject({statusCode: 404})
    })
})
