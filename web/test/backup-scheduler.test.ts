import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {BackupEvery, BackupTarget} from '../server/utils/backup'
import type {BackupHooks} from '../server/utils/backup-scheduler'
import {BackupScheduler} from '../server/utils/backup-scheduler'

// When orrery backs up (ORR-500): a few seconds after a change, put off by more; on an interval, once that long since
// the last, and only after a change; never over a folder's backups while the database is a new orrery's; and what's
// waiting as the server closes. The clock is vitest's.
const second = 1000
const minute = 60 * second
let made: number[]
let notes: {kind: string, message: string}[]
let every: BackupEvery
let target: BackupTarget | null
let fresh: boolean
let failing: boolean

function scheduler(over: Partial<BackupHooks> = {}) {
    return new BackupScheduler({
        target: () => target,
        fresh: async () => fresh,
        backUp: async () => {
            if (failing) throw new Error('disk full')
            made.push(Date.now())
        },
        every: () => every,
        settle: () => 3 * second,
        note: entry => void notes.push(entry),
        ...over,
    })
}

beforeEach(() => {
    vi.useFakeTimers({now: Date.parse('2026-10-29T08:00:00Z')})
    made = []
    notes = []
    every = 'change'
    target = {kind: 'folder', dir: '/backups'}
    fresh = false
    failing = false
})

afterEach(() => vi.useRealTimers())

/** Lets the clock run on by `ms`, with what the timers set off finished. */
const after = (ms: number) => vi.advanceTimersByTimeAsync(ms)

describe('backing up', () => {
    it('a few seconds after a change, put off by more changes, but not past ten waits from the first', async () => {
        const backups = scheduler()
        backups.soon()
        await after(2 * second)
        backups.soon()
        await after(2 * second)
        expect(made).toEqual([])
        await after(2 * second)
        expect(made).toHaveLength(1)
        // A change every two seconds still gets backed up, ten waits after the first.
        made = []
        for (let i = 0; i < 20 && !made.length; i++) {
            backups.soon()
            await after(2 * second)
        }
        expect(made).toHaveLength(1)
    })

    it('on an interval, once that long since the last, the changes in between going together', async () => {
        every = '15m'
        const backups = scheduler()
        backups.soon()
        await after(5 * minute)
        backups.soon()
        backups.soon()
        await after(9 * minute)
        expect(made).toEqual([])
        await after(minute)
        expect(made).toHaveLength(1)
        // Nothing changed since: nothing more.
        await after(30 * minute)
        expect(made).toHaveLength(1)
    })

    it("doesn't back a new orrery up to a folder, but does once it isn't new", async () => {
        fresh = true
        const backups = scheduler()
        await backups.save()
        expect(made).toEqual([])
        fresh = false
        await backups.save()
        expect(made).toHaveLength(1)
    })

    it('says each one made or failed in the log, and never throws', async () => {
        const backups = scheduler()
        await backups.save()
        failing = true
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        await expect(backups.save()).resolves.toBeUndefined()
        error.mockRestore()
        expect(notes.map(n => [n.kind, n.message])).toEqual([['backup.made', 'Backed up to /backups'], ['backup.failed', 'Backing up to /backups: disk full']])
    })

    it('does nothing with backups off, and backs up what was waiting as the server closes', async () => {
        target = null
        const off = scheduler()
        off.soon()
        await after(minute)
        expect(made).toEqual([])
        target = {kind: 'folder', dir: '/backups'}
        const backups = scheduler()
        backups.soon()
        await backups.close()
        expect(made).toHaveLength(1)
        // Closed, the timer it had is gone.
        await after(minute)
        expect(made).toHaveLength(1)
    })
})
