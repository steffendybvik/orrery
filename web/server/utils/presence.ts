// Which sessions are there to hear, told to the Rust API (ORR-1172), so its rails can check a session's claim on an
// issue themselves: a claim holds only while the session that has the issue started is there (`hears()` in the store).
// Only this server hears the sessions' channels, so it says, as one connects or goes (`presenceChanged`, from
// `attend()` in sessions.ts) and again every half minute (plugins/presence.ts), each session's projects
// (`PUT /api/session-presence/:session`), and `DELETE`s one that's gone. The API takes one it hasn't heard of for 90
// seconds as gone, so one this server lost track of, or a stopped server's, frees its issues by itself.
import {ORRERY} from '../store/schema'
import {writeToApi} from './api-router'
import {heardProjects} from './sessions'

/** What was last told of each session: its projects, joined. */
const told = new Map<string, string>()

let saying: Promise<void> | null = null
let again: {all: boolean} | null = null

/** Tells the API who's there now: each session whose projects changed, and with `all` (the beat) every one, so it
 * doesn't take them as gone. Calls while it's telling are folded into one more round after it. Never fails: a round
 * the API can't take is tried again on the next. */
export function sayPresence({all = false} = {}): Promise<void> {
    if (saying) {
        again = {all: all || !!again?.all}
        return saying
    }
    saying = say(all).finally(() => {
        saying = null
        const next = again
        again = null
        if (next) void sayPresence(next)
    })
    return saying
}

/** A session's channel connected or went. */
export function presenceChanged() {
    void sayPresence()
}

async function say(all: boolean) {
    const now = heardProjects()
    for (const [session, projects] of now) {
        const key = projects.toSorted().join('\n')
        if (!all && told.get(session) === key) continue
        if (await sent('PUT', session, {projects})) told.set(session, key)
    }
    for (const session of [...told.keys()]) {
        if (!now.has(session) && await sent('DELETE', session)) told.delete(session)
    }
}

/** Whether the API took it; false with no API set up, or one that can't be reached or refused. */
async function sent(method: 'PUT' | 'DELETE', session: string, body?: unknown): Promise<boolean> {
    try {
        return !!await writeToApi(method, `/api/session-presence/${encodeURIComponent(session)}`, body, ORRERY, {always: true})
    } catch {
        return false
    }
}

/** Forgets what was told, for tests. */
export function forgetPresence() {
    told.clear()
    saying = null
    again = null
}
