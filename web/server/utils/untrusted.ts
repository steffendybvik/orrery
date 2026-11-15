// What an untrusted schedule's session (launches.ts) raises: it read what people outside the project wrote, so
// whatever it asks to make is made a proposal for the owner to weigh (its route), and its other writes are refused
// (middleware/untrusted.ts).
import type {H3Event} from 'h3'
import {anotherPersons, sessionHeader} from './actor'

/** Whether the request is an untrusted schedule's session's: its channel says so (`Orrery-Untrusted: yes`) on all it
 * sends, which holds after a restart, before orrery knows its launch; or orrery knows its session (`Orrery-Session`). */
export function untrustedWrite(event: H3Event): boolean {
    if (anotherPersons(event)) return false
    const session = sessionHeader(event)
    return getHeader(event, 'orrery-untrusted') === 'yes' || !!(session && untrustedSession(session))
}

/** The label on what an untrusted run's session raises. */
export const EXTERNAL = 'external'

