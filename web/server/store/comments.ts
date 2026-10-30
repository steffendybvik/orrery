// Comments on an issue, and its activity.
import type {ChatScheduleRequest, Comment, IssueEvent} from '#shared/roadmap'
import {CLOSED} from '#shared/roadmap'
import {checkInput, notFound} from '../utils/input'
import type {Actor, CommentRow, EventRow, SignalRow} from './schema'
import {AGENT, COMMENT_FIELDS, ANSWERED, OPEN_ASK, commentOf, eventOf, signalOf, nullable, stamp} from './schema'
import {SignalStore} from './signals'

/** orrery itself, speaking on an issue. */
export const ORRERY: Actor = {name: 'orrery', owner: false}

interface ScheduleRequestRow {
    comment: number
    schedule: number | null
    title: string
    changes: string
    body: string
    state: ChatScheduleRequest['state']
}

const scheduleRequestOf = (row: ScheduleRequestRow): ChatScheduleRequest => ({
    ...row.schedule === null ? {} : {id: row.schedule}, title: row.title, changes: JSON.parse(row.changes), body: JSON.parse(row.body), state: row.state,
})

export abstract class CommentStore extends SignalStore {
    async listComments(project: string, issue: string): Promise<Comment[]> {
        issue = await this.issueId(project, issue)
        await this.issueRow(project, issue)
        return await this.withScheduleRequests((await this.all<CommentRow>(`SELECT c.*, ${ANSWERED} FROM comments c WHERE project = ? AND issue = ? ORDER BY created_at, id`, project, issue)).map(commentOf))
    }

    /** The comments, each that asks for a schedule with its request (ORR-458). */
    private async withScheduleRequests(comments: Comment[]): Promise<Comment[]> {
        if (!comments.length) return comments
        const rows = await this.all<ScheduleRequestRow>(`SELECT * FROM schedule_requests WHERE comment IN (${comments.map(() => '?').join(', ')})`, ...comments.map(c => c.id))
        const requests = new Map(rows.map(r => [r.comment, scheduleRequestOf(r)]))
        return comments.map(c => requests.has(c.id) ? {...c, schedule: requests.get(c.id)} : c)
    }

    /** Who changed what on the issue, and when, oldest first. */
    async listActivity(project: string, issue: string): Promise<IssueEvent[]> {
        issue = await this.issueId(project, issue)
        await this.issueRow(project, issue)
        return (await this.all<EventRow>('SELECT * FROM issue_events WHERE project = ? AND issue = ? ORDER BY created_at, id', project, issue)).map(eventOf)
    }

    async comment(project: string, issue: string, id: number): Promise<Comment> {
        issue = await this.issueId(project, issue)
        return (await this.withScheduleRequests([commentOf(await this.commentRow(project, issue, id))]))[0] as Comment
    }

    /** A working session asking the owner on its issue to make or change a schedule (ORR-458): `body` as a comment
     * waiting on their decision, and `request` (checked already) kept beside it until they answer. One asked before for
     * the same schedule, still unanswered, expires: a change by the schedule's id anywhere in the project, a new one by
     * its title on this issue. */
    async askForSchedule(project: string, issue: string, body: string, request: ChatScheduleRequest, actor: Actor): Promise<Comment> {
        issue = await this.issueId(project, issue)
        await this.run(`UPDATE schedule_requests SET state = 'expired' WHERE state = 'asked' AND ${request.id === undefined
            ? 'schedule IS NULL AND title = ? AND comment IN (SELECT id FROM comments WHERE project = ? AND issue = ?)'
            : 'schedule = ? AND comment IN (SELECT id FROM comments WHERE project = ?)'}`,
        ...request.id === undefined ? [request.title, project, issue] : [request.id, project])
        const {id} = await this.createComment(project, issue, {body, asks: 'decision'}, actor)
        await this.run('INSERT INTO schedule_requests (comment, schedule, title, changes, body, state) VALUES (?, ?, ?, ?, ?, ?)',
            id, request.id ?? null, request.title, JSON.stringify(request.changes), JSON.stringify(request.body), 'asked')
        this.changed(project)
        return await this.comment(project, issue, id)
    }

