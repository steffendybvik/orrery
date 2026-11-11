// The local app following the outbox (ORR-983): what the Rust API's writes set off reaches the store's hooks from the
// feed, this server's own rows are skipped, the cursor is kept, and a gap reads the board again.
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {beforeEach, describe, expect, it} from 'vitest'
import type {Change, Page} from '../server/utils/outbox-follower'
import {caughtUp, cursorFile, followOutbox, readCursor, saveCursor, setFollowingOutbox} from '../server/utils/outbox-follower'
import type {OrreryEvent} from '../server/store/schema'
import {Store} from '../server/utils/store'
import {projectEvents} from '../server/utils/events'
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

    it("pushes a line of the event log the API resolved to open pages' bells (ORR-1088)", async () => {
        const heard: unknown[] = []
        const hear = (logged: unknown) => heard.push(logged)
        projectEvents.on('logged', hear)
        const line = {id: 7, level: 'error', kind: 'server.error', message: 'Boom', count: 1, first_seen: 'x', last_seen: 'x', resolved_at: 'y', resolved_by: 'claude'}
        await follow([{changes: [row(101, 'event.logged', {project: null, payload: line})], last: 101}])
        projectEvents.off('logged', hear)
        expect(heard).toEqual([{event: line, fresh: false}])
        expect(changed).toEqual([])
    })

    it("pushes a new line the API wrote as news only when it says it's fresh (ORR-1088)", async () => {
        const heard: unknown[] = []
        const hear = (logged: unknown) => heard.push(logged)
        projectEvents.on('logged', hear)
        const line = {id: 8, level: 'error', kind: 'page.error', message: 'Boom', count: 1, first_seen: 'x', last_seen: 'x'}
        await follow([{changes: [row(101, 'event.logged', {project: null, payload: {...line, fresh: true}}), row(102, 'event.logged', {project: null, payload: {...line, id: 9}})], last: 102}])
        projectEvents.off('logged', hear)
        expect(heard).toEqual([{event: line, fresh: true}, {event: {...line, id: 9}, fresh: false}])
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

describe('catching up before a reply (ORR-1029)', () => {
    it('is at once when not following', async () => {
        setFollowingOutbox(false)
        await caughtUp(10_000)
    })

    it("wakes the follower from its pause and waits for what's in the outbox now", async () => {
        setFollowingOutbox(true)
        let stop = false
        let written = false
        const following = followOutbox(store, {
            read: async after => written && after < 9 ? {changes: [row(9, 'project.changed')], last: 9} : {changes: [], last: after},
            after: 8,
            saved: () => {},
            stopped: () => stop,
            every: 60_000,
        })
        try {
            await tick()
            written = true
            const started = Date.now()
            await caughtUp(10_000)
            // Told before the wait ends, though its pause is a minute long.
            expect(changed).toContain('greenhouse')
            expect(Date.now() - started).toBeLessThan(5_000)
        } finally {
            // Woken once more, it sees it's stopped and ends.
            stop = true
            await caughtUp(1_000)
            setFollowingOutbox(false)
        }
        await following
    })

    it("gives up after its time, so a feed that can't be read never holds a reply", async () => {
        setFollowingOutbox(true)
        try {
            const started = Date.now()
            await caughtUp(20)
            expect(Date.now() - started).toBeLessThan(1_000)
        } finally {
            setFollowingOutbox(false)
        }
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
