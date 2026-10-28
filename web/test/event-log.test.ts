import {beforeEach, describe, expect, it} from 'vitest'
import type {LoggedEvent} from '#shared/roadmap'
import {describe as describeChange, EventLog, KEEP_INFO, KEEP_PROBLEMS, redact, refusal} from '../server/utils/event-log'
import {Store} from '../server/utils/store'
import {testDb} from './db'

const owner = {name: 'skoll', owner: true}
let store: Store
let log: EventLog
let now: Date
let heard: {event: LoggedEvent, fresh: boolean}[]

beforeEach(() => {
    store = new Store(testDb())
    now = new Date('2026-10-27T12:00:00Z')
    heard = []
    log = new EventLog(store.db, async () => text => text.replaceAll('sk-live-123', '{{secret:STRIPE}}'), (event, fresh) => heard.push({event, fresh}), () => now)
})

const later = (ms: number) => {
    now = new Date(now.getTime() + ms)
}

describe('the event log', () => {
    it('records errors always, what Orrery did only while Advanced is on', async () => {
        expect(await log.record({level: 'info', kind: 'session.started', project: 'hub', message: 'Started a session'})).toBeNull()
        expect(await log.record({level: 'warn', kind: 'session.refused', message: 'At the limit'})).toBeNull()
        expect(await log.record({level: 'error', kind: 'server.error', message: 'boom'})).toMatchObject({level: 'error', kind: 'server.error', count: 1})

        await store.updateSettings({advanced: true}, owner)
        log.forget()
        expect((await store.settings()).advanced).toBe(true)
        expect(await log.record({level: 'info', kind: 'session.started', project: 'hub', message: 'Started a session'})).toMatchObject({project: 'hub', count: 1})
        expect((await log.list()).map(e => e.kind)).toEqual(['session.started', 'server.error'])
    })

    it('writes a repeat as a line of its own, but as no news until it is resolved', async () => {
        const first = await log.record({level: 'error', kind: 'page.error', message: 'x is undefined', details: {page: '/now'}})
        later(1000)
        const again = await log.record({level: 'error', kind: 'page.error', message: 'x is undefined', details: {page: '/mine'}})
        expect(again).toMatchObject({count: 1, first_seen: now.toISOString(), details: {page: '/mine'}})
        expect(again?.id).not.toBe(first?.id)
        expect(heard.map(h => h.fresh)).toEqual([true, false])

        // In another project, or another message, it's news.
        await log.record({level: 'error', kind: 'page.error', project: 'hub', message: 'x is undefined'})
        expect(heard.at(-1)?.fresh).toBe(true)

        // Resolving one resolves its repeats, and the next is news again.
        const resolved = await log.resolve(first?.id ?? 0)
        expect(resolved.resolved_at).toBe(now.toISOString())
        expect((await log.list({open: true})).map(e => e.project)).toEqual(['hub'])
        await log.record({level: 'error', kind: 'page.error', message: 'x is undefined'})
        expect(heard.at(-1)?.fresh).toBe(true)
    })

    it('keeps secrets, passwords and tokens out', async () => {
        const event = await log.record({level: 'error', kind: 'server.error', message: 'calling with sk-live-123 failed', details: {
            url: 'postgres://orrery:hunter22@db.example.com/orrery',
            nested: {auth: 'Bearer abcdef0123456789'},
        }})
        expect(event?.message).toBe('calling with {{secret:STRIPE}} failed')
        expect(event?.details).toEqual({url: 'postgres://orrery:…@db.example.com/orrery', nested: {auth: 'Bearer …'}})
        expect(redact('Basic dXNlcjpwYXNzd29yZA==')).toBe('Basic …')
    })

    it('reads Advanced and the secrets once, and again only once told they changed', async () => {
        let made = 0
        const counted = new EventLog(store.db, async () => {
            made++
            return text => text
        })
        await counted.record({level: 'error', kind: 'server.error', message: 'one'})
        await counted.record({level: 'error', kind: 'server.error', message: 'two'})
        expect(made).toBe(1)
        expect(await counted.record({level: 'info', kind: 'backup.made', message: 'Backed up'})).toBeNull()

        await store.updateSettings({advanced: true}, owner)
        expect(await counted.record({level: 'info', kind: 'backup.made', message: 'Backed up'})).toBeNull()
        counted.forget()
        expect(await counted.record({level: 'info', kind: 'backup.made', message: 'Backed up'})).toMatchObject({kind: 'backup.made'})
        expect(made).toBe(2)
    })

    it('lists by level, kind, project and time, newest first', async () => {
        await store.updateSettings({advanced: true}, owner)
        log.forget()
        await log.record({level: 'info', kind: 'launcher.connected', project: 'hub', message: 'A launcher connected'})
        later(1000)
        await log.record({level: 'info', kind: 'session.started', project: 'hub', message: 'Started a session'})
        later(1000)
        await log.record({level: 'warn', kind: 'session.refused', project: 'css', message: 'At the limit'})
        later(1000)
        const error = await log.record({level: 'error', kind: 'schedule.failed', project: 'hub', message: 'Groom: failed'})

        expect((await log.list()).map(e => e.kind)).toEqual(['schedule.failed', 'session.refused', 'session.started', 'launcher.connected'])
        expect((await log.list({level: 'warn,error'})).map(e => e.kind)).toEqual(['schedule.failed', 'session.refused'])
        expect((await log.list({kind: 'session'})).map(e => e.kind)).toEqual(['session.refused', 'session.started'])
        expect((await log.list({project: 'css'})).map(e => e.kind)).toEqual(['session.refused'])
        expect((await log.list({since: new Date(now.getTime() - 1500).toISOString()})).map(e => e.kind)).toEqual(['schedule.failed', 'session.refused'])
        await log.resolve(error?.id ?? 0)
        expect((await log.list({level: 'error', open: true}))).toEqual([])
        await expect(log.list({level: 'loud'})).rejects.toMatchObject({statusCode: 400})
        // No level at all is no filter, and a kind's `_` is itself, not any one character.
        expect(await log.list({level: ','})).toHaveLength(4)
        await log.record({level: 'info', kind: 'launcher_x.gone', message: 'Gone'})
        await log.record({level: 'info', kind: 'launcherx.gone', message: 'Gone'})
        expect((await log.list({kind: 'launcher_x'})).map(e => e.kind)).toEqual(['launcher_x.gone'])
        await expect(log.record({level: 'error', kind: 'Not A Kind', message: 'x'})).rejects.toMatchObject({statusCode: 400})
        await expect(log.resolve(9999)).rejects.toMatchObject({statusCode: 404})
    })

    it('records each change to the roadmap as a row of its own, while Advanced is on', async () => {
        const moved = {type: 'issue.status', project: 'hub', subject: 'HUB-1', by: {name: 'claude', owner: false}, from: 'todo', to: 'done'}
        expect(await log.activity(moved)).toBeNull()

        await store.updateSettings({advanced: true}, owner)
        log.forget()
        const first = await log.activity(moved, 7)
        expect(first).toMatchObject({level: 'info', kind: 'issue.status', project: 'hub', subject: 'HUB-1', count: 1,
            message: 'claude moved HUB-1: todo → done', details: {by: 'claude', owner: false, from: 'todo', to: 'done', schedule: 7}})
        expect((await log.activity(moved))?.id).not.toBe(first?.id)
        expect(heard.map(h => h.fresh)).toEqual([true, true])
        await log.activity({type: 'comment.added', project: 'hub', subject: 'HUB-2', by: {name: 'skoll', owner: true}})

        expect((await log.list({subject: 'HUB-1'})).map(e => e.kind)).toEqual(['issue.status', 'issue.status'])
        expect((await log.list({kind: 'comment'})).map(e => e.message)).toEqual(['skoll commented on HUB-2'])
    })

    it('takes the changes as the store says them, with no text an outsider wrote', async () => {
        await store.updateSettings({advanced: true}, owner)
        log.forget()
        const said: Promise<unknown>[] = []
        store.happened = event => said.push(log.activity(event))
        await store.createProject({name: 'hub', key: 'HUB'})
        const issue = await store.createIssue('hub', {title: 'Secret plans', notes: 'sk-live-123'}, owner)
        await store.updateIssue('hub', issue.id, {status: 'in-progress', title: 'Other plans', notes: 'more'}, {name: 'claude', owner: false})
        await store.createComment('hub', issue.id, {body: 'hello'}, {name: 'claude', owner: false})
        await Promise.all(said)

        const rows = await log.list({subject: issue.id})
        expect(rows.map(e => e.message).toReversed()).toEqual([
            `skoll made ${issue.id}`,
            `claude changed ${issue.id}'s title`,
            `claude moved ${issue.id}: backlog → in-progress`,
            `claude changed ${issue.id}'s notes`,
            `claude commented on ${issue.id}`,
        ])
        expect(JSON.stringify(rows)).not.toMatch(/Secret|Other plans|sk-live|hello|more/)
    })

    it('says a change in a line', () => {
        const by = {name: 'claude', owner: false}
        expect(describeChange({type: 'issue.created', subject: 'HUB-1', by})).toBe('claude made HUB-1')
        expect(describeChange({type: 'issue.priority', subject: 'HUB-1', by, to: 'P1'})).toBe("claude changed HUB-1's priority: none → P1")
        expect(describeChange({type: 'issue.title', subject: 'HUB-1', by})).toBe("claude changed HUB-1's title")
        expect(describeChange({type: 'comment.asks', subject: 'HUB-1', by, to: 'decision'})).toBe('claude asked the owner for a decision on HUB-1')
        expect(describeChange({type: 'release.frozen', subject: '1.0.0', by})).toBe('claude set release 1.0.0 frozen')
        expect(describeChange({type: 'doc.changed', subject: 'api', by})).toBe('claude wrote doc api')
        expect(describeChange({type: 'chunk.created', subject: '3'})).toBe('Someone made chunk 3')
    })

    it('takes a 403 or 409 as a refusal, with who asked and the route without its query', () => {
        expect(refusal(403, 'PATCH', '/api/projects/orrery/issues/ORR-3?x=secret', "ORR-3 is a proposal waiting on the owner", 'claude')).toEqual({
            level: 'warn', kind: 'request.refused', project: 'orrery',
            message: 'Refused claude PATCH /api/projects/orrery/issues/ORR-3: ORR-3 is a proposal waiting on the owner',
            details: {route: 'PATCH /api/projects/orrery/issues/ORR-3', status: 403, by: 'claude'},
        })
        expect(refusal(409, 'POST', '/api/database/move', 'The database is already being moved')).toMatchObject({message: 'Refused agent POST /api/database/move: The database is already being moved', details: {by: 'agent'}})
        expect(refusal(409, 'POST', '/api/database/move', '')?.project).toBeUndefined()
        // The launches route says why a start was refused itself, as session.refused.
        expect(refusal(409, 'POST', '/api/projects/orrery/launches', 'At the limit')).toBeNull()
        expect(refusal(403, 'POST', '/api/projects/orrery/launches', 'Only the owner')).not.toBeNull()
        expect(refusal(404, 'GET', '/api/projects/nope', 'No project nope')).toBeNull()
    })

    it("tells the schedules an untrusted session's refusal is its, so none runs on it", async () => {
        const told: {untrusted?: boolean}[] = []
        log.happened = event => told.push(event)
        await log.record({level: 'warn', kind: 'request.refused', message: 'Refused', untrusted: true})
        await store.updateSettings({advanced: true}, owner)
        log.forget()
        await log.record({level: 'warn', kind: 'request.refused', message: 'Refused again', untrusted: true})
        await log.record({level: 'warn', kind: 'request.refused', message: 'Refused the owner'})
        expect(told.map(event => !!event.untrusted)).toEqual([true, true, false])
    })

    it('caps the changes to the roadmap apart from the rest, so they cannot push an error out', async () => {
        await store.updateSettings({advanced: true}, owner)
        log.forget()
        await log.record({level: 'error', kind: 'server.error', message: 'boom'})
        // Past the cap, written straight in: 5000 through activity() would be slow.
        const at = now.toISOString()
        await store.db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5002)
            INSERT INTO events (level, kind, project, subject, message, count, first_seen, last_seen)
            SELECT 'info', 'issue.status', 'hub', 'HUB-' || i, 'moved', 1, ?, ? FROM n`, at, at)
        expect(await log.prune()).toBe(2)
        expect(await log.list({level: 'error'})).toHaveLength(1)
        expect(await log.list({kind: 'issue', limit: 1000})).toHaveLength(1000)
    })

    it('lets go of what Orrery did after a week, problems after a month', async () => {
        await store.updateSettings({advanced: true}, owner)
        log.forget()
        await log.record({level: 'info', kind: 'backup.made', message: 'Backed up'})
        await log.record({level: 'error', kind: 'backup.failed', message: 'Disk full'})
        later(KEEP_INFO + 1000)
        expect(await log.prune()).toBe(1)
        expect((await log.list()).map(e => e.kind)).toEqual(['backup.failed'])
        later(KEEP_PROBLEMS)
        expect(await log.prune()).toBe(1)
        expect(await log.list()).toEqual([])
    })
})
