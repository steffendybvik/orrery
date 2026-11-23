import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// The line an uploaded board leaves in the event log (ORR-1409): it names the board the API made, `rockets-2` when only
// another workspace has `rockets` (ORR-1350), and goes in the workspace it was made in, never the one holding the id.
type Note = {kind: string, project?: string, workspace?: string, message: string}
let notes: Note[]
let reply: Record<string, unknown>
let route: (event: object) => Promise<unknown>

beforeEach(async () => {
    notes = []
    reply = {id: 'rockets-2', workspace: 'acme', name: 'Rockets'}
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('BOARD_LIMIT', 256 * 1024 * 1024)
    vi.stubGlobal('memberAsking', async () => ({name: 'ana', owner: false}))
    vi.stubGlobal('authorize', async () => ({name: 'ana', owner: false}))
    vi.stubGlobal('getHeader', (_event: unknown, name: string) => name === 'orrery-workspace' ? 'acme' : undefined)
    vi.stubGlobal('readRawBody', async () => '{}')
    vi.stubGlobal('getQuery', () => ({id: 'rockets', key: 'ROC'}))
    vi.stubGlobal('checkedBoard', (_file: unknown, {id}: {id: string}) => ({id}))
    vi.stubGlobal('personOf', async () => 'ana')
    vi.stubGlobal('ownerNow', async () => ({name: 'skoll'}))
    vi.stubGlobal('boardForApi', (board: object) => board)
    vi.stubGlobal('writeToApi', async () => ({reply}))
    vi.stubGlobal('useEventLog', () => ({note: (entry: Note) => notes.push(entry)}))
    vi.stubGlobal('created', (_event: unknown, value: unknown) => value)
    vi.resetModules()
    route = (await import('../server/api/projects/upload.post')).default as unknown as typeof route
})

afterEach(() => vi.unstubAllGlobals())

describe('uploading a board', () => {
    it('logs the board the API made, in the workspace it was made in', async () => {
        await route({})
        expect(notes).toEqual([expect.objectContaining({kind: 'board.uploaded', project: 'rockets-2', workspace: 'acme', message: "ana uploaded a board's file as rockets-2"})])
    })

    it('falls back to the id asked for and the workspace the page is in when the reply says neither', async () => {
        reply = {}
        await route({})
        expect(notes).toEqual([expect.objectContaining({project: 'rockets', workspace: 'acme'})])
    })
})
