// A connect request, as the page and the server have it (ORR-708): see server/utils/connects.ts.
export type ConnectState = 'asking' | 'picking' | 'picked' | 'writing' | 'done' | 'canceled' | 'failed'

export interface ConnectRequest {
    id: string
    state: ConnectState
    /** The machine the picker opened on, as its launcher says. */
    host?: string
    /** The last part of the folder chosen: never its path. */
    folder?: string
    /** The projects it has already on this orrery. */
    projects?: string[]
    /** Its channel serves every project. */
    every?: boolean
    /** The files written, and those that already had it all. */
    written?: string[]
    unchanged?: string[]
    /** Whether a terminal opened with Claude in it. */
    opened?: boolean
    /** What went wrong. */
    message?: string
}
