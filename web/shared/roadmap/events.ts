// The event log: what orrery did, what went wrong, and changes to the roadmap.

/** How much an event matters: something went wrong, something looks off, or what orrery did. */
export const EVENT_LEVELS = ['error', 'warn', 'info'] as const
export type EventLevel = (typeof EVENT_LEVELS)[number]

/** The kinds that are changes to the roadmap (ORR-378), as the store says them: `issue.<field>`, `comment.added`,
 * `release.frozen`…, kept apart in the event log's cap. */
export const ACTIVITY_FAMILIES = ['issue', 'comment', 'chunk', 'doc', 'release'] as const

/** A line in the event log (`GET /api/events/log`): what orrery did, what went wrong or a change to the roadmap, its
 * `kind` a dotted name (`server.error`, `session.started`, `backup.made`, `issue.status`…). Each is a line of its own
 * (ORR-378): `count` is 1, and `last_seen` is `first_seen`, on those recorded since. */
export interface LoggedEvent {
    id: number
    level: EventLevel
    kind: string
    project?: string
    /** What it's about, for a change to the roadmap: the issue's id, the release's version, the chunk's or doc's id. */
    subject?: string
    message: string
    /** What else there is to know (a route, a stack, a version), never a request's body or headers or a secret's value. */
    details?: Record<string, unknown>
    count: number
    first_seen: string
    last_seen: string
    /** When someone said it's dealt with; the next one starts a row of its own. */
    resolved_at?: string
    /** Who resolved it, when it wasn't the owner (ORR-420): the bell still shows it until the owner looks. */
    resolved_by?: string
}
