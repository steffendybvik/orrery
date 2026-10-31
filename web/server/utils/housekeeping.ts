// What orrery cleans up after itself on the event log's hourly timer (ORR-778): old signals each time, images nothing
// refers to once a day, and on SQLite, only when that gave back a lot, the file. Issues, comments, activity, docs and their
// revisions are the record, and are never cleaned up. Says what it removed in the event log, and nothing when it removed nothing.
import type {EventLog} from './event-log'
import {SqliteDb} from './database'
import type {Db} from './database'
import type {Store} from './store'

const SWEEP_EVERY = 86_400_000
/** Worth rewriting the file for: this much free, and this share of it. Free pages get reused anyway. */
const COMPACT_FROM = {bytes: 32 * 1024 * 1024, share: 0.25}

let swept = 0

/** Compacts a SQLite file with a lot free, and writes the `-wal` that filled through. Says whether it did. */
async function compact(db: Db): Promise<boolean> {
    if (!(db instanceof SqliteDb)) return false
    return await db.alone(raw => {
        const pragma = (name: string) => Number(Object.values(raw.prepare(`PRAGMA ${name}`).get() as object)[0])
        const free = pragma('freelist_count')
        if (free * pragma('page_size') < COMPACT_FROM.bytes || free / pragma('page_count') < COMPACT_FROM.share) return false
        raw.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)')
        return true
    })
}

export async function houseKeep(store: Store = useStore(), db: Db = useDatabase(), log: Pick<EventLog, 'note'> = useEventLog(), now = Date.now()) {
    const signals = await store.pruneSignals(now)
    let found = {uploads: 0, bytes: 0}
    if (now - swept >= SWEEP_EVERY) {
        found = await store.sweepUploads(now)
        swept = now
    }
    if (!signals && !found.uploads) return
    const compacted = await compact(db)
    const said = [signals && `${signals} old ${signals === 1 ? 'signal' : 'signals'}`, found.uploads && `${found.uploads} unused ${found.uploads === 1 ? 'image' : 'images'} (${(found.bytes / 1024 / 1024).toFixed(1)} MB)`].filter(Boolean).join(' and ')
    log.note({level: 'info', kind: 'housekeeping.cleaned', message: `Removed ${said}${compacted ? ', and compacted the file' : ''}`, details: {signals, ...found, compacted}})
}

/** For a test: as if no sweep had run yet. */
export function forgetSweep() {
    swept = 0
}
