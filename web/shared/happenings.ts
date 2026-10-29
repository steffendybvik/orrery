// What happens in an orrery, as a schedule hears it (ORR-341). Nothing here is a list kept by hand: an issue's
// change is `issue.<field>` for whichever field changed (`issue.status`, `issue.release`, and any field added later),
// each kind the event log records is one as it's named (`backup.failed`, `session.started`), and releases, comments,
// chunks and docs say `<thing>.<what>` as they're written. A schedule's `on` is a pattern over the type, `*` standing
// for any part (`release.*`, `*.failed`), and `on_filter` what the event must also say.
import type {EventLevel} from './roadmap'

export interface OrreryEvent {
    /** `issue.status`, `release.frozen`, `comment.added`, `server.error`… */
    type: string
    /** None for what happens to the orrery as a whole (a server error), which every project's schedules hear. */
    project?: string
    /** What it's about: an issue's id, a release's version, a chunk's or doc's id, the event log's row (`event 12`). */
    subject?: string
    /** Who did it, when someone did. */
    by?: {name: string, owner: boolean}
    /** An untrusted schedule's session did it, steered by what outsiders wrote: no schedule hears it. */
    untrusted?: boolean
    /** A change's value before and after, as stored (a status's id, a label list); none for text (titles, notes). */
    from?: string
    to?: string
    /** The event log's level, for its kinds. */
    level?: EventLevel
}

/** What a schedule's event must also say: the value it changed to or from (a status's id or kind, a label added, a
 * release's version), who did it, the event log's level. */
export interface OnFilter {
    to?: string
    from?: string
    by?: 'owner' | 'session'
    level?: EventLevel
}

/** A type as a pattern takes it: lowercase dotted names, `*` for any part of one. */
export const EVENT_PATTERN = /^(\*|[a-z][a-z0-9_-]*)(\.(\*|[a-z][a-z0-9_-]*))*$/

/** Whether `type` is one `pattern` stands for: `release.*` takes `release.frozen`, `*.failed` takes `backup.failed`. */
export function matchesType(pattern: string, type: string): boolean {
    const parts = pattern.split('.').map(part => part === '*' ? '[^.]+' : part.replace(/[-]/g, '\\-'))
    // A trailing `*` takes the rest, however many parts: `issue.*`, `*`.
    if (pattern === '*' || pattern.endsWith('.*')) parts[parts.length - 1] = '.+'
    return new RegExp(`^${parts.join('\\.')}$`).test(type)
}

/** The ones most schedules want, first in the picker; any other type, or a pattern, can be typed in. */
export const COMMON_EVENTS: {type: string, label: string, family: string, filter?: 'status' | 'value' | 'level'}[] = [
    {type: 'issue.status', label: 'An issue moves to a status', family: 'Issues', filter: 'status'},
    {type: 'issue.created', label: 'An issue is made', family: 'Issues'},
    {type: 'issue.labels', label: 'An issue\'s labels change', family: 'Issues', filter: 'value'},
    {type: 'issue.priority', label: 'An issue\'s priority changes', family: 'Issues', filter: 'value'},
    {type: 'issue.release', label: 'An issue is set for a release', family: 'Issues', filter: 'value'},
    {type: 'issue.proposal', label: 'A proposal is made or decided', family: 'Issues', filter: 'value'},
    {type: 'comment.added', label: 'A comment is written', family: 'Comments'},
    {type: 'comment.asks', label: 'A session asks the owner', family: 'Comments'},
    {type: 'release.frozen', label: 'A release is frozen', family: 'Releases'},
    {type: 'release.shipped', label: 'A release ships', family: 'Releases'},
    {type: 'release.created', label: 'A release is made', family: 'Releases'},
    {type: 'chunk.created', label: 'A chunk is made', family: 'Chunks and docs'},
    {type: 'doc.changed', label: 'A doc is written', family: 'Chunks and docs'},
    {type: 'pr.conflicting', label: "An issue's pull request conflicts", family: 'Pull requests'},
    {type: 'pr.merged', label: "An issue's pull request is merged", family: 'Pull requests'},
    {type: 'pr.closed', label: "An issue's pull request is closed unmerged", family: 'Pull requests'},
    {type: 'pr.checks_failed', label: "An issue's pull request fails its checks", family: 'Pull requests'},
    {type: 'pr.changes_requested', label: "An issue's pull request is asked for changes", family: 'Pull requests'},
    {type: 'pr.ready', label: "An issue's pull request can merge again", family: 'Pull requests'},
    {type: 'pr.approved', label: "An issue's pull request is approved", family: 'Pull requests'},
    {type: 'session.started', label: 'A session is started', family: 'Sessions'},
    {type: 'session.stopped', label: 'A session stops', family: 'Sessions'},
    {type: 'launcher.gone', label: 'A launcher goes away', family: 'Sessions'},
    {type: '*.error', label: 'A new error (server or page)', family: 'orrery', filter: 'level'},
    {type: '*.failed', label: 'Something fails (a backup, a schedule)', family: 'orrery'},
    {type: 'backup.made', label: 'A backup is made', family: 'orrery'},
]
