// Projects, chunks, issues and comments: reading and changing them, and the rules they keep.
// Issues nest (a parent holds sub-issues, to any depth); only a top-level issue is in a chunk, its
// sub-issues are in the same one. Every change ends with `onChange(project)`, which the server
// turns into a server-sent event, so open pages update.
// Each domain is its own file under `server/store/`, one class extending the one before, and `Store` is the last of them:
// the one the server makes and the routes use.
import type {Comment} from '#shared/roadmap'
import {CLOSED} from '#shared/roadmap'
import type {Input} from './input'
import {conflict} from './input'
import type {IssueRecord, CommentRow} from '../store/schema'
import {ANSWERED, commentOf, stamp} from '../store/schema'
import {ImportStore} from '../store/imports'

export type {ProjectSummary, ReleaseDetail, IssueRecord, BulkResult, IssueDetail, ChunkRecord, Actor, IssueFilter} from '../store/schema'
export {AGENT, PROJECT_FIELDS, CHUNK_FIELDS, ISSUE_FIELDS, RELEASE_FIELDS, DOC_FIELDS, DECISION_FIELDS, SIGNAL_FIELDS, CHUNK_SIGNAL_FIELDS, STATUS_FIELDS, SETTINGS_FIELDS, PRESET_FIELDS, OWNER_FIELDS, actorId, COMMENT_FIELDS, UPLOAD_FIELDS, UPLOAD_LIMIT} from '../store/schema'

export class Store extends ImportStore {
    /** Notes that `session` is working the issue (it wrote to it, or was asked to focus on it): the owner's
     * comments on it go to that session from now on. An issue that isn't there (any more) is let be. */
    async workedBy(project: string, issue: string, session: string) {
        issue = await this.issueId(project, issue)
        await this.run(`INSERT INTO issue_sessions (project, issue, session, at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM issues WHERE project = ? AND id = ?)
            ON CONFLICT (project, issue) DO UPDATE SET session = excluded.session, at = excluded.at`, project, issue, session, stamp(), project, issue)
    }

    /** Each issue's write in `claimed` under way, so the next waits for it. */
    private readonly claiming = new Map<string, Promise<unknown>>()

    /** A session's write to an issue, `status` and all, one at a time for the issue: the claim, the write and tying
     * the session to the issue happen together, so two sessions starting it at once can't both pass the claim
     * before either has it. The second waits, then finds the first on it. One without a status only checks the claim. */
    async claimed<T>(project: string, issue: string, status: Input[string], session: string, write: () => Promise<T>): Promise<T> {
        if (status === undefined) {
            await this.claim(project, issue, undefined, session)
            return write()
        }
        const key = `${project}\n${await this.issueId(project, issue)}`
        const run = (this.claiming.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
            await this.claim(project, issue, status, session)
            const written = await write()
            // One the write moved to another project is tied there by its route.
            await this.workedBy(project, issue, session).catch(() => {})
            return written
        })
        this.claiming.set(key, run)
        try {
            return await run
        } finally {
            if (this.claiming.get(key) === run) this.claiming.delete(key)
        }
    }

    /** Refuses `session` a write to an issue another session has started, while that one is there to hear: starting
     * it, and a comment or an edit too (`status` undefined), as every session is `claude` and two that heard the same
     * message would otherwise both take it up. Closing it (`status` a closed one) is any session's, and one no session
     * is on any more is free to take over. */
    async claim(project: string, issue: string, status: Input[string], session: string) {
        issue = await this.issueId(project, issue)
        if (status !== undefined) {
            const to = await this.resolveStatus(status)
            const kind = (await this.statuses()).find(s => s.id === to)?.kind
            if (kind && CLOSED.includes(kind)) return
        }
        const worker = await this.takenFrom(project, issue, session)
        if (worker) throw conflict(`${issue} is already being worked on by another session (${worker}); pick another issue`)
    }

    /** The other session on an issue: the one that has it started, while it's there to hear, if that isn't `session`. */
    async takenFrom(project: string, issue: string, session: string | undefined): Promise<string | null> {
        const {status} = await this.issueRow(project, issue)
        if ((await this.statuses()).find(s => s.id === status)?.kind !== 'started') return null
        const worker = await this.listeningWorker(project, issue)
        return worker && worker !== session ? worker : null
    }

    /** The issues in progress (a started status) that one of `sessions` worked last, with their latest comment. */
    async workingOn(project: string, sessions: string[]): Promise<(IssueRecord & {last?: Comment})[]> {
        if (!sessions.length) return []
        const worked = new Set((await this.all<{issue: string}>(`SELECT issue FROM issue_sessions WHERE project = ? AND session IN (${sessions.map(() => '?').join(', ')})`,
            project, ...sessions)).map(r => r.issue))
        const issues = (await this.listIssues(project)).filter(r => worked.has(r.id) && r.kind === 'started')
        if (!issues.length) return []
        // Their comments in one query, not one each: the hook asking for this waits on it.
        const last = new Map<string, Comment>()
        for (const row of await this.all<CommentRow>(`SELECT c.*, ${ANSWERED} FROM comments c WHERE project = ? AND issue IN (${issues.map(() => '?').join(', ')}) ORDER BY created_at, id`,
            project, ...issues.map(i => i.id))) last.set(row.issue, commentOf(row))
        return issues.map(issue => ({...issue, last: last.get(issue.id)}))
    }

    /** A session's new id (after a `/clear`) takes over what its old one worked and was sent, so none of it
     * hangs on the server remembering the old id. */
    async renameSession(project: string, from: string, to: string) {
        await this.run('UPDATE issue_sessions SET session = ? WHERE project = ? AND session = ?', to, project, from)
        await this.run('UPDATE signals SET target = ? WHERE project = ? AND target = ?', to, project, from)
    }
}
