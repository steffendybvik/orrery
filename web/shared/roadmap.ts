// A project's roadmap as the board draws it: the server reads it from the database, places every
// issue in a column and rolls the columns up into parents and chunks, so the page only draws.
// Its types and helpers live in shared/roadmap/, one file per area (ORR-501); this file gathers them, so
// everything imports from `#shared/roadmap` as before.
export * from './roadmap/board'
export * from './roadmap/sessions'
export * from './roadmap/schedules'
export * from './roadmap/settings'
export * from './roadmap/events'
export * from './roadmap/chats'
export * from './roadmap/notices'
export * from './roadmap/pulls'

/** Whether Activate all turns this schedule on: one that's paused, but no one-off, as a paused one is shown as having run
 * and may have, even with its time still ahead (ORR-783). */
export function canActivate(schedule: {enabled: boolean, at?: string | null}): boolean {
    return !schedule.enabled && !schedule.at
}
