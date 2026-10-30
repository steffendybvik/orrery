import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// An issue the owner moves into Todo going to an idle session (ORR-515), with Nitro's auto-imports stubbed: the
// sessions as they are, the board, and the focuses sent.
let todo: typeof import('../server/utils/todo-focus')
type Listed = {id: string, project: string, state: string, listening: boolean, also?: string[]}
let sessions: Listed[]
let board: {id: string, kind: string, priority?: string, parent?: string, proposal?: string, waiting?: string, assignee?: string, created_at: string, depends_on?: string[], blocked_by?: string[]}[]
let links: {id: string, on: string}[]
let workers: Record<string, string>
let held: Record<string, string>
let said: {issue: string, type: string, asks?: string}[]
let busy: string[]
let queued: string[]
let onItsWay: string[]
let chats: string[]
let sent: {issue: string, session: string, note: string, by: {name: string, owner: boolean}}[]

const issue = (id: string, kind = 'todo', more: Record<string, unknown> = {}) => ({id, kind, created_at: `2026-10-29T0${id.slice(-1)}:00:00Z`, ...more})
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
    links = []
    workers = {}
    held = {}
    said = []
    vi.stubGlobal('listSessions', () => sessions)
    vi.stubGlobal('sessionIds', (id: string) => [id])
    vi.stubGlobal('currentId', (id: string) => id)
    vi.stubGlobal('chatSession', (id: string) => chats.includes(id))
    vi.stubGlobal('untrustedSession', () => false)
    vi.stubGlobal('useStore', () => ({
        statuses: async () => [{id: 'backlog', kind: 'backlog'}, {id: 'todo', kind: 'todo'}, {id: 'ready', kind: 'todo'}, {id: 'in-progress', kind: 'started'}, {id: 'done', kind: 'done'}, {id: 'canceled', kind: 'canceled'}],
        ownerOf: async () => ({name: 'steffen'}),
        listIssues: async () => board,
        workingOn: async (_project: string, ids: string[]) => ids.filter(id => busy.includes(id)).map(id => ({id})),
        waiting: async (_project: string, ids: string[]) => ids.some(id => queued.includes(id)),
        async busy(project: string, ids: string[]) {
            return (await this.workingOn(project, ids)).length > 0 || await this.waiting(project, ids)
        },
        focusOnItsWay: async (_project: string, id: string) => onItsWay.includes(id),
        dependentsOf: async (_project: string, id: string) => links.filter(l => l.on === id).map(l => ({project: 'orrery', id: l.id})),
        issue: async (_project: string, id: string) => board.find(i => i.id === id),
        workerOf: async (_project: string, id: string) => workers[id] ?? null,
        heldAbove: async (_project: string, id: string) => held[id] ? {parent: 'ORR-9', holder: held[id]} : null,
        systemEvent: async (_project: string, issue: string, type: string) => void said.push({issue, type}),
        systemAsk: async (_project: string, issue: string, _body: string, type: string, asks: string) => void said.push({issue, type, asks}),
        systemComment: async (_project: string, issue: string, _body: string, type: string) => void said.push({issue, type}),
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

describe('a follow-up the owner moves into Todo (ORR-613)', () => {
    it("goes to the session on its parent, busy or not, and doesn't take an idle session from the rest", async () => {
        sessions.push({id: 'builder', project: 'orrery', state: 'working', listening: true})
        busy = ['builder']
        board = [issue('ORR-1', 'todo', {parent: 'ORR-9'}), issue('ORR-2', 'todo', {priority: 'P2'})]
        held = {'ORR-1': 'builder'}
        await hear(moved('ORR-1'), moved('ORR-2'))
        expect(sent.map(s => [s.issue, s.session])).toEqual([['ORR-2', 'a'], ['ORR-1', 'builder']])
    })

    it('goes to the session on its parent with nobody idle', async () => {
        sessions = []
        board = [issue('ORR-1', 'todo', {parent: 'ORR-9'})]
        held = {'ORR-1': 'builder'}
        await hear(moved('ORR-1'))
        expect(sent.map(s => [s.issue, s.session])).toEqual([['ORR-1', 'builder']])
    })
})

describe('an issue waiting on others (ORR-601)', () => {
    const status = (id: string, from: string, to: string, by = {name: 'claude', owner: false}) => ({event: {type: 'issue.status', project: 'orrery', subject: id, by, from, to}})
    /** ORR-3 waits on ORR-1 (done now) and on `also`, if any. */
    const waiting = (also: string[] = [], more: Record<string, unknown> = {}) => {
        links = [{id: 'ORR-3', on: 'ORR-1'}, ...also.map(on => ({id: 'ORR-3', on}))]
        board = [issue('ORR-1', 'done'), ...also.map(id => issue(id, 'todo')), issue('ORR-3', 'todo', {depends_on: ['ORR-1', ...also], ...also.length ? {blocked_by: also} : {}, ...more})]
    }

    it("isn't handed out when the owner moves it into Todo while it's blocked", async () => {
        board = [issue('ORR-1', 'todo', {depends_on: ['ORR-2'], blocked_by: ['ORR-2']})]
        await hear(moved('ORR-1'))
        expect(sent).toEqual([])
    })

    it('goes out once its last blocker is done, to the idle session that did it, told what it waited on', async () => {
        sessions.push({id: 'finisher', project: 'orrery', state: 'idle', listening: true})
        workers = {'ORR-1': 'finisher'}
        waiting()
        await hear(status('ORR-1', 'in-progress', 'done'))
        expect(sent).toEqual([{issue: 'ORR-3', session: 'finisher', note: `${todo.UNBLOCKED_NOTE} ORR-1.`, by: owner}])
        expect(said).toEqual([{issue: 'ORR-3', type: 'issue.unblocked'}])
    })

    it('goes to the one that did the blocker while it finishes its turn, but to another when it has other work', async () => {
        sessions.push({id: 'finisher', project: 'orrery', state: 'working', listening: true})
        workers = {'ORR-1': 'finisher'}
        waiting()
        await hear(status('ORR-1', 'in-progress', 'done'))
        expect(sent.map(s => s.session)).toEqual(['finisher'])
        sent = []
        busy = ['finisher']
        await hear(status('ORR-1', 'in-progress', 'done'))
        expect(sent.map(s => s.session)).toEqual(['a'])
    })

    it('goes to the session on its parent when it is a follow-up (ORR-613)', async () => {
        sessions.push({id: 'finisher', project: 'orrery', state: 'idle', listening: true})
        workers = {'ORR-1': 'finisher'}
        waiting([], {parent: 'ORR-9'})
        held = {'ORR-3': 'builder'}
        await hear(status('ORR-1', 'in-progress', 'done'))
        expect(sent.map(s => [s.issue, s.session])).toEqual([['ORR-3', 'builder']])
    })

    it('waits while another blocker is open (fan-in)', async () => {
        waiting(['ORR-2'])
        await hear(status('ORR-1', 'in-progress', 'done'))
        expect(sent).toEqual([])
        expect(said).toEqual([])
    })

    it('goes, with the others it freed, each to its own session (fan-out)', async () => {
        sessions.push({id: 'b', project: 'orrery', state: 'idle', listening: true})
        links = [{id: 'ORR-3', on: 'ORR-1'}, {id: 'ORR-4', on: 'ORR-1'}, {id: 'ORR-5', on: 'ORR-1'}]
        board = [issue('ORR-1', 'done'), issue('ORR-3', 'todo', {depends_on: ['ORR-1']}), issue('ORR-4', 'todo', {depends_on: ['ORR-1']}), issue('ORR-5', 'todo', {depends_on: ['ORR-1']})]
        await hear(status('ORR-1', 'in-progress', 'done'))
        expect(sent.map(s => [s.issue, s.session])).toEqual([['ORR-3', 'a'], ['ORR-4', 'b']])
        expect(said.map(s => s.issue)).toEqual(['ORR-3', 'ORR-4', 'ORR-5'])
    })

    it("isn't handed out from Backlog, though it's told it's free", async () => {
        waiting([], {kind: 'backlog'})
        board[1] = {...board[1]!, kind: 'backlog'}
        await hear(status('ORR-1', 'in-progress', 'done'))
        expect(sent).toEqual([])
        expect(said).toEqual([{issue: 'ORR-3', type: 'issue.unblocked'}])
    })

    it('goes out when the owner drops the link that held it, and a deleted blocker does the same', async () => {
        board = [issue('ORR-3', 'todo', {})]
        await hear({event: {type: 'issue.depends', project: 'orrery', subject: 'ORR-3', by: owner, from: '["ORR-1"]'}})
        expect(sent.map(s => s.issue)).toEqual(['ORR-3'])
        sent = []
        onItsWay = []
        await hear({event: {type: 'issue.depends', project: 'orrery', subject: 'ORR-3', by: {name: 'orrery', owner: false}, from: '["ORR-1","ORR-2"]', to: '["ORR-2"]'}})
        expect(sent.map(s => s.issue)).toEqual(['ORR-3'])
    })

    it("isn't handed out when a link is only added", async () => {
        board = [issue('ORR-3', 'todo', {})]
        await hear({event: {type: 'issue.depends', project: 'orrery', subject: 'ORR-3', by: owner, to: '["ORR-1"]'}})
        expect(sent).toEqual([])
    })

    it('stays blocked when its blocker is canceled, and the owner is asked', async () => {
        links = [{id: 'ORR-3', on: 'ORR-1'}]
        board = [issue('ORR-1', 'canceled'), issue('ORR-3', 'todo', {depends_on: ['ORR-1'], blocked_by: ['ORR-1']})]
        await hear(status('ORR-1', 'in-progress', 'canceled'))
        expect(sent).toEqual([])
        expect(said).toEqual([{issue: 'ORR-3', type: 'issue.blocker_canceled', asks: 'decision'}])
    })

    it('tells the session working on it when its blocker reopens, and nothing for one not started', async () => {
        links = [{id: 'ORR-3', on: 'ORR-1'}, {id: 'ORR-4', on: 'ORR-1'}]
        board = [issue('ORR-1', 'todo'), issue('ORR-3', 'started', {depends_on: ['ORR-1'], blocked_by: ['ORR-1']}), issue('ORR-4', 'todo', {depends_on: ['ORR-1'], blocked_by: ['ORR-1']})]
        await hear(status('ORR-1', 'done', 'todo'))
        expect(said).toEqual([{issue: 'ORR-3', type: 'issue.blocker_reopened'}])
        expect(sent).toEqual([])
    })

    it("does nothing for a schedule run's close or an untrusted session's", async () => {
        waiting()
        await hear({...status('ORR-1', 'in-progress', 'done'), cause: {schedule: 3}}, {event: {...status('ORR-1', 'in-progress', 'done').event, untrusted: true}})
        expect(sent).toEqual([])
    })
})
