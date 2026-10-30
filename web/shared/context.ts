// What orrery puts into a session's context, part by part with its size (ORR-549): `GET /api/projects/:project/context`.

export type ContextKind = 'work' | 'chat' | 'untrusted'
export const CONTEXT_KINDS: ContextKind[] = ['work', 'chat', 'untrusted']

export interface ContextPart {
    /** `instructions`, `tool:<name>` or `start`. */
    id: string
    group: 'instructions' | 'tools' | 'start'
    title: string
    text: string
    chars: number
    tokens: number
}

/** Something a running session was given as it worked: a signal's payload as its stream sent it, or what one of its
 * tool calls answered. `chars` is its whole size; `text` is cut at `CONTEXT_TEXT_KEPT`. */
export interface ContextEntry {
    at: string
    kind: 'signal' | 'tool'
    /** The tool's name, or the signal's kind and what it's about (`comment · ORR-12`). */
    title: string
    text: string
    chars: number
    tokens: number
    /** Given before the session's context was last cleared or compacted, so no longer in it (ORR-575). */
    before?: boolean
}

/** How many of a session's latest entries are kept, and how much of each one's text. */
export const CONTEXT_KEPT = 30
export const CONTEXT_TEXT_KEPT = 20_000

export interface ContextView {
    kind: ContextKind
    projects: string[]
    /** The session it's for, when it's a running one. */
    session?: string
    parts: ContextPart[]
    chars: number
    tokens: number
    /** A running session's: its latest signals and tool answers since orrery started, newest first. */
    sofar?: ContextEntry[]
}
