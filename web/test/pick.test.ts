import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// A session out of work picking its next issue (ORR-452), with Nitro's auto-imports stubbed: the session as it is, the
// board, and what it's sent.
let pick: typeof import('../server/utils/pick')
type Listed = {id: string, project: string, state: string, listening: boolean, also?: string[], started?: {launch: string}, idleAt?: number}
let sessions: Listed[]
let board: Record<string, {id: string, title: string, kind: string, column: string, priority?: string, parent?: string, proposal?: string, waiting?: string, assignee?: string, release?: string, created_at: string}[]>
let on: boolean
let working: string[]
let waiting: boolean
let run: {project: string, chunk: string} | undefined
let left: {id: string}[]
let untrusted: boolean
let chat: boolean
let due: string[]
let sent: {project: string, session: string, text: string, owner: boolean}[]

const issue = (id: string, kind: string, more: Record<string, string> = {}) =>
    ({id, title: `Do ${id}`, kind, column: kind === 'todo' ? 'Todo' : 'Backlog', created_at: `2026-10-29T0${id.slice(-1)}:00:00Z`, ...more})

beforeEach(async () => {
    vi.useFakeTimers()
    sessions = [{id: 'w', project: 'orrery', state: 'idle', listening: true, idleAt: 1}]
    board = {orrery: [issue('ORR-1', 'todo', {priority: 'P2'}), issue('ORR-2', 'todo', {priority: 'P0'}), issue('ORR-3', 'backlog', {priority: 'P0'})]}
    on = true
    working = []
    waiting = false
    run = undefined
    left = []
    untrusted = false
    chat = false
    due = []
    sent = []
    vi.stubGlobal('sessionNow', (id: string) => sessions.find(s => s.id === id))
    vi.stubGlobal('listSessions', () => sessions)
    vi.stubGlobal('sessionIds', (id: string) => [id])
    vi.stubGlobal('currentId', (id: string) => id)
    vi.stubGlobal('untrustedSession', () => untrusted)
    vi.stubGlobal('chatSession', () => chat)
    vi.stubGlobal('runOf', () => run)
    vi.stubGlobal('scopeOf', async () => ({open: left}))
    vi.stubGlobal('CLEAR_AFTER', 5000)
    vi.stubGlobal('clearPending', (id: string) => due.includes(id))
    vi.stubGlobal('useStore', () => ({
        settings: async () => ({pick_next: on}),
        ownerOf: async () => ({name: 'steffen'}),
        listIssues: async (project: string) => board[project] ?? [],
        workingOn: async (_project: string, _ids: string[]) => working.map(id => ({id})),
        waiting: async (_project: string, _ids: string[]) => waiting,
        async busy(project: string, ids: string[]) {
            return (await this.workingOn(project, ids)).length > 0 || await this.waiting(project, ids)
        },
        project: async () => ({releases: [{version: '1.0.0', frozen_on: '2026-10-28'}]}),
        messageSession: async (project: string, session: string, text: string, actor: {owner: boolean}) => void sent.push({project, session, text, owner: actor.owner}),
    }))
    vi.resetModules()
    pick = await import('../server/utils/pick')
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

const ids = (text: string) => [...text.matchAll(/^- (\S+)/gm)].map(m => m[1])

describe('a session out of work', () => {
    it('is handed Todo, most urgent first, as the owner, alone', async () => {
        expect(await pick.pickNext('orrery', 'w')).toBe(true)
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({project: 'orrery', session: 'w', owner: true})
        expect(sent[0]!.text.startsWith(pick.PICK_NOTE)).toBe(true)
        expect(ids(sent[0]!.text)).toEqual(['ORR-2', 'ORR-1'])
    })

    it('is handed Backlog once Todo is empty, and nothing it may not start', async () => {
        board.orrery = [
            issue('ORR-1', 'backlog'), issue('ORR-2', 'backlog', {proposal: 'pending'}), issue('ORR-3', 'backlog', {waiting: 'decision'}),
            issue('ORR-4', 'backlog', {assignee: 'steffen'}), issue('ORR-5', 'backlog'), issue('ORR-6', 'backlog', {parent: 'ORR-5'}),
            issue('ORR-7', 'started'), issue('ORR-8', 'backlog', {assignee: 'ada'}), issue('ORR-9', 'backlog', {assignee: 'Claude'}),
        ]
        await pick.pickNext('orrery', 'w')
        // ORR-5 is a parent: its sub-issue is the work.
        expect(ids(sent[0]!.text)).toEqual(['ORR-1', 'ORR-6', 'ORR-9'])
    })

    it('gets the issues of every project it hears, and a frozen release says so', async () => {
        sessions[0]!.also = ['pantry']
        board.pantry = [issue('PAN-1', 'todo', {priority: 'P1', release: '1.0.0'})]
        await pick.pickNext('orrery', 'w')
        expect(ids(sent[0]!.text)).toEqual(['ORR-2', 'PAN-1', 'ORR-1'])
        expect(sent[0]!.text).toContain('PAN-1 (pantry) [Todo, P1] Do PAN-1 (1.0.0 is in feature freeze')
    })

    it("isn't handed anything with the setting off, with work of its own, or when it isn't free", async () => {
        on = false
        expect(await pick.pickNext('orrery', 'w')).toBe(false)
        on = true
        working = ['ORR-9']
        expect(await pick.pickNext('orrery', 'w')).toBe(false)
        working = []
        waiting = true
        expect(await pick.pickNext('orrery', 'w')).toBe(false)
        waiting = false
        run = {project: 'orrery', chunk: '4'}
        left = [{id: 'ORR-8'}]
        expect(await pick.pickNext('orrery', 'w')).toBe(false)
        run = undefined
        for (const set of [() => untrusted = true, () => chat = true, () => sessions[0]!.state = 'working', () => sessions[0]!.listening = false]) {
            untrusted = chat = false
            sessions[0]!.state = 'idle'
            sessions[0]!.listening = true
            set()
            expect(await pick.pickNext('orrery', 'w')).toBe(false)
        }
        expect(sent).toEqual([])
    })

    it('is sent nothing with nothing to pick, and not the same list twice', async () => {
        board.orrery = []
        expect(await pick.pickNext('orrery', 'w')).toBe(false)
        board.orrery = [issue('ORR-1', 'todo')]
        expect(await pick.pickNext('orrery', 'w')).toBe(true)
        expect(await pick.pickNext('orrery', 'w')).toBe(false)
        board.orrery.push(issue('ORR-2', 'todo'))
        expect(await pick.pickNext('orrery', 'w')).toBe(true)
        expect(sent).toHaveLength(2)
    })

    it('picks a moment after going idle, unless orrery started it (that one picks after its clear)', async () => {
        pick.pickWhenIdle('orrery', 'w')
        await vi.advanceTimersByTimeAsync(5010)
        expect(sent).toHaveLength(1)
        sessions = [{id: 's', project: 'orrery', state: 'idle', listening: true, idleAt: 1, started: {launch: 'l1'}}]
        pick.pickWhenIdle('orrery', 's')
        await vi.advanceTimersByTimeAsync(5010)
        expect(sent).toHaveLength(1)
    })

    it('when the board changes, hands the idle sessions their lists one at a time, apart', async () => {
        sessions.push({id: 'x', project: 'orrery', state: 'idle', listening: true}, {id: 'y', project: 'orrery', state: 'working', listening: true})
        pick.recheckIdle()
        pick.recheckIdle()
        await vi.advanceTimersByTimeAsync(pick.RECHECK_AFTER + 10)
        expect(sent.map(s => s.session)).toEqual(['w'])
        await vi.advanceTimersByTimeAsync(pick.PICK_APART)
        expect(sent.map(s => s.session)).toEqual(['w', 'x'])
    })

    it("when the board changes, leaves one orrery started that's due its clear to pick after it (ORR-527)", async () => {
        sessions.push({id: 's', project: 'orrery', state: 'idle', listening: true, idleAt: 1, started: {launch: 'l1'}})
        due = ['s']
        pick.recheckIdle()
        await vi.advanceTimersByTimeAsync(pick.RECHECK_AFTER + pick.PICK_APART + 10)
        expect(sent.map(s => s.session)).toEqual(['w'])
        due = []
        expect(await pick.pickNext('orrery', 's')).toBe(true)
    })

    it('when the board changes, passes over one that becomes due its clear while the one before waits (ORR-527)', async () => {
        sessions.push({id: 's', project: 'orrery', state: 'idle', listening: true, idleAt: 1, started: {launch: 'l1'}})
        pick.recheckIdle()
        await vi.advanceTimersByTimeAsync(pick.RECHECK_AFTER + 10)
        expect(sent.map(s => s.session)).toEqual(['w'])
        // A short turn of its own in those seconds, and its Stop makes it due its clear.
        due = ['s']
        await vi.advanceTimersByTimeAsync(pick.PICK_APART + 10)
        expect(sent.map(s => s.session)).toEqual(['w'])
        expect(await pick.pickNext('orrery', 's')).toBe(false)
    })
})
