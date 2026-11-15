// What orrery cleans up after itself on the event log's hourly timer (ORR-778): old signals each time, images nothing
// refers to once a day, and on SQLite, only when that gave back a lot, the file. Issues, comments, activity, docs and their
// revisions are the record, and are never cleaned up. Says what it removed in the event log, and nothing when it removed nothing.
import type {EventLog} from './event-log'
import type {Store} from './store'
import {ORRERY} from '../store/schema'
import {writeToApi} from './api-router'

const SWEEP_EVERY = 86_400_000
let swept = 0

/** Has the Rust API compact a SQLite file with a lot free, and write through the `-wal` that filled (ORR-1134). Says
 * whether it did. The API alone touches the file (ORR-1135): with none set up, nothing is compacted. */
async function compact(): Promise<boolean> {
    const asked = await writeToApi('POST', '/api/database/compact', {}, ORRERY, {always: true})
    return (asked?.reply as {compacted?: boolean} | undefined)?.compacted ?? false
}

export async function houseKeep(store: Store = useStore(), log: Pick<EventLog, 'note'> = useEventLog(), now = Date.now()) {
    const signals = await store.pruneSignals(now)
    let found = {uploads: 0, bytes: 0}
    if (now - swept >= SWEEP_EVERY) {
        found = await store.sweepUploads(now)
        swept = now
    }
    if (!signals && !found.uploads) return
    const compacted = await compact()
    const said = [signals && `${signals} old ${signals === 1 ? 'signal' : 'signals'}`, found.uploads && `${found.uploads} unused ${found.uploads === 1 ? 'image' : 'images'} (${(found.bytes / 1024 / 1024).toFixed(1)} MB)`].filter(Boolean).join(' and ')
    log.note({level: 'info', kind: 'housekeeping.cleaned', message: `Removed ${said}${compacted ? ', and compacted the file' : ''}`, details: {signals, ...found, compacted}})
}

/** For a test: as if no sweep had run yet. */
export function forgetSweep() {
    swept = 0
}