    /** The schedule request comment `id` on the issue holds. */
    async scheduleRequest(project: string, issue: string, id: number): Promise<ChatScheduleRequest> {
        issue = await this.issueId(project, issue)
        await this.commentRow(project, issue, id)
        const row = await this.get<ScheduleRequestRow>('SELECT * FROM schedule_requests WHERE comment = ?', id)
        if (!row) throw notFound(`Comment ${id} on ${issue} asks for no schedule`)
        return scheduleRequestOf(row)
    }

    /** The owner's answer to the schedule request comment `id` holds: `schedule`, the one their Allow made or changed. */
    async answerScheduleRequest(project: string, id: number, state: 'allowed' | 'denied', schedule: number | undefined, actor: Actor) {
        await this.run('UPDATE schedule_requests SET state = ?, schedule = COALESCE(?, schedule), answered_by = ?, answered_at = ? WHERE comment = ?', state, schedule ?? null, actor.name, stamp(), id)
        this.changed(project)
    }

    /** An agent's ask assigns the issue to the owner; the owner's answer gives it back to the agent who asked. */
    async createComment(project: string, issue: string, body: unknown, actor = AGENT): Promise<Comment> {
        issue = await this.issueId(project, issue)
        const row = await this.issueRow(project, issue)
        const input = checkInput(body, COMMENT_FIELDS)
        const now = stamp()
        const asker = actor.owner && row.assignee === (await this.ownerId())
            ? (await this.get<{created_by: string}>(`SELECT c.created_by FROM comments c WHERE c.project = ? AND c.issue = ? AND ${OPEN_ASK}
                ORDER BY c.id DESC LIMIT 1`, project, issue))?.created_by
            : undefined
        const assignee = !actor.owner && input.asks ? (await this.ownerId()) : asker
        const id = await this.db.transaction(async () => {
            const {id} = await this.one<{id: number}>('INSERT INTO comments (project, issue, body, asks, created_by, session_name, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
                project, issue, String(input.body), nullable(input.asks), actor.name, actor.session ?? null, Number(actor.owner), now, now)
            if (assignee) {
                await this.run('UPDATE issues SET assignee = ? WHERE project = ? AND id = ?', assignee, project, issue)
                await this.record(project, issue, actor, [['assignee', row.assignee, assignee]])
            }
            await this.touchIssue(project, issue)
            return id
        })
        this.changed(project)
        this.tell(input.asks ? 'comment.asks' : 'comment.added', project, issue, actor, input.asks ? {to: String(input.asks)} : {})
        if (actor.owner) await this.carryComment(project, issue, String(input.body), actor)
        else this.onNotice({...await this.comment(project, issue, id), project, title: (await this.issueRow(project, issue)).title})
        return await this.comment(project, issue, id)
    }

    /** orrery asking the owner on an issue (`asks: feedback`, ORR-508, or a `decision`): to the bell, as an agent's ask,
     * and assigned to them; not to a session. `type` is what happened, for the schedules. */
    async systemAsk(project: string, issue: string, body: string, type: string, asks: 'feedback' | 'decision' = 'feedback'): Promise<Comment> {
        const comment = await this.createComment(project, issue, {body, asks}, ORRERY)
        this.tell(type, project, await this.issueId(project, issue), ORRERY)
        return comment
    }

    /** Something orrery noticed on an issue that needs no one (a pull request green again, or approved): an event for the
     * schedules and the log, and nothing said. */
    async systemEvent(project: string, issue: string, type: string): Promise<void> {
        this.tell(type, project, await this.issueId(project, issue), ORRERY)
    }

    /** orrery's own word on an issue (a pull request's news, ORR-507), as `orrery`: a comment, which reaches the session on
     * the issue as the owner's do, or the project as work does when nobody's on it; not once the issue is closed, where
     * there's no work left to wake anyone for. `type` is what happened, for the schedules (`pr.merged`). Its words are
     * orrery's own, never another's, so they're safe for a session to read as the owner's. */
    async systemComment(project: string, issue: string, body: string, type: string): Promise<Comment> {
        issue = await this.issueId(project, issue)
        const row = await this.issueRow(project, issue)
        const now = stamp()
        const id = await this.db.transaction(async () => {
            const {id} = await this.one<{id: number}>('INSERT INTO comments (project, issue, body, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?) RETURNING id',
                project, issue, body, ORRERY.name, now, now)
            await this.touchIssue(project, issue)
            return id
        })
        this.changed(project)
        this.tell('comment.added', project, issue, ORRERY)
        this.tell(type, project, issue, ORRERY)
        const kind = (await this.statuses()).find(s => s.id === row.status)?.kind
        if (!kind || !CLOSED.includes(kind)) await this.carryComment(project, issue, body, ORRERY)
        return await this.comment(project, issue, id)
    }

