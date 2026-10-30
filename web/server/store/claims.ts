// Which session is on which issue: the one that last worked it (`issue_sessions`), and the claim that keeps a second
// session off an issue another has started. Below IssueStore, which pushes an urgent issue to its worker, and
// SignalStore, which ties a focused session to its issue.
import {CLOSED, linkRef} from '#shared/roadmap'
import type {Input} from '../utils/input'
import {conflict} from '../utils/input'
import {stamp} from './schema'
import {ReleaseStore} from './releases'
import {doneIssues} from './reads'

export abstract class ClaimStore extends ReleaseStore {
    /** The session that last worked the issue, while it's there to hear; null otherwise (one session orrery picks). */
    protected async listeningWorker(project: string, issue: string): Promise<string | null> {
        const worker = (await this.get<{session: string}>('SELECT session FROM issue_sessions WHERE project = ? AND issue = ?', project, issue))?.session
        return worker && this.hears(project, worker) ? worker : null
    }

    /** Notes that `session` is working the issue (it wrote to it, or was asked to focus on it): the owner's
     * comments on it go to that session from now on. `since` is when it took the issue, kept while the same session
     * works it again. An issue that isn't there (any more) is let be, and so is one another session has started and is
     * still there to hear (ORR-627): a reviewer's comment on it doesn't take it from the session on it. `claimed`: the
     * claim already let this session's start through (`claimed`), so the issue is its, whoever was tied to it before. */
    async workedBy(project: string, issue: string, session: string, {claimed = false} = {}) {
        issue = await this.issueId(project, issue)
        if (!claimed && await this.takenFrom(project, issue, session).catch(() => null)) return
        const now = stamp()
        await this.run(`INSERT INTO issue_sessions (project, issue, session, at, since) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM issues WHERE project = ? AND id = ?)
            ON CONFLICT (project, issue) DO UPDATE SET since = CASE WHEN issue_sessions.session = excluded.session THEN issue_sessions.since ELSE excluded.since END,
            session = excluded.session, at = excluded.at`, project, issue, session, now, now, project, issue)
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
            // One the write moved to another project is tied there by its route. The write has started it by now, so
            // the guard would see whoever was tied to it before (a comment while it sat in Todo) as on it: the claim
            // already said it's this session's.
            await this.workedBy(project, issue, session, {claimed: true}).catch(() => {})
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
     * it, and an edit too (`status` undefined), as every session is `claude` and two that heard the same message
     * would otherwise both take it up. A comment isn't a write here (ORR-613): it neither starts nor changes the issue,
     * and a reviewer's findings go to the session on it that way. Closing it (`status` a closed one) is any session's,
     * and one no session is on any more is free to take over. */
    async claim(project: string, issue: string, status: Input[string], session: string) {
        issue = await this.issueId(project, issue)
        if (status !== undefined) {
            const to = await this.resolveStatus(status)
            const kind = (await this.statuses()).find(s => s.id === to)?.kind
            if (kind && CLOSED.includes(kind)) return
            if (kind === 'started') {
                const blockers = await this.blockers(project, issue)
                if (blockers.length && !await this.focusedOn(project, issue)) {
                    throw conflict(`${issue} is blocked by ${blockers.join(', ')}, which ${blockers.length === 1 ? "isn't" : "aren't"} done yet; pick another issue`)
                }
                // A follow-up filed under an issue another session has started is that session's too (ORR-611): a new
                // id would otherwise be a lock of its own, and two sessions fix the same thing. The owner's focus aimed
                // at this session gets past it (ORR-613), as it gets past blockers.
                const held = await this.heldAbove(project, issue, session)
                if (held && !await this.focusedOn(project, issue, session)) {
                    throw conflict(`${issue} is a sub-issue of ${held.parent}, which another session (${held.holder}) is working on; it's that session's to start; pick another issue`)
                }
            }
        }
        const worker = await this.takenFrom(project, issue, session)
        if (worker) throw conflict(`${issue} is already being worked on by another session (${worker}); pick another issue`)
    }

    /** What still holds the issue back (ORR-601): the issues it depends on that aren't done, as `linkRef`s. */
    async blockers(project: string, issue: string): Promise<string[]> {
        const statuses = await this.statuses()
        const links = await this.all<{on_project: string, on_issue: string}>('SELECT on_project, on_issue FROM issue_links WHERE project = ? AND issue = ? ORDER BY created_at, on_project, on_issue', project, issue)
        const done = new Map<string, Set<string>>()
        for (const other of new Set(links.map(l => l.on_project))) done.set(other, await doneIssues(this.db, other, statuses))
        return links.filter(l => !done.get(l.on_project)?.has(l.on_issue)).map(l => linkRef(project, l.on_project, l.on_issue))
    }

    /** Whether the owner pointed a session (`session`, when given) at this issue in the last day: their explicit focus
     * starts it, blocked or not. */
    private async focusedOn(project: string, issue: string, session?: string): Promise<boolean> {
        const since = new Date(Date.now() - 86_400_000).toISOString()
        return !!await this.get(`SELECT 1 FROM signals WHERE project = ? AND issue = ? AND kind = 'focus' AND owned = 1 AND created_at >= ?${session ? ' AND target = ?' : ''} LIMIT 1`,
            project, issue, since, ...session ? [session] : [])
    }

    /** The issue above this one (its parent, or one further up) that another session than `session` has started and is
     * there to hear, with that session (ORR-611): a follow-up under it is that session's to start. Null when none is. */
    async heldAbove(project: string, issue: string, session?: string): Promise<{parent: string, holder: string} | null> {
        for (let parent = (await this.issueRow(project, issue)).parent; parent; parent = (await this.issueRow(project, parent)).parent) {
            const holder = await this.takenFrom(project, parent, session)
            if (holder) return {parent, holder}
        }
        return null
    }

    /** The session that last worked the issue, while it's listening (ORR-601: the one that closed a blocker carries
     * on with what it unblocked). */
    async workerOf(project: string, issue: string): Promise<string | null> {
        return await this.listeningWorker(project, issue)
    }

    /** The issues that depend on this one (ORR-601), in any project, oldest link first. */
    async dependentsOf(project: string, issue: string): Promise<{project: string, id: string}[]> {
        return await this.all<{project: string, id: string}>('SELECT project, issue AS id FROM issue_links WHERE on_project = ? AND on_issue = ? ORDER BY created_at, project, issue', project, issue)
    }

    /** The other session on an issue: the one that has it started, while it's there to hear, if that isn't `session`. */
    async takenFrom(project: string, issue: string, session: string | undefined): Promise<string | null> {
        const {status} = await this.issueRow(project, issue)
        if ((await this.statuses()).find(s => s.id === status)?.kind !== 'started') return null
        const worker = await this.listeningWorker(project, issue)
        return worker && worker !== session ? worker : null
    }
}
