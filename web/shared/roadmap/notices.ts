// Notices (an agent's comment, as the bell lists it) and secrets.
import type {Comment} from './board'

/** An agent's comment, as the notification bell and page list it. */
export interface Notice extends Comment {
    project: string
    title: string
    /** Taken out of the bell; only `GET /notices?list=cleared` lists these. */
    cleared?: boolean
    /** Its reader has opened it on the notifications page: apart from what the bell has counted as seen. */
    read?: boolean
    /** An agent's proposal waiting on the owner instead of a comment: `asks: decision` until they decide it,
     * its notes as the body, put up at `created_at`, `id` 0. Cleared, it's `cleared` until it's put up again. */
    proposal?: {choices: number}
}

/** Tells notices apart: a comment by its id, a proposal by its issue. */
export const noticeKey = (n: Notice) => n.proposal ? `${n.project}/${n.issue}` : String(n.id)

/** The lists of notices: the bell's, and the notifications page's tabs. */
export const NOTICE_LISTS = ['bell', 'waiting', 'inbox', 'cleared'] as const
export type NoticeList = (typeof NOTICE_LISTS)[number]

/** A secret as anyone sees it: never its value. Agents put `{{secret:NAME}}` in a request orrery makes for them. */
export interface Secret {
    name: string
    /** Its last 4 characters, to tell one value from another. */
    last4: string
    /** The hosts it may be sent to; orrery refuses any other. */
    hosts: string[]
    /** The projects that may use it; null for any. */
    projects: string[] | null
    created_by: string
    created_at: string
    updated_at: string
    last_used: SecretUse | null
}

/** One request a secret went out in, kept without the value. */
export interface SecretUse {
    id: number
    secret: string
    method: string
    host: string
    /** The path as the agent wrote it, placeholders and all. */
    path: string
    project: string | null
    issue: string | null
    /** The status that came back, or null when it never got one (`error` says why). */
    status: number | null
    error: string | null
    created_by: string
    created_at: string
}
