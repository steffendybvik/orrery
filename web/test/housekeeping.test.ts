// What orrery cleans up after itself (ORR-778): old signals, and images nothing refers to.
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {Store} from '../server/utils/store'
import {forgetSweep, houseKeep} from '../server/utils/housekeeping'
import {storeSetup} from './store-setup'

let store: Store
const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const owner = {name: 'skoll', owner: true}

beforeEach(async () => {
    ({store} = await storeSetup())
    forgetSweep()
})

const signalAt = (id: number, at: string, more = "'[]'") => store.db.run(`INSERT INTO signals (id, project, kind, note, delivered_to, created_by, owned, created_at) VALUES (?, 'greenhouse', 'message', 'hello', ${more}, 'skoll', 1, ?)`, id, at)
const signalIds = async () => (await store.db.all<{id: number}>('SELECT id FROM signals ORDER BY id')).map(row => Number(row.id))
const hex = (n: number) => n.toString(16).padStart(24, '0')
const uploadAt = (n: number, days = 200) => store.db.run("INSERT INTO uploads (id, type, name, size, data, created_by, owned, created_at) VALUES (?, 'image/webp', 'a', 1024, ?, 'skoll', 1, ?)", hex(n), Buffer.from('x'), ago(days))
const uploadIds = async () => (await store.db.all<{id: string}>('SELECT id FROM uploads ORDER BY id')).map(row => row.id)
const link = (n: number) => `![a](/api/uploads/${hex(n)})`

describe('old signals', () => {
    it('go past their age, heard or not, and the rest stay', async () => {
        await signalAt(1, ago(40))
        await signalAt(2, ago(40), `'["a session"]'`)
        await signalAt(3, ago(20))
        expect(await store.pruneSignals()).toBe(2)
        expect(await signalIds()).toEqual([3])
    })

    it('leave ids going up, so a session catching up misses nothing new', async () => {
        const last = await store.message('greenhouse', 1, 'hello', owner)
        await store.db.run('UPDATE signals SET created_at = ?', ago(40))
        await store.pruneSignals()
        expect(await signalIds()).toEqual([])
        expect((await store.message('greenhouse', 1, 'hello', owner)).id).toBeGreaterThan(last.id)
    })

    it('take no old comment back to the sessions: gone with its signal, it stays heard', async () => {
        const issue = await store.createIssue('greenhouse', {title: 'Pots'}, owner)
        const old = await store.createComment('greenhouse', issue.id, {body: 'Thanks, that was it.'}, owner)
        await store.db.run('UPDATE comments SET created_at = ? WHERE id = ?', ago(40), old.id)
        await store.db.run('DELETE FROM signals')
        expect(await store.carryUnanswered('greenhouse', 'just-connected')).toBe(0)
        await store.db.run('UPDATE comments SET created_at = ? WHERE id = ?', ago(10), old.id)
        expect(await store.carryUnanswered('greenhouse', 'just-connected')).toBe(1)
    })
})

describe('unused images', () => {
    it('stay while anything links to them, wherever it is', async () => {
        const issue = await store.createIssue('greenhouse', {title: 'Pots', notes: link(1)}, owner)
        await store.createComment('greenhouse', issue.id, {body: link(2)}, owner)
        await store.createDoc('greenhouse', {id: 'pots', title: 'Pots', body: link(3)}, owner)
        await store.updateDoc('greenhouse', 'pots', {body: 'moved on'}, owner) // its old revision still shows 3
        await store.updateProject('greenhouse', {release_mode: 'own'}, owner)
        await store.createRelease('greenhouse', {version: '1.0.0', notes: link(4)}, owner)
        await store.db.run("INSERT INTO settings (key, value) VALUES ('anywhere', ?)", JSON.stringify(`http://example.test${link(5)}`))
        await store.createIssue('greenhouse', {title: 'Which?', proposal: 'pending', choices: [{key: 'a', question: link(6), pick: 'one', options: [{key: 'b', title: 'B'}, {key: 'c', title: 'C'}]}]}, {name: 'claude', owner: false})
        for (let n = 1; n <= 7; n++) await uploadAt(n)
        expect(await store.sweepUploads()).toEqual({uploads: 1, bytes: 1024})
        expect(await uploadIds()).toEqual([1, 2, 3, 4, 5, 6].map(hex))
    })

    it('stay while young, as one may still be being written', async () => {
        await uploadAt(1, 60)
        expect((await store.sweepUploads()).uploads).toBe(0)
        expect(await uploadIds()).toEqual([hex(1)])
    })

    it('all stay when the look at what refers to them fails', async () => {
        await uploadAt(1)
        const all = store.db.all.bind(store.db)
        vi.spyOn(store.db, 'all').mockImplementation(async (sql: string, ...params: never[]) => {
            if (sql.includes('LIKE ?')) throw new Error('no')
            return await all(sql, ...params)
        })
        await expect(store.sweepUploads()).rejects.toThrow()
        vi.restoreAllMocks()
        expect(await uploadIds()).toEqual([hex(1)])
    })
})

describe('a run', () => {
    it('says what it removed, says nothing with nothing to remove, and looks at images once a day', async () => {
        const log = {note: vi.fn()}
        await houseKeep(store, store.db, log)
        expect(log.note).not.toHaveBeenCalled()
        await signalAt(1, ago(40))
        await uploadAt(1)
        await houseKeep(store, store.db, log, Date.now() + 3_600_000)
        expect(log.note).toHaveBeenCalledTimes(1)
        expect(log.note.mock.calls[0]![0]).toMatchObject({kind: 'housekeeping.cleaned', message: 'Removed 1 old signal'})
        await houseKeep(store, store.db, log, Date.now() + 2 * DAY)
        expect(log.note.mock.calls[1]![0]).toMatchObject({details: {uploads: 1, bytes: 1024, compacted: false}})
    })
})
