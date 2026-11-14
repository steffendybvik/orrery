// Which session is on which issue, asked of the Rust API (ORR-1141), so the session bookkeeping reads the board over
// HTTP rather than from the database (ORR-1093). Each is undefined with no API set up (unit tests, a `nuxt dev` without
// its build), for the store to read (or write) the database as before, until that goes too (ORR-1143). Whether a session is
// there to hear stays this server's: the workers come back as they're stored.
import type {Comment, IssueStatus, Signal} from '#shared/roadmap'
import type {IssueRecord} from './schema'
import {ORRERY} from './schema'

/** One issue in the chain `GET …/issues/{issue}/workers` gives: the issue, then each above it. */
export type Worker = {issue: string, started: boolean, worker: string | null}

/** What `GET …/issue-sessions` says of a session's ids. */
export type SessionWorkRead = {issues: (IssueRecord & {last?: Comment})[], waiting: boolean, waiting_for: boolean}

/** One of the comments `GET …/comments/unanswered` gives: who it's by, and who has its issue. */
export type Unanswered = {issue: string, body: string, created_by: string, owned: boolean, assignee: string | null}

async function read<T>(path: string): Promise<T | undefined> {
    // Imported here, as the router's module reaches the store: a static import would go round in a circle.
    const {readFromApi} = await import('../utils/api-router')
    return await readFromApi<T>(path)
}

/** `true` once the API kept the write; undefined with none set up. */
async function write(path: string, body: unknown): Promise<true | undefined> {
    const {writeToApi} = await import('../utils/api-router')
    return await writeToApi('POST', path, body, ORRERY, {always: true}) ? true : undefined
}

const at = (project: string) => `/api/projects/${encodeURIComponent(project)}`

export const sessionWork = {
    /** The issues in progress one of `sessions` worked last, and the owner's signals waiting for it. */
    of: (project: string, sessions: string[]) => read<SessionWorkRead>(`${at(project)}/issue-sessions?sessions=${sessions.map(encodeURIComponent).join(',')}`),
    /** The issue and each above it, nearest first, with the session that last worked each. */
    workers: (project: string, issue: string) => read<Worker[]>(`${at(project)}/issues/${encodeURIComponent(issue)}/workers`),
    /** The issues that depend on this one, in any project. */
    dependents: (project: string, issue: string) => read<{project: string, id: string}[]>(`${at(project)}/issues/${encodeURIComponent(issue)}/dependents`),
    /** Ties the issue to `session`, once this server checked no other session has it started and there to hear. */
    workedBy: (project: string, issue: string, session: string) => write(`${at(project)}/issues/${encodeURIComponent(issue)}/worked-by`, {session}),
    /** A session's new id (after a `/clear`) takes over the issues its old one worked. */
    rename: (project: string, from: string, to: string) => write(`${at(project)}/issue-sessions/rename`, {from, to}),
    /** The owner's signals from the last day no session has heard: for the one orrery picks, or scheduled. */
    unheard: (project: string, waiting: 'pooled' | 'scheduled') => read<Signal[]>(`${at(project)}/signals?waiting=${waiting}`),
    /** The owner's or a member's focuses on the issue from the last ten minutes no session has heard yet (ORR-1131). */
    focusing: (project: string, issue: string) => read<Signal[]>(`${at(project)}/signals?waiting=focus&issue=${encodeURIComponent(issue)}`),
    /** The owner's focuses on the issue from the last day, heard or not, aimed at `session` when given (ORR-1159). */
    focused: (project: string, issue: string, session?: string) =>
        read<Signal[]>(`${at(project)}/signals?focused=${encodeURIComponent(issue)}${session ? `&target=${encodeURIComponent(session)}` : ''}`),
    /** The owner's (and `person`'s) comments no agent has answered and no session has had, for a session just
     * connected to catch up on (ORR-1161): oldest first, ten at most. */
    unanswered: (project: string, person?: string) =>
        read<Unanswered[]>(`${at(project)}/comments/unanswered${person ? `?person=${encodeURIComponent(person)}` : ''}`),
    /** The issue as the claim needs it: its own id (for an alias or an old one), and what it waits on not done yet. */
    blocking: (project: string, issue: string) => read<{id: string, blocked_by?: string[]}>(`${at(project)}/issues/${encodeURIComponent(issue)}`),
    /** The orrery's statuses, each with its kind. */
    statuses: () => read<IssueStatus[]>('/api/statuses'),
}
