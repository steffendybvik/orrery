// The owner's chat with a session, and what it may ask the owner to allow.
import type {SessionState} from './sessions'

/** The owner's chat with a session started for it (chats.ts): its id is its launch's. `ended` on the last word of one
 * that's gone. */
export interface Chat {
    id: string
    project: string
    started_at: string
    messages: ChatMessage[]
    ended?: boolean
    /** Why its session can't start, while that holds: a launcher too old to start a chat refused it (ORR-383). */
    problem?: string
    /** Where the issues it makes land, the first status of that kind, whatever its session asks: the owner picks it
     * beside Send (ORR-408). */
    issues: ChatIssues
}

/** Where a chat's issues land: Todo or Backlog. */
export type ChatIssues = 'todo' | 'backlog'
export const CHAT_ISSUES: ChatIssues[] = ['todo', 'backlog']

/** A message in a chat: the owner's (with the ids of the uploads they pasted) or the session's answer, in Markdown. */
export interface ChatMessage {
    id: number
    from: 'owner' | 'claude'
    text: string
    images: string[]
    at: string
    /** The owner's run of messages sent together (ORR-517), each as they wrote it; `text` is them joined by blank lines. */
    parts?: string[]
    /** The session asking to change an App setting, which waits on the owner's Allow. */
    request?: ChatRequest
    /** The session asking to make or change a schedule, which waits on the owner's Allow too. */
    schedule?: ChatScheduleRequest
    /** The session asking to message other sessions as the owner, which waits on the owner's Send (ORR-416). */
    send?: ChatSendRequest
    /** The session asking to start, stop or give more time to a session, which waits on the owner's Allow (ORR-509). */
    session?: ChatSessionRequest
    /** The session asking to move issues (their status) or assign them, which waits on the owner's Allow (ORR-511). */
    move?: ChatMoveRequest
    /** The owner cleared the session's context here (`/clear`, ORR-497): it remembers nothing said above. */
    cleared?: boolean
    /** The session asking to make or change a release, which waits on the owner's Allow (ORR-504). */
    release?: ChatReleaseRequest
    /** The session asking to make or change a chunk, which waits on the owner's Allow (ORR-510). */
    chunk?: ChatChunkRequest
    /** The session asking to make or change a doc, which waits on the owner's Allow (ORR-661). */
    doc?: ChatDocRequest
}

/** The App settings the owner's chat may ask to change (ORR-405), by what App settings calls them. The rest (secrets,
 * the database, statuses, prompts, how sessions start) stay the owner's to change there. */
export const CHAT_SETTINGS = {
    tracker: 'Team tracker',
    tint: 'Background tint',
    restrict_proposals: 'Keep agents off proposals',
    handle: 'Your handle',
    advanced: 'Advanced',
} as const
export type ChatSetting = keyof typeof CHAT_SETTINGS

/** What has changed on what a request would change since it was asked, shown as it reads (ORR-645): Allow then saves
 * nothing until the owner has seen it and allowed it anyway. */
export interface ChatRequestDrift {
    label: string
    from: string
    to: string
}

/** One setting the chat asked to change, from what to what: saved only once the owner allows it, and `expired` when
 * they didn't answer in time or it asked again. */
export interface ChatRequest {
    setting: ChatSetting
    from: unknown
    to: unknown
    drifted?: ChatRequestDrift[]
    state: 'asked' | 'allowed' | 'denied' | 'expired'
}

/** A setting's value as a chat's request shows it. */
export const settingValue = (value: unknown) => value === null || value === undefined || value === '' ? '(none)' : value === true ? 'on' : value === false ? 'off' : String(value)

/** What of a schedule the owner's chat may ask to set (ORR-429), by what New schedule calls it. Whether one is untrusted
 * stays the owner's to set on Schedules. */
export const CHAT_SCHEDULE_FIELDS = {
    kind: 'Kind',
    title: 'Title',
    notes: 'Notes',
    cron: 'Cron',
    at: 'Once at',
    on: 'On the event',
    on_filter: 'Event filter',
    timezone: 'Timezone',
    presets: 'Presets',
    column: 'Issues start in, or an action moves them to',
    move_from: 'An action moves them from',
    chunk: 'Chunk',
    priority: 'Priority',
    labels: 'Labels',
    ask: 'Ask sessions',
    skip_open: 'Skip while open',
    only_if_changed: 'Only if changed',
    enabled: 'Running',
} as const
export type ChatScheduleField = keyof typeof CHAT_SCHEDULE_FIELDS

/** A schedule the chat asked to make (no `id`) or change (`id`), each field it sets from → to, `body` as it's sent to
 * Schedules: saved as the owner's only once they allow it, and `expired` as a setting's request is. */
export interface ChatScheduleRequest {
    id?: number
    title: string
    changes: {field: ChatScheduleField, from?: unknown, to: unknown}[]
    body: Partial<Record<ChatScheduleField, unknown>>
    drifted?: ChatRequestDrift[]
    state: ChatRequest['state']
}

/** What of a release the owner's chat may ask to set (ORR-504), by what Releases calls it. `position` is its place among
 * the project's releases, 0 at the top. Removing one stays the owner's, on Releases. */
