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

export interface ContextView {
    kind: ContextKind
    projects: string[]
    /** The session it's for, when it's a running one. */
    session?: string
    parts: ContextPart[]
    chars: number
    tokens: number
}
