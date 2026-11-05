// The local app following the outbox (ORR-983): what the Rust API's writes set off reaches the store's hooks from the
// feed, this server's own rows are skipped, the cursor is kept, and a gap reads the board again.
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {beforeEach, describe, expect, it} from 'vitest'
import type {Change, Page} from '../server/utils/outbox-follower'
import {cursorFile, followOutbox, readCursor, saveCursor} from '../server/utils/outbox-follower'
import type {OrreryEvent} from '../server/store/schema'
import {Store} from '../server/utils/store'
import {testDb} from './db'

const OWNER = {name: 'owner', owner: true}
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

let store: Store
let changed: string[]
let settings: number
let events: OrreryEvent[]

beforeEach(async () => {
    changed = []
    settings = 0
    events = []
    store = new Store(testDb(), project => changed.push(project), undefined, undefined, () => settings++)
    store.happened = event => events.push(event)
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    await tick()
    changed = []
    settings = 0
    events = []
})

const row = (id: number, kind: string, extra: Partial<Change> = {}): Change =>
    ({id, kind, project: 'greenhouse', subject: null, actor: 'claude', owner: 0, session: 'orrery · Vale', untrusted: 0, payload: null, ...extra})

/** Follows the pages given, one read each, and gives the cursors it saved. */
async function follow(pages: Page[], after = 0) {
    const saved: number[] = []
    let reads = 0
    await followOutbox(store, {
        read: async () => pages[reads++] ?? {changes: [], last: saved.at(-1) ?? after},
        after,
        saved: last => saved.push(last),
        stopped: () => reads >= pages.length,
        every: 1,
    })
    await tick()
    return saved
}

const outboxSize = async () => Number((await store.db.get<{n: number | string}>('SELECT count(*) AS n FROM changes'))!.n)

describe('following the outbox', () => {
    it("tells the hooks what a write elsewhere set off, with no second row of its own", async () => {
        const before = await outboxSize()
        await follow([{changes: [
            row(101, 'project.changed'),
            row(102, 'issue.status', {subject: 'GRE-4', payload: JSON.stringify({from: 'todo', to: 'done', person: 'ada'})}),
            row(103, 'settings', {project: null}),
        ], last: 103}])
        expect(changed).toContain('greenhouse')
        expect(events).toEqual([{type: 'issue.status', project: 'greenhouse', subject: 'GRE-4', by: {name: 'claude', owner: false, person: 'ada'}, from: 'todo', to: 'done'}])
        expect(settings).toBe(1)
        expect(await outboxSize()).toBe(before)
    })

    it("skips this server's own rows, whose hooks it heard already", async () => {
        const from = Number((await store.db.get<{n: number | string | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0)
        store.keepOwnChanges()
        const {id} = await store.createIssue('greenhouse', {title: 'Water it'}, OWNER)
        await tick()
        const own = await store.db.all<{id: number | string, kind: string, subject: string | null}>('SELECT id, kind, subject FROM changes WHERE id > ? ORDER BY id', from)
        expect(own.length).toBeGreaterThan(0)
        events = []
        changed = []
        await follow([{changes: own.map(r => row(Number(r.id), r.kind, {subject: r.subject})), last: Number(own.at(-1)!.id)}])
        expect(events.filter(e => e.subject === id)).toEqual([])
        expect(changed).toEqual([])
    })

    it('keeps its cursor, and carries on from it a page at a time', async () => {
        const saved = await follow([{changes: [row(5, 'project.changed')], last: 5}, {changes: [row(6, 'project.changed')], last: 6}], 4)
        expect(saved).toEqual([5, 6])
    })

    it('reads the board again after a gap, and carries on from the newest', async () => {
        const saved = await follow([{changes: [], last: 900, gap: true}], 3)
        expect(changed).toContain('greenhouse')
        expect(settings).toBe(1)
        expect(saved).toEqual([900])
    })

    it('carries on after a read that fails', async () => {
        let reads = 0
        await followOutbox(store, {
            read: async () => {
                reads++
                if (reads === 1) throw new Error('unreachable')
                return {changes: [row(7, 'project.changed')], last: 7}
            },
            after: 6,
            saved: () => {},
            stopped: () => reads >= 2,
            every: 1,
        })
        expect(changed).toContain('greenhouse')
    })
})

describe("the follower's cursor", () => {
    it('is kept beside the database, for that database only', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-cursor-'))
        const database = join(dir, 'orrery.db')
        const file = cursorFile(database)
        expect(file).toBe(`${database}.outbox-cursor.json`)
        expect(readCursor(file, database)).toBeUndefined()
        saveCursor(file, database, 42)
        expect(readCursor(file, database)).toBe(42)
        expect(readCursor(file, join(dir, 'moved.db'))).toBeUndefined()
    })
})
