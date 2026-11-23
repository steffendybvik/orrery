import {beforeEach, describe, expect, it} from 'vitest'
import type {LoggedEvent} from '#shared/roadmap'
import {describe as describeChange, EventLog, HOLD, keepOutOfLog, redact, refusal} from '../server/utils/event-log'
import {writeToApi} from '../server/utils/api-router'
import {ORRERY} from '../server/store/schema'
import {Store} from '../server/utils/store'
import {apiTestDb, withApi} from './api'
import {testDb} from './db'
import type {StandIn} from './log-stand-in'
import {standInApi} from './log-stand-in'

// The log makes a line here and sends it to the Rust API, its one writer (ORR-1088); this server opens no database for
// it (ORR-1135). What the API does with a line (repeats, caps, pruning) is cargo's to test (routes/event_log_tests.rs):
// here a stand-in API keeps what it's sent, and one test sends to the real one.

const scrubbed = async () => (text: string) => text.replaceAll('sk-live-123', '{{secret:STRIPE}}')

let api: StandIn
let log: EventLog
let now: Date

beforeEach(() => {
    api = standInApi()
    now = new Date('2026-10-27T12:00:00Z')
    log = new EventLog(scrubbed, () => now, api.send)
})

describe('the event log', () => {
    it('records errors always, what orrery did only while Advanced is on', async () => {
        api.advanced = false
        expect(await log.record({level: 'info', kind: 'session.started', project: 'hub', message: 'Started a session'})).toBeNull()
        expect(await log.record({level: 'warn', kind: 'session.refused', message: 'At the limit'})).toBeNull()
        expect(await log.record({level: 'error', kind: 'server.error', message: 'boom'})).toMatchObject({level: 'error', kind: 'server.error'})

        api.advanced = true
        log.forget()
        expect(await log.record({level: 'info', kind: 'session.started', project: 'hub', message: 'Started a session'})).toMatchObject({project: 'hub'})
        expect(api.lines.map(e => e.kind)).toEqual(['server.error', 'session.started'])
    })

    it('tells the schedules of a line only when it is news', async () => {
        const ran: unknown[] = []
        log.happened = event => ran.push(event)
        await log.record({level: 'error', kind: 'page.error', message: 'x is undefined'})
        await log.record({level: 'error', kind: 'page.error', message: 'x is undefined'})
        expect(ran).toEqual([{type: 'page.error', level: 'error', subject: 'event 1'}])
        // What orrery did is news each time.
        await log.record({level: 'info', kind: 'backup.made', message: 'Backed up'})
        await log.record({level: 'info', kind: 'backup.made', message: 'Backed up'})
        expect(ran).toHaveLength(3)
    })

    it('keeps secrets, passwords and tokens out', async () => {
        const event = await log.record({level: 'error', kind: 'server.error', message: 'calling with sk-live-123 failed', details: {
            url: 'postgres://orrery:hunter22@db.example.com/orrery',
            nested: {auth: 'Bearer abcdef0123456789'},
        }})
        expect(event?.message).toBe('calling with {{secret:STRIPE}} failed')
        expect(event?.details).toEqual({url: 'postgres://orrery:…@db.example.com/orrery', nested: {auth: 'Bearer …'}})
        expect(redact('Basic dXNlcjpwYXNzd29yZA==')).toBe('Basic …')
        // A password with no user, with an @ in it, or given as a setting.
        expect(redact('postgres://:hunter22@db/orrery')).toBe('postgres://:…@db/orrery')
        expect(redact('postgres://me:hun@ter22@db/orrery and more')).toBe('postgres://me:…@db/orrery and more')
        expect(redact('postgres://me@db/orrery?sslmode=require&password=hunter22')).toBe('postgres://me@db/orrery?sslmode=require&password=…')
        expect(redact("host=db user=me password='hunter 22' dbname=orrery")).toBe('host=db user=me password=… dbname=orrery')
        expect(redact('host=db password=hunter22')).toBe('host=db password=…')
    })

    it("keeps orrery's own credentials out: keys, the login cookie, links' tokens and the API's token (ORR-1392)", () => {
        expect(redact('key orrery_agent_AbC-123_xyzXYZ0987 refused')).toBe('key orrery_agent_… refused')
        expect(redact('ORRERY_PERSON_abcdefgh12345678')).toBe('ORRERY_PERSON_…')
        expect(redact('cookie: orrery_login_9000=s3cr3tvalue; other=1')).toBe('cookie: orrery_login_9000=…; other=1')
        expect(redact('GET https://o.example/login?t=abcd1234efgh&x=1')).toBe('GET https://o.example/login?t=…&x=1')
        expect(redact('/join?invite=abc123def456')).toBe('/join?invite=…')
        expect(redact('NUXT_API_TOKEN=deadbeefcafe0123 node')).toBe('NUXT_API_TOKEN=… node')
        expect(redact('{"Orrery-Api-Token":"deadbeefcafe0123"}')).toBe('{"Orrery-Api-Token":"…"}')
        const token = 'f00dfacef00dface0123456789'
        const letIn = keepOutOfLog(token)
        expect(redact(`fetch failed: ${token}`)).toBe('fetch failed: …')
        letIn()
        expect(redact(token)).toBe(token)
    })

    it('reads Advanced and the secrets once, and again only once told they changed', async () => {
        let made = 0
        const counted = new EventLog(async () => {
            made++
            return text => text
        }, () => now, api.send)
        api.advanced = false
        await counted.record({level: 'error', kind: 'server.error', message: 'one'})
        await counted.record({level: 'error', kind: 'server.error', message: 'two'})
        expect(made).toBe(1)
        expect(await counted.record({level: 'info', kind: 'backup.made', message: 'Backed up'})).toBeNull()

        api.advanced = true
        expect(await counted.record({level: 'info', kind: 'backup.made', message: 'Backed up'})).toBeNull()
        counted.forget()
        expect(await counted.record({level: 'info', kind: 'backup.made', message: 'Backed up'})).toMatchObject({kind: 'backup.made'})
        expect(made).toBe(2)
        expect(api.sent.filter(s => s.path === '/api/settings')).toHaveLength(2)
    })

    it('sends each change to the roadmap as a line of its own, while Advanced is on', async () => {
        const moved = {type: 'issue.status', project: 'hub', subject: 'HUB-1', by: {name: 'claude', owner: false}, from: 'todo', to: 'done'}
        api.advanced = false
        expect(await log.activity(moved)).toBeNull()

        api.advanced = true
        log.forget()
        const first = await log.activity(moved, 7)
        expect(first).toMatchObject({level: 'info', kind: 'issue.status', project: 'hub', subject: 'HUB-1',
            message: 'claude moved HUB-1: todo → done', details: {by: 'claude', owner: false, from: 'todo', to: 'done', schedule: 7}})
        expect((await log.activity(moved))?.id).not.toBe(first?.id)
        expect(api.sent.at(-1)?.body).toMatchObject({activity: true})
    })

    it('takes the changes as the store says them, with no text an outsider wrote', async () => {
        const store = new Store(testDb())
        const said: Promise<unknown>[] = []
        store.happened = event => said.push(log.activity(event))
        const owner = {name: 'skoll', owner: true}
        await store.createProject({name: 'hub', key: 'HUB'})
        const issue = await store.createIssue('hub', {title: 'Secret plans', notes: 'sk-live-123'}, owner)
        await store.updateIssue('hub', issue.id, {status: 'in-progress', title: 'Other plans', notes: 'more'}, {name: 'claude', owner: false})
        await store.createComment('hub', issue.id, {body: 'hello'}, {name: 'claude', owner: false})
        await Promise.all(said)

        expect(api.lines.filter(e => e.subject === issue.id).map(e => e.message)).toEqual([
            `skoll made ${issue.id}`,
            `claude changed ${issue.id}'s title`,
            `claude moved ${issue.id}: backlog → in-progress`,
            `claude changed ${issue.id}'s notes`,
            `claude commented on ${issue.id}`,
        ])
        expect(JSON.stringify(api.sent)).not.toMatch(/Secret|Other plans|sk-live|hello|more/)
    })

    it('says a change in a line', () => {
        const by = {name: 'claude', owner: false}
        expect(describeChange({type: 'issue.created', subject: 'HUB-1', by})).toBe('claude made HUB-1')
        expect(describeChange({type: 'issue.priority', subject: 'HUB-1', by, to: 'P1'})).toBe("claude changed HUB-1's priority: none → P1")
        expect(describeChange({type: 'issue.title', subject: 'HUB-1', by})).toBe("claude changed HUB-1's title")
        expect(describeChange({type: 'comment.asks', subject: 'HUB-1', by, to: 'decision'})).toBe('claude asked the owner for a decision on HUB-1')
        expect(describeChange({type: 'release.frozen', subject: '1.0.0', by})).toBe('claude set release 1.0.0 frozen')
        expect(describeChange({type: 'doc.changed', subject: 'api', by})).toBe('claude wrote doc api')
        expect(describeChange({type: 'milestone.created', subject: '3'})).toBe('Someone made milestone 3')
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
        // One the permissions table refused names its row (ORR-512).
        expect(refusal(403, 'POST', '/api/notices/clear', 'Clear the bell', 'claude', 'notices.clear')?.details).toMatchObject({permission: 'notices.clear'})
    })

    // With login on, the checked person and their workspace, never the name sent (ORR-1377).
    it("names the checked person, goes in the asker's workspace, and names only a project they see", () => {
        const bo = {name: 'claude', person: 'bo', workspace: 'acme', sees: new Set(['rockets'])}
        expect(refusal(403, 'POST', '/api/secrets', 'Only the owner', bo)).toEqual({
            level: 'warn', kind: 'request.refused', workspace: 'acme',
            message: "Refused claude (bo's agent) POST /api/secrets: Only the owner",
            details: {route: 'POST /api/secrets', status: 403, by: 'claude', person: 'bo'},
        })
        expect(refusal(403, 'PATCH', '/api/projects/rockets/issues/ROC-1', 'No', bo)).toMatchObject({project: 'rockets', workspace: 'acme'})
        // Another's project: in bo's log, without its name.
        const theirs = refusal(403, 'PATCH', '/api/projects/primes/issues/PRI-1', 'No', bo)
        expect(theirs).toMatchObject({workspace: 'acme'})
        expect(theirs?.project).toBeUndefined()
        expect(refusal(403, 'POST', '/api/chats', 'No', {name: 'bo', person: 'bo', workspace: 'acme'})?.message).toBe('Refused bo POST /api/chats: No')
    })

    it('sends the workspace a line names along with it', async () => {
        api.advanced = true
        await log.record({level: 'warn', kind: 'request.refused', message: 'Refused bo', workspace: 'acme'})
        expect(api.sent.find(sent => sent.path === '/api/events/log/lines')?.body).toMatchObject({kind: 'request.refused', workspace: 'acme'})
    })

    it("tells the schedules an untrusted session's refusal is its, so none runs on it", async () => {
        const told: {untrusted?: boolean}[] = []
        log.happened = event => told.push(event)
        api.advanced = false
        await log.record({level: 'warn', kind: 'request.refused', message: 'Refused', untrusted: true})
        api.advanced = true
        log.forget()
        await log.record({level: 'warn', kind: 'request.refused', message: 'Refused again', untrusted: true})
        await log.record({level: 'warn', kind: 'request.refused', message: 'Refused the owner'})
        expect(told.map(event => !!event.untrusted)).toEqual([true, true, false])
    })

    it('sends a finished line to the API, scrubbed, and prunes there (ORR-1088)', async () => {
        const event = await log.record({level: 'error', kind: 'server.error', project: 'hub', message: 'Paid with sk-live-123', details: {stack: 'at sk-live-123'}})
        expect(event).toMatchObject({id: 1, kind: 'server.error'})
        expect(api.sent).toEqual([{method: 'PUT', path: '/api/events/log/lines', body: {level: 'error', kind: 'server.error', project: 'hub',
            message: 'Paid with {{secret:STRIPE}}', details: {stack: 'at {{secret:STRIPE}}'}}}])
        expect(await log.prune()).toBe(3)
    })

    it("holds what's said while the API can't be reached, and says it once it answers (ORR-1135)", async () => {
        api.down = true
        const ran: unknown[] = []
        log.happened = event => ran.push(event)
        expect(await log.record({level: 'error', kind: 'api.unreachable', message: 'Gone', details: {why: 'unreachable'}})).toBeNull()
        later(1000)
        expect(await log.activity({type: 'issue.status', project: 'hub', subject: 'HUB-1', from: 'todo', to: 'done'})).toBeNull()
        expect(log.waiting).toBe(2)
        expect(await log.prune()).toBe(0)
        expect(ran).toEqual([])

        // It answers: the next line says what was held first, oldest first, each with when it happened.
        api.down = false
        later(1000)
        await log.record({level: 'error', kind: 'server.error', message: 'After'})
        expect(log.waiting).toBe(0)
        expect(api.lines.map(l => [l.kind, (l.details as {held?: string} | null)?.held])).toEqual([
            ['api.unreachable', '2026-10-27T12:00:00.000Z'],
            ['issue.status', '2026-10-27T12:00:01.000Z'],
            ['server.error', undefined],
        ])
        expect(api.lines[0]?.details).toMatchObject({why: 'unreachable'})
        // The schedules hear them now, as they're kept.
        expect(ran).toHaveLength(2)
    })

    it('holds a line with no API set up at all, and at most HOLD of them, saying how many went', async () => {
        let set = false
        const unset = new EventLog(scrubbed, () => now, async (...asked) => set ? await api.send(...asked) : undefined)
        for (let i = 0; i < HOLD + 2; i++) await unset.record({level: 'error', kind: 'server.error', message: `boom ${i}`})
        expect(unset.waiting).toBe(HOLD)
        set = true
        await unset.flush()
        expect(api.lines[0]?.message).toBe('boom 2')
        expect(api.lines.at(-1)).toMatchObject({level: 'warn', kind: 'events.dropped', details: {dropped: 2}})
    })

    it('lets go of a held line the API refuses, and says nothing of a refusal while it is up', async () => {
        api.down = true
        await log.record({level: 'error', kind: 'server.error', message: 'Held'})
        api.down = false
        api.refusing = Object.assign(new Error('"kind" is wrong'), {statusCode: 400})
        const said = console.error
        console.error = () => {}
        try {
            await log.flush()
        } finally {
            console.error = said
        }
        expect(log.waiting).toBe(0)
        await expect(log.record({level: 'error', kind: 'server.error', message: 'Boom'})).rejects.toThrow('"kind" is wrong')
        expect(log.waiting).toBe(0)
    })

    it('writes through the real API, which keeps it (ORR-1088)', async () => {
        const store = new Store(apiTestDb())
        await withApi(store)
        const real = new EventLog(scrubbed, () => now, async (method, path, body) => (await writeToApi(method, path, body, ORRERY, {always: true}))?.reply)
        const event = await real.record({level: 'error', kind: 'server.error', project: undefined, message: 'Paid with sk-live-123'})
        expect(event).toMatchObject({kind: 'server.error', message: 'Paid with {{secret:STRIPE}}'})
        const kept = (await writeToApi('GET', '/api/events/log', undefined, ORRERY, {always: true}))?.reply as LoggedEvent[]
        expect(kept.map(e => e.message)).toEqual(['Paid with {{secret:STRIPE}}'])
    }, 30_000)
})

function later(ms: number) {
    now = new Date(now.getTime() + ms)
}
