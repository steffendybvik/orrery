import {beforeEach, describe, expect, it} from 'vitest'
import type {LoggedEvent} from '#shared/roadmap'
import {EventLog, KEEP_INFO, KEEP_PROBLEMS, redact} from '../server/utils/event-log'
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

    it('folds a repeat into its row until it is resolved', async () => {
        const first = await log.record({level: 'error', kind: 'page.error', message: 'x is undefined', details: {page: '/now'}})
        later(1000)
        const again = await log.record({level: 'error', kind: 'page.error', message: 'x is undefined', details: {page: '/mine'}})
        expect(again).toMatchObject({id: first?.id, count: 2, first_seen: first?.first_seen, details: {page: '/mine'}})
        expect(again?.last_seen).toBe(now.toISOString())
        expect(heard.map(h => h.fresh)).toEqual([true, false])

        // In another project, or another message, it's a row of its own.
        expect((await log.record({level: 'error', kind: 'page.error', project: 'hub', message: 'x is undefined'}))?.id).not.toBe(first?.id)

        const resolved = await log.resolve(first?.id ?? 0)
        expect(resolved.resolved_at).toBe(now.toISOString())
        const next = await log.record({level: 'error', kind: 'page.error', message: 'x is undefined'})
        expect(next).toMatchObject({count: 1})
        expect(next?.id).not.toBe(first?.id)
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
