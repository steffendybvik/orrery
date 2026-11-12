// Which session is on which issue, asked of the Rust API (ORR-1141), so the session bookkeeping reads the board over
// HTTP rather than from the database (ORR-1093). Each is undefined with no API set up (unit tests, a `nuxt dev` without
// its build), for the store to read the database as before, until that goes too (ORR-1143). Whether a session is
// there to hear stays this server's: the workers come back as they're stored.
import type {Comment, Signal} from '#shared/roadmap'
import type {IssueRecord} from './schema'

/** One issue in the chain `GET …/issues/{issue}/workers` gives: the issue, then each above it. */
export type Worker = {issue: string, started: boolean, worker: string | null}

/** What `GET …/issue-sessions` says of a session's ids. */
export type SessionWorkRead = {issues: (IssueRecord & {last?: Comment})[], waiting: boolean, waiting_for: boolean}

async function read<T>(path: string): Promise<T | undefined> {
    // Imported here, as the router's module reaches the store: a static import would go round in a circle.
    const {readFromApi} = await import('../utils/api-router')
    return await readFromApi<T>(path)
}

const at = (project: string) => `/api/projects/${encodeURIComponent(project)}`

export const sessionWork = {
    /** The issues in progress one of `sessions` worked last, and the owner's signals waiting for it. */
    of: (project: string, sessions: string[]) => read<SessionWorkRead>(`${at(project)}/issue-sessions?sessions=${sessions.map(encodeURIComponent).join(',')}`),
    /** The issue and each above it, nearest first, with the session that last worked each. */
    workers: (project: string, issue: string) => read<Worker[]>(`${at(project)}/issues/${encodeURIComponent(issue)}/workers`),
    /** The issues that depend on this one, in any project. */
    dependents: (project: string, issue: string) => read<{project: string, id: string}[]>(`${at(project)}/issues/${encodeURIComponent(issue)}/dependents`),
    /** The owner's signals from the last day no session has heard: for the one orrery picks, or scheduled. */
    unheard: (project: string, waiting: 'pooled' | 'scheduled') => read<Signal[]>(`${at(project)}/signals?waiting=${waiting}`),
}
