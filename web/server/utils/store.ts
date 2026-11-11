// Projects, milestones, issues and comments: reading and changing them, and the rules they keep.
// Issues nest (a parent holds sub-issues, to any depth); only a top-level issue is in a milestone, its
// sub-issues are in the same one. Every change ends with `onChange(project)`, which the server
// turns into a server-sent event, so open pages update.
// Each domain is its own file under `server/store/`, one class extending the one before, and `Store` is the last of them:
// the one the server makes and the routes use.
import type {Comment} from '#shared/roadmap'
import {parked} from '#shared/roadmap'
import type {IssueRecord, CommentRow} from '../store/schema'
import {ANSWERED, commentOf} from '../store/schema'
import {ImportStore} from '../store/imports'

export type {ProjectSummary, ReleaseDetail, IssueRecord, BulkResult, IssueDetail, MilestoneRecord, Actor, IssueFilter} from '../store/schema'
export {AGENT, PROJECT_FIELDS, MILESTONE_FIELDS, ISSUE_FIELDS, RELEASE_FIELDS, DOC_FIELDS, DECISION_FIELDS, SIGNAL_FIELDS, MILESTONE_SIGNAL_FIELDS, STATUS_FIELDS, SETTINGS_FIELDS, PRESET_FIELDS, OWNER_FIELDS, actorId, COMMENT_FIELDS, UPLOAD_FIELDS, UPLOAD_LIMIT} from '../store/schema'

export class Store extends ImportStore {
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

    /** The issue one of `sessions` worked last, by when it last wrote to it or was focused on it (ORR-903). */
    async lastWorked(project: string, sessions: string[]): Promise<string | undefined> {
        if (!sessions.length) return undefined
        return (await this.get<{issue: string}>(`SELECT issue FROM issue_sessions WHERE project = ? AND session IN (${sessions.map(() => '?').join(', ')}) ORDER BY at DESC LIMIT 1`,
            project, ...sessions))?.issue
    }

    /** Whether the session (any of its `ids`) has an issue in progress, or a signal of the owner's waiting for it: then
     * it isn't cleared, stopped or handed more. `own`: only what was sent to it by name counts as waiting (an untrusted
     * run's session, which what's for every session never reaches). */
    async busy(project: string, ids: string[], own = false): Promise<boolean> {
        return (await this.workingOn(project, ids)).length > 0 || (own ? await this.waitingFor(project, ids) : await this.waiting(project, ids))
    }

    /** Whether the session (any of its `ids`) has work of its own to get on with (ORR-1032): an issue in progress that
     * isn't parked, or a signal of the owner's waiting for it. Parked is waiting on the owner's answer, or In review: it
     * stays the session's, but it's done with it for now, so it's out of work and may be handed more (picking, the Todo
     * hand-out). Clearing and stopping still go by `busy`. */
    async engaged(project: string, ids: string[]): Promise<boolean> {
        return (await this.workingOn(project, ids)).some(issue => !parked(issue)) || await this.waiting(project, ids)
    }

    /** A session's new id (after a `/clear`) takes over what its old one worked and was sent, so none of it
     * hangs on the server remembering the old id. */
    async renameSession(project: string, from: string, to: string) {
        await this.run('UPDATE issue_sessions SET session = ? WHERE project = ? AND session = ?', to, project, from)
        await this.retargetSignals(project, from, to)
    }
}
