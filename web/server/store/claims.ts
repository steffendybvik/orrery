// Which session is on which issue: the one that last worked it (`issue_sessions`), and the claim that keeps a second
// session off an issue another has started. Below IssueStore, which pushes an urgent issue to its worker, and
// SignalStore, which ties a focused session to its issue.
import {CLOSED} from '#shared/roadmap'
import type {Input} from '../utils/input'
import {conflict} from '../utils/input'
import {stamp} from './schema'
import {ReleaseStore} from './releases'

export abstract class ClaimStore extends ReleaseStore {
    /** The session that last worked the issue, while it's there to hear; null otherwise (one session orrery picks). */
    protected async listeningWorker(project: string, issue: string): Promise<string | null> {
        const worker = (await this.get<{session: string}>('SELECT session FROM issue_sessions WHERE project = ? AND issue = ?', project, issue))?.session
        return worker && this.hears(project, worker) ? worker : null
    }

    /** Notes that `session` is working the issue (it wrote to it, or was asked to focus on it): the owner's
     * comments on it go to that session from now on. `since` is when it took the issue, kept while the same session
     * works it again. An issue that isn't there (any more) is let be. */
    async workedBy(project: string, issue: string, session: string) {
        issue = await this.issueId(project, issue)
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
}