    /** orrery's own word on an issue that wakes nobody, as `orrery`: why an action schedule moved it (ORR-636), which was
     * done so that no session need be. */
    async systemNote(project: string, issue: string, body: string): Promise<Comment> {
        const now = stamp()
        const id = await this.db.transaction(async () => {
            const {id} = await this.one<{id: number}>('INSERT INTO comments (project, issue, body, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?) RETURNING id',
                project, issue, body, ORRERY.name, now, now)
            await this.touchIssue(project, issue)
            return id
        })
        this.changed(project)
        this.tell('comment.added', project, issue, ORRERY)
        return await this.comment(project, issue, id)
    }

    /** The owner's comments in the project that no agent has answered and no session has had yet, nor waits in the pool
     * for one to take (from the last day, as `pooledWaiting`), sent to `session` (just connected) to catch up on. Says
     * how many. orrery's own word after one (a pull request's news) answers nothing (ORR-528). */
    async carryUnanswered(project: string, session: string): Promise<number> {
        const waiting = await this.all<{issue: string, body: string, created_by: string}>(`
            SELECT c.issue, c.body, c.created_by FROM comments c
            WHERE c.project = ? AND c.owned = 1
              AND NOT EXISTS (SELECT 1 FROM comments a WHERE a.project = c.project AND a.issue = c.issue AND a.owned = 0 AND a.created_by != ? AND a.id > c.id)
              AND NOT EXISTS (SELECT 1 FROM signals s WHERE s.project = c.project AND s.issue = c.issue AND s.kind = 'comment'
                              AND s.created_at >= c.created_at AND (s.delivered_to != '[]' OR (s.target IS NULL AND s.created_at >= ?)))
            ORDER BY c.created_at LIMIT 10`, project, ORRERY.name, new Date(Date.now() - 86_400_000).toISOString())
        for (const comment of waiting) {
            const row = await this.one<SignalRow>('INSERT INTO signals (project, issue, kind, note, target, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
                project, comment.issue, 'comment', comment.body, session, comment.created_by, 1, stamp())
            this.onSignal(signalOf(row))
        }
        return waiting.length
    }

    /** The owner's comment goes to the session that last worked the issue, so one session answers it; when none has,
     * or that one isn't there to hear it, to one session orrery picks (pool.ts), which becomes the issue's (ORR-513). */
    protected async carryComment(project: string, issue: string, body: string, actor: Actor) {
        const target = await this.listeningWorker(project, issue)
        const row = await this.one<SignalRow>('INSERT INTO signals (project, issue, kind, note, target, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
            project, issue, 'comment', body, target, actor.name, 1, stamp())
        this.onSignal(signalOf(row))
    }

    /** The owner's comments are theirs: an agent can't reword them. */
    async updateComment(project: string, issue: string, id: number, body: unknown, actor = AGENT): Promise<Comment> {
        issue = await this.issueId(project, issue)
        const row = await this.commentRow(project, issue, id)
        this.refuse(actor, `Editing comment ${id}`, row.owned ? [`comment ${id}`] : [])
        const input = checkInput(body, COMMENT_FIELDS, true)
        await this.db.transaction(async () => {
            await this.update('comments', 'id = ?', [id], {body: input.body, asks: input.asks})
            await this.touchIssue(project, issue)
        })
        this.changed(project)
        // A session may have read the first version already, so the owner's new words go to it too.
        if (actor.owner && row.owned && input.body !== undefined && String(input.body) !== row.body) {
            await this.carryComment(project, issue, `(Edited: this replaces their earlier comment.)\n\n${input.body}`, actor)
        }
        return await this.comment(project, issue, id)
    }

    async deleteComment(project: string, issue: string, id: number, actor = AGENT) {
        issue = await this.issueId(project, issue)
        const row = await this.commentRow(project, issue, id)
        this.refuse(actor, `Deleting comment ${id}`, row.owned ? [`comment ${id}`] : [])
        await this.db.transaction(async () => {
            await this.run('DELETE FROM comments WHERE id = ?', id)
            await this.touchIssue(project, issue)
        })
        this.changed(project)
    }
}