export const CHAT_RELEASE_FIELDS = {
    version: 'Version',
    branch: 'Branch',
    notes: 'Notes',
    position: 'Place',
    frozen_on: 'Frozen on',
    shipped_on: 'Shipped on',
} as const
export type ChatReleaseField = keyof typeof CHAT_RELEASE_FIELDS

/** A release the chat asked to make, or change (`change`), each field it sets from → to (a place as "2nd from the top"),
 * `body` as it's sent to Releases: saved only once the owner allows it, and `expired` as a setting's request is. */
export interface ChatReleaseRequest {
    version: string
    change: boolean
    changes: {field: ChatReleaseField, from?: unknown, to: unknown}[]
    body: Partial<Record<ChatReleaseField, unknown>>
    drifted?: ChatRequestDrift[]
    state: ChatRequest['state']
}

/** What of a chunk the owner's chat may ask to set (ORR-510), by what the chunk's page calls it. Removing one stays the
 * owner's, on the page. */
export const CHAT_CHUNK_FIELDS = {
    title: 'Name',
    summary: 'Summary',
    priority: 'Priority',
} as const
export type ChatChunkField = keyof typeof CHAT_CHUNK_FIELDS

/** A chunk the chat asked to make (no `id`) or change (`id`), each field it sets from → to: saved as the owner's only
 * once they allow it, and `expired` as a setting's request is. */
export interface ChatChunkRequest {
    id?: string
    title: string
    changes: {field: ChatChunkField, from?: unknown, to: unknown}[]
    body: Partial<Record<ChatChunkField, unknown>>
    drifted?: ChatRequestDrift[]
    state: ChatRequest['state']
}

/** What of a doc the owner's chat may ask to set (ORR-661), by what the doc's page calls it. Removing a doc, and renaming
 * or deleting a section, stay the owner's, on the page. */
export const CHAT_DOC_FIELDS = {
    title: 'Title',
    section: 'Section',
    body: 'Text',
} as const
export type ChatDocField = keyof typeof CHAT_DOC_FIELDS

/** A doc the chat asked to make (no `was`) or change (`id`): `body` holds only what it would change, and `was` the doc as
 * it stood when asked, for the page's diff. Saved as the owner's only once they allow it. A change is refused if the doc
 * no longer matches `was`, so they never approve one against text they didn't see: that leaves it `expired` and `stale`.
 * `expired` otherwise as a setting's request is. */
export interface ChatDocRequest {
    id?: string
    title: string
    body: {title?: string, section?: string | null, body?: string}
    was?: {title: string, section: string | null, body: string}
    stale?: boolean
    state: ChatRequest['state']
}

/** A message the chat asked to send other sessions as the owner's: to one session (`session`, on `project`), or to
 * every listening one that fits `projects` and `states` as the owner sends it. `to` names who it would reach when
 * asked, `sent` who it reached. Sent only once the owner presses Send, and `expired` as a setting's request is. */
export interface ChatSendRequest {
    text: string
    session?: string
    project?: string
    projects?: string[]
    states?: SessionState[]
    to: string[]
    sent?: string[]
    state: ChatRequest['state']
}

/** Issues the chat asked to move to another status or assign (`body.status`, `body.assignee`; null unassigns): each one's
 * from → to in `changes`, with its title. Made as the owner's, as if they'd moved them on the page, only once they allow
 * it; `moved` names those done, so Allow again after one failed moves the rest. `was` is each one's status and assignee
 * when it was asked, and `drifted` what has changed on them since: Allow then moves nothing until it's allowed anyway
 * (ORR-644). `expired` as a setting's request is. */
export interface ChatMoveRequest {
    changes: {issue: string, title: string, field: 'status' | 'assignee', from: string | null, to: string | null}[]
    was?: Record<string, {status: string, assignee: string | null}>
    drifted?: {issue: string, field: 'status' | 'assignee', from: string | null, to: string | null}[]
    body: {ids: string[], status?: string, assignee?: string | null}
    moved?: string[]
    state: ChatRequest['state']
}

/** A session the chat asked to start (as Start session would, on `project`), to stop, or to give `minutes` more (one
 * orrery started, `session` by its id and `name`): nothing happens until the owner allows it, then it's done as theirs,
 * and `launch` is the session it started. `expired` as a setting's request is. */
export interface ChatSessionRequest {
    action: 'start' | 'stop' | 'extend'
    project: string
    start?: {issue?: string, statuses?: string[], release?: string, presets: number[], instructions: string, hears?: string[]}
    /** The presets it starts with, by name, to show. */
    presets?: string[]
    session?: string
    name?: string
    minutes?: number
    launch?: string
    state: ChatRequest['state']
}

/** A schedule's field as a chat's request shows it: a list joined, an event filter as `key: value`. */
export const scheduleValue = (value: unknown): string => Array.isArray(value)
    ? value.length ? value.map(String).join(', ') : '(none)'
    : value && typeof value === 'object'
        ? Object.entries(value).map(([k, v]) => `${k}: ${String(v)}`).join(', ') || '(none)'
        : settingValue(value)
