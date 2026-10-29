import {describe, expect, it} from 'vitest'
import type {Issue, Signal} from '#shared/roadmap'
import {scopeOf} from '../server/utils/scope'
import type {Store} from '../server/utils/store'

// What a chunk focus asks a session to work through (ORR-500), with the store's board and chunks as plain objects.
const issue = (id: string, fields: Partial<Issue> = {}) => ({id, column: 'todo', kind: 'todo', tasks: [], ...fields}) as Issue
const chunks = [
    {id: '1', title: 'Foundations', column: 'started', tasks: [
        issue('ORR-1', {priority: 'P2'}),
        issue('ORR-2', {priority: 'P0'}),
        issue('ORR-3'),
        issue('ORR-4', {priority: 'P1', column: 'in-review', kind: 'started'}),
        issue('ORR-5', {column: 'done', kind: 'done'}),
        issue('ORR-6', {column: 'canceled', kind: 'canceled'}),
        issue('ORR-7', {column: 'proposed', kind: 'proposed'}),
    ]},
    {id: '2', title: 'Releases', column: 'todo', tasks: [
        issue('ORR-8', {release: '1.0', tasks: [issue('ORR-9')]}),
        issue('ORR-10', {tasks: [issue('ORR-11', {release: '1.0', priority: 'P0'}), issue('ORR-12', {tasks: [issue('ORR-13', {release: '1.0'})]})]}),
        issue('ORR-14', {release: '2.0'}),
    ]},
    {title: 'No chunk', column: 'done', tasks: [issue('ORR-15')]},
]
const asked: string[] = []
const store = (board = chunks) => ({
    project: async () => ({board: {chunks: board}}),
    chunk: async (_project: string, id: string) => {
        asked.push(id)
        return board.find(c => c.id === id)
    },
}) as unknown as Store
const scope = (signal: Partial<Signal>, board = chunks) => scopeOf(store(board), 'orrery', signal as Signal)
const ids = (issues: Issue[]) => issues.map(t => t.id)

describe('a chunk focus', () => {
    it('is the chunk\'s open issues, most urgent first, with none last', async () => {
        const {chunk, title, wanted, open} = await scope({chunk: '1'})
        expect(asked.at(-1)).toBe('1')
        expect(chunk.title).toBe('Foundations')
        expect(title).toBe('Foundations')
        expect(wanted).toEqual([])
        // Proposals and closed issues aren't work: a proposal waits on the owner, the rest is finished.
        expect(ids(open)).toEqual(['ORR-2', 'ORR-4', 'ORR-1', 'ORR-3'])
    })

    it('on `all` is every chunk\'s issues together, as "every chunk"', async () => {
        const {title, open} = await scope({chunk: 'all'})
        expect(title).toBe('every chunk')
        expect(ids(open)).toEqual(['ORR-2', 'ORR-4', 'ORR-1', 'ORR-3', 'ORR-8', 'ORR-10', 'ORR-14', 'ORR-15'])
    })

    it('on `none` is the issues in no chunk, and nothing when there are none', async () => {
        expect(ids((await scope({chunk: 'none'})).open)).toEqual(['ORR-15'])
        const {chunk, title, open} = await scope({chunk: 'none'}, chunks.slice(0, 2))
        expect(title).toBe('No chunk')
        expect(chunk.column).toBe('done')
        expect(open).toEqual([])
    })

    it('with no chunk is a bug, not an empty scope', async () => {
        await expect(scope({})).rejects.toThrow('Expected the chunk a chunk focus is on')
    })
})

describe('a release in a focus', () => {
    it('takes the issues set for it at any depth: a parent in it with its sub-issues, else the sub-issues that are', async () => {
        const {title, open} = await scope({chunk: '2', release: '1.0'})
        expect(title).toBe('Releases, release 1.0')
        // ORR-8 is in it (ORR-9 goes with it); ORR-10 isn't, so its sub-issues in it are taken, however deep.
        expect(ids(open)).toEqual(['ORR-11', 'ORR-8', 'ORR-13'])
        expect(ids(open.find(t => t.id === 'ORR-8')!.tasks)).toEqual(['ORR-9'])
    })

    it('across the project is that release\'s issues in every chunk', async () => {
        expect(ids((await scope({chunk: 'all', release: '2.0'})).open)).toEqual(['ORR-14'])
    })
})

describe('statuses in a focus', () => {
    it('take the issues in any of them, by status or kind, closed or proposed included when asked', async () => {
        const {wanted, open} = await scope({chunk: '1', status: ' in-review, ,done ,proposed'})
        expect(wanted).toEqual(['in-review', 'done', 'proposed'])
        expect(ids(open)).toEqual(['ORR-4', 'ORR-5', 'ORR-7'])
    })

    it('match a kind as well as a status', async () => {
        expect(ids((await scope({chunk: '1', status: 'started'})).open)).toEqual(['ORR-4'])
        expect(ids((await scope({chunk: '1', status: 'todo'})).open)).toEqual(['ORR-2', 'ORR-1', 'ORR-3'])
    })

    it('left blank are every open issue', async () => {
        const {wanted, open} = await scope({chunk: '1', status: ' , '})
        expect(wanted).toEqual([])
        expect(ids(open)).toEqual(['ORR-2', 'ORR-4', 'ORR-1', 'ORR-3'])
    })
})
