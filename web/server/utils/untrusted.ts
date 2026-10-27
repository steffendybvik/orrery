// What an untrusted schedule's session (launches.ts) raises: it read what people outside the project wrote, so
// whatever it asks to make is made a proposal for the owner to weigh (its route), and its other writes are refused
// (middleware/untrusted.ts).
import {isObject} from './input'

/** The label on what an untrusted run's session raises. */
export const EXTERNAL = 'external'

/** An issue as an untrusted run's session asks to make it, made a proposal labelled `external` for the owner to weigh,
 * with nothing that would put it among the owner's work or ask a session to act on it: no parent, chunk, release,
 * status, priority or assignee. */
export function asProposal(body: unknown): Record<string, unknown> {
    const {title, notes, choices, labels} = (isObject(body) ? body : {}) as Record<string, unknown>
    const given = Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string') : []
    return {title, notes, ...choices === undefined ? {} : {choices}, proposal: 'pending', labels: [...new Set([...given, EXTERNAL])]}
}
