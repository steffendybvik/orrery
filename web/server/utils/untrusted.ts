// What an untrusted schedule's session (launches.ts) raises: it read what people outside the project wrote, so
// whatever it asks to make is made a proposal for the owner to weigh (its route), and its other writes are refused
// (middleware/untrusted.ts).
import type {H3Event} from 'h3'
import {isObject} from './input'
import {sessionHeader} from './actor'

/** Whether the request is an untrusted schedule's session's: its channel says so (`Orrery-Untrusted: yes`) on all it
 * sends, which holds after a restart, before orrery knows its launch; or orrery knows its session (`Orrery-Session`). */
export function untrustedWrite(event: H3Event): boolean {
    const session = sessionHeader(event)
    return getHeader(event, 'orrery-untrusted') === 'yes' || !!(session && untrustedSession(session))
}

/** The label on what an untrusted run's session raises. */
export const EXTERNAL = 'external'

/** An issue as an untrusted run's session asks to make it, made a proposal labelled `external` for the owner to weigh,
 * with nothing that would put it among the owner's work or ask a session to act on it: no parent, chunk, release,
 * status, priority, assignee or labels of its own, which an event schedule's filter could match once it's approved. The
 * GitHub issues it came from stay (ORR-635): only numbers or `owner/name#523`, checked as any issue's are. */
export function asProposal(body: unknown): Record<string, unknown> {
    const {title, notes, choices, github_issues} = (isObject(body) ? body : {}) as Record<string, unknown>
    return {title, notes, ...choices === undefined ? {} : {choices}, ...github_issues === undefined ? {} : {github_issues}, proposal: 'pending', labels: [EXTERNAL]}
}
