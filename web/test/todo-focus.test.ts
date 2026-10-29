import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// An issue the owner moves into Todo going to an idle session (ORR-515), with Nitro's auto-imports stubbed: the
// sessions as they are, the board, and the focuses sent.
let todo: typeof import('../server/utils/todo-focus')
type Listed = {id: string, project: string, state: string, listening: boolean, also?: string[]}
let sessions: Listed[]
let board: {id: string, kind: string, priority?: string, parent?: string, proposal?: string, waiting?: string, assignee?: string, created_at: string}[]
let busy: string[]
let queued: string[]
let onItsWay: string[]
let chats: string[]
let sent: {issue: string, session: string, note: string, by: {name: string, owner: boolean}}[]

const issue = (id: string, kind = 'todo', more: Record<string, string> = {}) => ({id, kind, created_at: `2026-10-29T0${id.slice(-1)}:00:00Z`, ...more})
const owner = {name: 'steffen', owner: true}
const moved = (id: string, from = 'backlog') => ({event: {type: 'issue.status', project: 'orrery', subject: id, by: owner, from, to: 'todo'}})

beforeEach(async () => {
    vi.useFakeTimers()
    sessions = [{id: 'a', project: 'orrery', state: 'idle', listening: true}]
    board = [issue('ORR-1'), issue('ORR-2', 'todo', {priority: 'P0'}), issue('ORR-3', 'todo', {priority: 'P2'})]
    busy = []
    queued = []
    onItsWay = []
    chats = []
    sent = []
    vi.stubGlobal('listSessions', () => sessions)
    vi.stubGlobal('sessionIds', (id: string) => [id])
    vi.stubGlobal('currentId', (id: string) => id)
    vi.stubGlobal('chatSession', (id: string) => chats.includes(id))
    vi.stubGlobal('untrustedSession', () => false)
    vi.stubGlobal('useStore', () => ({
        statuses: async () => [{id: 'backlog', kind: 'backlog'}, {id: 'todo', kind: 'todo'}, {id: 'ready', kind: 'todo'}, {id: 'in-progress', kind: 'started'}],
        ownerOf: async () => ({name: 'steffen'}),
        listIssues: async () => board,
        workingOn: async (_project: string, ids: string[]) => ids.filter(id => busy.includes(id)).map(id => ({id})),
        waiting: async (_project: string, ids: string[]) => ids.some(id => queued.includes(id)),
        async busy(project: string, ids: string[]) {
            return (await this.workingOn(project, ids)).length > 0 || await this.waiting(project, ids)
        },
        focusOnItsWay: async (_project: string, id: string) => onItsWay.includes(id),
        focus: async (_project: string, issue: string, body: {session: string, note: string}, by: {name: string, owner: boolean}) => void sent.push({issue, session: body.session, note: body.note, by}),
    }))
    vi.resetModules()
    todo = await import('../server/utils/todo-focus')
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

/** The owner's moves, heard, then handed out once the burst is over. */
async function hear(...events: Parameters<typeof todo.heardTodo>[0][]) {
    for (const event of events) todo.heardTodo(event)
    await vi.advanceTimersByTimeAsync(todo.TODO_AFTER)
}

describe('an issue the owner moves into Todo', () => {
    it('goes to an idle session, as theirs, aimed at it', async () => {
        await hear(moved('ORR-1'))
        expect(sent).toEqual([{issue: 'ORR-1', session: 'a', note: todo.TODO_NOTE, by: owner}])
    })

    it('goes with an agent on it, in any case (ORR-531)', async () => {
        board = [issue('ORR-1', 'todo', {assignee: 'claude'}), issue('ORR-2', 'todo', {assignee: 'Claude'})]
        sessions.push({id: 'b', project: 'orrery', state: 'idle', listening: true})
        await hear(moved('ORR-1'), moved('ORR-2'))
        expect(sent.map(s => s.issue)).toEqual(['ORR-1', 'ORR-2'])
    })

    it('goes when the owner makes one there too', async () => {
        await hear({event: {type: 'issue.created', project: 'orrery', subject: 'ORR-3', by: owner}})
        expect(sent.map(s => s.issue)).toEqual(['ORR-3'])
    })

    it('goes one to each idle session in a burst, the most urgent first, and the rest wait', async () => {
        sessions.push({id: 'b', project: 'orrery', state: 'idle', listening: true})
        await hear(moved('ORR-1'), moved('ORR-2'), moved('ORR-3'))
        expect(sent.map(s => [s.issue, s.session])).toEqual([['ORR-2', 'a'], ['ORR-3', 'b']])
    })

    it('goes to the project\'s own session before one spanning projects', async () => {
        sessions = [{id: 'wide', project: 'other', state: 'idle', listening: true, also: ['orrery']}, {id: 'own', project: 'orrery', state: 'idle', listening: true}]
        await hear(moved('ORR-1'))
        expect(sent.map(s => s.session)).toEqual(['own'])
    })

    it('waits with nobody idle and out of work: busy, working an issue, a signal queued, a chat, not listening', async () => {
        sessions = [
            {id: 'busy', project: 'orrery', state: 'working', listening: true},
            {id: 'has-work', project: 'orrery', state: 'idle', listening: true},
            {id: 'queued', project: 'orrery', state: 'idle', listening: true},
            {id: 'chat', project: 'orrery', state: 'idle', listening: true},
            {id: 'gone', project: 'orrery', state: 'idle', listening: false},
            {id: 'elsewhere', project: 'other', state: 'idle', listening: true},
        ]
        busy = ['has-work']
        queued = ['queued']
        chats = ['chat']
        await hear(moved('ORR-1'))
        expect(sent).toEqual([])
    })

    it("sends nothing for an agent's move, a schedule run's or an untrusted session's", async () => {
        await hear(
            {event: {...moved('ORR-1').event, by: {name: 'claude', owner: false}}},
            {...moved('ORR-2'), cause: {schedule: 3}},
            {event: {...moved('ORR-3').event, untrusted: true}},
        )
        expect(sent).toEqual([])
    })

    it('sends nothing for a move within Todo, out of it, or what isn\'t work for a session', async () => {
        board = [
            issue('ORR-1'), issue('ORR-2', 'backlog'), issue('ORR-3', 'todo', {proposal: 'pending'}), issue('ORR-4', 'todo', {assignee: 'steffen'}),
            issue('ORR-5', 'todo', {waiting: 'decision'}), issue('ORR-6'), issue('ORR-7', 'todo', {parent: 'ORR-6'}), issue('ORR-8'),
            issue('ORR-9', 'todo', {assignee: 'ada'}),
        ]
        onItsWay = ['ORR-8']
        await hear(moved('ORR-1', 'ready'), moved('ORR-2', 'todo'), moved('ORR-3'), moved('ORR-4'), moved('ORR-5'), moved('ORR-6'), moved('ORR-8'), moved('ORR-9'))
        expect(sent).toEqual([])
    })
})
