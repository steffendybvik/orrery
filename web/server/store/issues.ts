// Issues: listing, reading, making and changing one.
import type {Kind, Signal} from '#shared/roadmap'
import {CLOSED, issueRef} from '#shared/roadmap'
import type {Input} from '../utils/input'
import {badRequest, checkInput, forbidden, notFound} from '../utils/input'
import type {IssueRecord, IssueDetail, Actor, IssueFilter, IssueRow} from './schema'
import {AGENT, ISSUE_FIELDS, tasksOf, nullable, stamp} from './schema'
import {ReleaseStore} from './releases'

export abstract class IssueStore extends ReleaseStore {
    // Further down the chain: a focus is a signal, and moving an issue takes its sub-issues along.
    protected abstract sendFocus(project: string, issue: string, body: unknown, actor: Actor): Promise<Signal>
    protected abstract moveIssue(from: string, id: string, to: string, parent: Input[string], chunk: Input[string], actor: Actor): Promise<string>

    async listIssues(project: string, filter: IssueFilter = {}): Promise<IssueRecord[]> {
        const records = this.issueRecords(await this.project(project))
        if (filter.chunk && filter.chunk !== 'none') filter = {...filter, chunk: await this.chunkId(project, filter.chunk)}
        if (filter.parent && filter.parent !== 'none') filter = {...filter, parent: await this.issueId(project, filter.parent)}
        if (filter.release && filter.release !== 'none') await this.releaseRow(project, filter.release)
        const q = filter.q?.toLowerCase()
        const statuses = filter.status ? await this.statusIds(filter.status) : []
        const columns = filter.column === 'proposed' ? ['proposed'] : filter.column ? await this.statusIds(filter.column) : []
        const assignee = filter.assignee && filter.assignee !== 'none' ? await this.assigneeOf(filter.assignee) : undefined
        const handle = await this.handle()
        return records.map(r => ({...r, ref: issueRef(handle, r.id)})).filter(r =>
            (!filter.status || statuses.includes(r.status))
            && (!filter.priority || (filter.priority === 'none' ? !r.priority : r.priority === filter.priority))
            && (!filter.column || columns.includes(r.column))
            && (!filter.assignee || (filter.assignee === 'none' ? !r.assignee : r.assignee === assignee))
            && (!filter.label || r.labels.includes(filter.label))
            && (!filter.external || r.external.includes(filter.external))
            && (!filter.chunk || (filter.chunk === 'none' ? !r.chunk : r.chunk === filter.chunk))
            && (!filter.release || (filter.release === 'none' ? !r.release : r.release === filter.release))
            && (!filter.parent || (filter.parent === 'none' ? !r.parent : r.parent === filter.parent))
            && (!filter.proposal || (filter.proposal === 'none' ? r.column !== 'proposed' : r.proposal === filter.proposal))
            && (!q || r.id.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)))
    }

    async issue(project: string, id: string): Promise<IssueDetail> {
        id = await this.issueId(project, id)
        const found = this.findIssue(await this.project(project), id)
        if (!found) throw notFound(`No issue ${id} in ${project}`)
        return {...found.issue, project, parent: found.parent, chunk: found.chunk || null, ref: issueRef(await this.handle(), id)}
    }

    /** `urgent: false` leaves a P0 issue's push to the caller, which asks the sessions itself. */
    async createIssue(project: string, body: unknown, actor = AGENT, {urgent = true} = {}): Promise<IssueDetail> {
        await this.projectRow(project)
        const input = checkInput(body, ISSUE_FIELDS)
        if (input.project !== undefined && input.project !== project) throw badRequest(`Create the issue in its project: POST /api/projects/${input.project}/issues`)
        const parent = input.parent ? await this.issueId(project, String(input.parent)) : null
        const chunk = input.chunk ? await this.chunkId(project, String(input.chunk)) : null
        if (parent) {
            await this.issueRow(project, parent)
            if (chunk) throw badRequest(`A sub-issue is in its parent's chunk; leave out "chunk" or "parent"`)
        }
        if (chunk) await this.chunkRow(project, chunk)
        const release = input.release ? (await this.releaseRow(project, String(input.release))).version : null

        const id = await this.db.transaction(async () => {
            const id = await this.nextId(project, 'issue')
            const now = stamp()
            await this.run(`INSERT INTO issues (project, id, title, status, priority, assignee, labels, external, notes, proposal, choices, parent, chunk, ships_in, position,
                                          created_by, session_name, owned, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                project, id, String(input.title).trim(), await this.resolveStatus(input.status, input.plan), nullable(input.priority),
                // A proposal waits on the owner, so it's theirs, whoever the request names.
                input.proposal === 'pending' ? (await this.ownerId()) : nullable(await this.assigneeOf(input.assignee)),
                JSON.stringify(input.labels ?? []), JSON.stringify(tasksOf(input.external)), nullable(input.notes), nullable(input.proposal), String(input.choices ?? '[]'),
                parent, chunk, release, Number(input.position ?? await this.nextPosition('issues', project)), actor.name, actor.session ?? null, Number(actor.owner), now, now)
            await this.record(project, id, actor, [['created', null, null]])
            await this.touchProject(project)
            return id
        })
        this.changed(project)
        if (urgent) await this.urgent(project, null, await this.issueRow(project, id), actor)
        return await this.issue(project, id)
    }

    /** `parent: null` lifts a sub-issue to the top, into the chunk it was in unless `chunk` says otherwise.
     * `project` moves it (with its sub-issues and comments) to the top of another project. `proposal:
     * null` commits a proposal, as the owner (approving one commits it). */
    async updateIssue(project: string, id: string, body: unknown, actor = AGENT): Promise<IssueDetail> {
        id = await this.issueId(project, id)
        await this.issueRow(project, id)
        const input = checkInput(body, ISSUE_FIELDS, true)
        if (input.project !== undefined && input.project !== project) {
            const {project: to, parent, chunk, ...rest} = input
            const moved = await this.moveIssue(project, id, String(to), parent ?? null, chunk ?? null, actor)
            return await this.updateIssue(String(to), moved, rest, actor)
        }
        const row = await this.issueRow(project, id)
        if (input.proposal === null && row.proposal && !actor.owner) {
            throw forbidden(`Committing ${id} is the owner's call until they approve it: it's ${row.proposal === 'pending' ? 'waiting on them' : row.proposal === 'changes' ? 'waiting on changes' : 'rejected'}`)
        }
        // While it waits on the owner, it isn't work yet: an agent can still comment, edit it and put it up again.
        const moves = (['status', 'plan', 'assignee', 'release'] as const).filter(field => input[field] !== undefined && !(field === 'assignee' && input.proposal === 'pending'))
        if (moves.length && !actor.owner && (row.proposal === 'pending' || row.proposal === 'changes') && (await this.settings()).restrict_proposals) {
            throw forbidden(`${id} is a proposal waiting on the owner, so its ${moves.length === 1 ? moves[0] : `${moves.slice(0, -1).join(', ')} and ${moves.at(-1)}`} ${moves.length === 1 ? "isn't" : "aren't"} yours to change until they approve it`)
        }

        const parent = input.parent === undefined ? row.parent : input.parent === null ? null : await this.issueId(project, String(input.parent))
        let chunk = input.chunk === undefined ? undefined : input.chunk === null ? null : await this.chunkId(project, String(input.chunk))
        if (parent) {
            if (chunk) throw badRequest(`A sub-issue is in its parent's chunk; leave out "chunk" or set "parent" to null`)
            await this.issueRow(project, parent)
            for (let up: string | null = parent; up; up = (await this.issueRow(project, up)).parent) {
                if (up === id) throw badRequest(`${parent} is ${up === parent ? 'this issue' : 'under this issue'}, so it can't be its parent`)
            }
            chunk = null
        } else if (chunk === undefined && row.parent) {
            chunk = (await this.rootOf(project, row)).chunk
        }
        if (chunk) await this.chunkRow(project, chunk)
        const release = input.release === undefined ? undefined : input.release === null ? null : (await this.releaseRow(project, String(input.release))).version

        const title = input.title === undefined ? undefined : String(input.title).trim()
        const status = input.status === undefined && input.plan === undefined ? undefined : await this.resolveStatus(input.status, input.plan)
        const assignee = input.proposal === 'pending' ? (await this.ownerId()) : await this.assigneeOf(input.assignee)
        const labels = input.labels === undefined ? undefined : JSON.stringify(input.labels ?? [])
        const external = input.external === undefined ? undefined : JSON.stringify(tasksOf(input.external))
        const moved = input.parent !== undefined && parent !== row.parent
        await this.db.transaction(async () => {
            await this.record(project, id, actor, [
                ['title', row.title, title],
                ['status', row.status, status],
                ['priority', row.priority, input.priority],
                ['assignee', row.assignee, assignee],
                ['labels', row.labels, labels],
                ['external', row.external, external],
                ['notes', row.notes, input.notes],
                ['proposal', row.proposal, input.proposal],
                // A sub-issue is in its parent's chunk, so a new parent says it all.
                moved ? ['parent', row.parent, parent] : ['chunk', row.chunk, chunk],
                ['release', row.ships_in, release],
            ])
            await this.update('issues', 'project = ? AND id = ?', [project, id], {
                title,
                status,
                priority: input.priority,
                assignee,
                labels,
                external,
                notes: input.notes,
                proposal: input.proposal,
                choices: input.choices === undefined ? undefined : String(input.choices ?? '[]'),
                // Put up again, it waits on a new decision.
                ...input.proposal === 'pending' ? {decided_by: null, decided_at: null, decision_note: null, picks: null, explore: null} : {},
                parent: input.parent === undefined ? undefined : parent,
                chunk,
                ships_in: release,
                position: input.position,
            })
            await this.touchProject(project)
        })
        this.changed(project)
        await this.urgent(project, row, await this.issueRow(project, id), actor)
        return await this.issue(project, id)
    }

    /** An issue the owner's write just made urgent open work (P0, and committed and not closed, which it wasn't
     * before) goes to the sessions as a focus, without their asking: to the session working it while it can hear,
     * else to every session on the project. The write is saved by now, so a push that fails is only logged. */
    protected async urgent(project: string, before: IssueRow | null, after: IssueRow, actor: Actor) {
        try {
            const urgentWork = async (row: IssueRow) => row.priority === 'P0' && !row.proposal
                && !CLOSED.includes((await this.statuses()).find(s => s.id === row.status)?.kind as Kind)
            if (!actor.owner || !await urgentWork(after) || (before && await urgentWork(before))) return
            await this.sendFocus(project, after.id, {note: 'It was just made urgent (P0).', session: await this.listeningWorker(project, after.id)}, actor)
        } catch (error) {
            console.error(`[orrery] pushing urgent ${after.id} in ${project}:`, error)
        }
    }

    /** The session that last worked the issue, while it's there to hear; null (every session) otherwise. */
    protected async listeningWorker(project: string, issue: string): Promise<string | null> {
        const worker = (await this.get<{session: string}>('SELECT session FROM issue_sessions WHERE project = ? AND issue = ?', project, issue))?.session
        return worker && this.hears(project, worker) ? worker : null
    }
}
