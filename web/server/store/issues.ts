// Issues: listing, reading, making and changing one.
import type {Kind, Signal} from '#shared/roadmap'
import {CLOSED, fullId, githubIssueOf, githubRepo, isBlocked, issueRef, linkRef, parseLinkRef} from '#shared/roadmap'
import type {Input} from '../utils/input'
import {badRequest, checkInput, conflict, notFound} from '../utils/input'
import type {IssueRecord, IssueDetail, Actor, IssueFilter, IssueRow} from './schema'
import {AGENT, ISSUE_FIELDS, ORRERY, matchOf, tasksOf, nullable, stamp} from './schema'
import {ClaimStore} from './claims'
import {findIssue, issueRecords} from './reads'
import {refusedFor} from '../utils/permission'

/** How many issues one can depend on, at most (ORR-601): keeps the loop check and what a session hears small. */
const MAX_DEPENDS = 50

export abstract class IssueStore extends ClaimStore {
    // Further down the chain: a focus is a signal, and moving an issue takes its sub-issues along.
    protected abstract sendFocus(project: string, issue: string, body: unknown, actor: Actor): Promise<Signal>
    protected abstract moveIssue(from: string, id: string, to: string, parent: Input[string], chunk: Input[string], actor: Actor): Promise<string>

    async listIssues(project: string, filter: IssueFilter = {}): Promise<IssueRecord[]> {
        const records = issueRecords(project, await this.boardOf(project))
        if (filter.chunk && filter.chunk !== 'none') filter = {...filter, chunk: await this.chunkId(project, filter.chunk)}
        if (filter.parent && filter.parent !== 'none') filter = {...filter, parent: await this.issueId(project, filter.parent)}
        if (filter.release && filter.release !== 'none') await this.releaseRow(project, filter.release)
        const q = filter.q?.toLowerCase()
        const statuses = filter.status ? await this.statusIds(filter.status) : []
        const columns = filter.column === 'proposed' ? ['proposed'] : filter.column ? await this.statusIds(filter.column) : []
        const assignee = filter.assignee && filter.assignee !== 'none' ? await this.assigneeOf(filter.assignee) : undefined
        const [github] = filter.github_issue ? (await this.githubIssuesOf(project, JSON.stringify([filter.github_issue])) ?? []).map(g => g.toLowerCase()) : []
        const handle = await this.handle()
        const {uid} = await this.projectRow(project)
        // With `in: all`, every word in one place: the id and title, the description or a comment (ORR-641).
        const words = filter.in === 'all' && q ? q.split(/\s+/).filter(Boolean) : null
        const listed = records.map(r => ({...r, ref: issueRef(handle, r.id), full_id: fullId('issue', r.id, uid)})).filter(r =>
            (!filter.status || statuses.includes(r.status))
            && (!filter.priority || (filter.priority === 'none' ? !r.priority : r.priority === filter.priority))
            && (!filter.column || columns.includes(r.column))
            && (!filter.assignee || (filter.assignee === 'none' ? !r.assignee : r.assignee === assignee))
            && (!filter.label || r.labels.includes(filter.label))
            && (!filter.external || r.external.includes(filter.external))
            && (!github || r.github_issues.some(g => g.toLowerCase() === github))
            && (!filter.chunk || (filter.chunk === 'none' ? !r.chunk : r.chunk === filter.chunk))
            && (!filter.release || (filter.release === 'none' ? !r.release : r.release === filter.release))
            && (!filter.parent || (filter.parent === 'none' ? !r.parent : r.parent === filter.parent))
            && (!filter.proposal || (filter.proposal === 'none' ? r.column !== 'proposed' : r.proposal === filter.proposal))
            && (!filter.blocked || isBlocked(r) === (filter.blocked === 'true'))
            && (!q || words || r.id.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)))
        return words ? await this.foundIn(project, listed, words) : listed
    }

    /** Those with every word in their id and title first, then those with them in the description or a comment, each saying
     * where and the text around it. What an outsider's session raised (`external`) says only where, so its words go to a
     * session only when it opens the issue. orrery's own comments (a pull request's news) don't count: they say little. */
    private async foundIn(project: string, listed: IssueRecord[], words: string[]): Promise<IssueRecord[]> {
        const has = (text: string) => words.every(word => text.toLowerCase().includes(word))
        const comments = await this.all<{issue: string, body: string}>('SELECT issue, body FROM comments WHERE project = ? AND created_by != ? ORDER BY id DESC', project, ORRERY.name)
        const inText = listed.filter(r => !has(`${r.id} ${r.title}`)).flatMap(r => {
            const body = r.notes && has(r.notes) ? r.notes : comments.find(c => c.issue === r.id && has(c.body))?.body
            if (!body) return []
            return [{...r, match_in: body === r.notes ? 'description' as const : 'comment' as const, ...r.labels.includes('external') ? {} : {match: matchOf(body, words)}}]
        })
        return [...listed.filter(r => has(`${r.id} ${r.title}`)), ...inText]
    }

    async issue(project: string, id: string): Promise<IssueDetail> {
        id = await this.issueId(project, id)
        const found = findIssue(await this.boardOf(project), id)
        if (!found) throw notFound(`No issue ${id} in ${project}`)
        return {...found.issue, project, parent: found.parent, chunk: found.chunk || null, ref: issueRef(await this.handle(), id), full_id: fullId('issue', id, (await this.projectRow(project)).uid)}
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
        const github = await this.githubIssuesOf(project, input.github_issues)
        const depends = await this.linksFrom(project, null, input.depends_on)
        if (parent && depends?.some(l => l.project === project && l.id === parent)) throw badRequest(`${parent} is this issue's parent, so it can't depend on it`)
        const status = await this.resolveStatus(input.status, input.plan)
        const proposed = input.proposal === 'pending'
        let assigned = proposed ? await this.ownerId() : nullable(await this.assigneeOf(input.assignee))
        const rails = await this.railsFor(actor)
        const person = rails?.person
        const kind = (await this.statuses()).find(s => s.id === status)?.kind
        if (rails && !actor.untrusted) {
            // A follow-up under its person's issue is theirs too, unless it's a proposal, which waits on the owner. A new
            // issue with no parent is anyone's on the board to make, but stays nobody's, so it can't be made already taken up.
            if (parent) {
                await this.mustHold(rails, parent, (await this.issueRow(project, parent)).assignee, 'file a sub-issue under it')
                if (!proposed) assigned = person ?? null
            } else {
                if (!person) await this.mustHold(rails, 'a new issue', null, 'make one')
                if (!proposed) {
                    if (await this.railedAssignee(rails, 'a new issue', assigned) === undefined && assigned) throw conflict('Only people assign: a new issue stays unassigned until one does')
                    if (kind && (kind === 'started' || CLOSED.includes(kind))) throw conflict(`A new issue is assigned to nobody, so this session can't make it ${status}; leave it in Todo or Backlog for a person to assign`)
                }
            }
        }

        const taken = parent && person && !proposed && kind === 'started'
        const id = await this.db.transaction(async () => {
            const id = await this.nextId(project, 'issue')
            const now = stamp()
            await this.run(`INSERT INTO issues (project, id, title, status, priority, assignee, labels, external, github_issues, notes, proposal, choices, parent, chunk, ships_in,
                                          position, created_by, session_name, owned, created_at, updated_at, created_person, claimed_by, claimed_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                project, id, String(input.title).trim(), status, nullable(input.priority),
                // A proposal waits on the owner, so it's theirs, whoever the request names.
                assigned,
                JSON.stringify(input.labels ?? []), JSON.stringify(tasksOf(input.external)), JSON.stringify(github ?? []), nullable(input.notes), nullable(input.proposal), String(input.choices ?? '[]'),
                parent, chunk, release, Number(input.position ?? await this.nextPosition('issues', project)), actor.name, actor.session ?? null, Number(actor.owner), now, now,
                person ?? null, taken ? person : null, taken ? now : null)
            await this.record(project, id, actor, [['created', null, null]])
            if (depends) await this.setLinks(project, id, depends, actor)
            await this.touchProject(project)
            return id
        })
        this.changed(project)
        for (const other of new Set(depends?.map(l => l.project))) if (other !== project) this.changed(other)
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
            // Held before it moves (and in moveIssue), as the write after this is too late to refuse: it has already gone.
            const rails = await this.railsFor(actor)
            if (rails) await this.railedAssignee(rails, id, rest.assignee as string | null | undefined)
            const moved = await this.moveIssue(project, id, String(to), parent ?? null, chunk ?? null, actor)
            return await this.updateIssue(String(to), moved, rest, actor)
        }
        const row = await this.issueRow(project, id)
        if (input.proposal === null && row.proposal && !actor.owner) {
            throw refusedFor('issues.edit', `Committing ${id} is the owner's call until they approve it: it's ${row.proposal === 'pending' ? 'waiting on them' : row.proposal === 'changes' ? 'waiting on changes' : 'rejected'}`)
        }
        // While it waits on the owner, it isn't work yet: an agent can still comment, edit it and put it up again.
        const moves = (['status', 'plan', 'assignee', 'release'] as const).filter(field => input[field] !== undefined && !(field === 'assignee' && input.proposal === 'pending'))
        if (moves.length && !actor.owner && (row.proposal === 'pending' || row.proposal === 'changes') && (await this.settings()).restrict_proposals) {
            throw refusedFor('issues.edit', `${id} is a proposal waiting on the owner, so its ${moves.length === 1 ? moves[0] : `${moves.slice(0, -1).join(', ')} and ${moves.at(-1)}`} ${moves.length === 1 ? "isn't" : "aren't"} yours to change until they approve it`)
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
        let assignee = input.proposal === 'pending' ? (await this.ownerId()) : await this.assigneeOf(input.assignee)
        const rails = await this.railsFor(actor)
        // An agent's own proposal is its to edit and put up again, though it waits on the owner.
        const ownProposal = rails?.person && row.proposal && row.created_person === rails.person
        if (rails && !ownProposal) await this.mustHold(rails, id, row.assignee, 'change it')
        if (rails && parent && parent !== row.parent) await this.mustHold(rails, parent, (await this.issueRow(project, parent)).assignee, 'move an issue under it')
        if (rails && input.proposal !== 'pending') assignee = await this.railedAssignee(rails, id, assignee)
        // A claim ends with the issue closed or reassigned; reopening it doesn't bring it back.
        const kinds = await this.statuses()
        const toKind = status === undefined ? undefined : kinds.find(s => s.id === status)?.kind
        const reassigned = assignee !== undefined && (assignee ?? '').toLowerCase() !== (row.assignee ?? '').toLowerCase()
        const ended = reassigned || !!toKind && CLOSED.includes(toKind)
        const labels = input.labels === undefined ? undefined : JSON.stringify(input.labels ?? [])
        const external = input.external === undefined ? undefined : JSON.stringify(tasksOf(input.external))
        const githubIssues = input.github_issues === undefined ? undefined : JSON.stringify(await this.githubIssuesOf(project, input.github_issues) ?? [])
        const moved = input.parent !== undefined && parent !== row.parent
        const depends = await this.linksFrom(project, id, input.depends_on)
        // The projects whose boards show this issue's links: theirs change with its status, as its own does.
        const linked = new Set([...depends?.map(l => l.project) ?? [], ...await this.linkedProjects(project, id)])
        await this.db.transaction(async () => {
            if (rails?.person && toKind === 'started' && !ended) await this.claimFor(project, id, rails.person, row.assignee)
            await this.record(project, id, actor, [
                ['title', row.title, title],
                ['status', row.status, status],
                ['priority', row.priority, input.priority],
                ['assignee', row.assignee, assignee],
                ['labels', row.labels, labels],
                ['external', row.external, external],
                ['github_issues', row.github_issues, githubIssues],
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
                github_issues: githubIssues,
                notes: input.notes,
                proposal: input.proposal,
                choices: input.choices === undefined ? undefined : String(input.choices ?? '[]'),
                // Put up again, it waits on a new decision.
                ...input.proposal === 'pending' ? {decided_by: null, decided_at: null, decision_note: null, picks: null, explore: null} : {},
                parent: input.parent === undefined ? undefined : parent,
                chunk,
                ships_in: release,
                position: input.position,
                ...ended ? {claimed_by: null, claimed_at: null, claimed_session: null} : {},
            })
            if (depends) await this.setLinks(project, id, depends, actor)
            await this.touchProject(project)
        })
        this.changed(project)
        for (const other of linked) if (other !== project) this.changed(other)
        await this.urgent(project, row, await this.issueRow(project, id), actor)
        return await this.issue(project, id)
    }

    /** A person taking up an issue themselves (ORR-657), or an agent its person's. See the route for who may. */
    async claimIssue(project: string, id: string, actor = AGENT): Promise<IssueDetail> {
        id = await this.issueId(project, id)
        const row = await this.issueRow(project, id)
        const rails = await this.railsFor(actor)
        const person = actor.owner ? await this.ownerId() : actor.person ?? (rails ? rails.person : await this.ownerId())
        const holder = await this.holderOf(row.assignee)
        // Only the owner takes one over, and only a person assigns themselves what's nobody's.
        if (rails && (!person || holder !== person) && !(actor.person && !holder)) await this.mustHold(rails, id, row.assignee, 'take it up')
        const assignee = holder === person ? row.assignee : person
        await this.db.transaction(async () => {
            const {changes} = await this.run(`UPDATE issues SET assignee = ?, claimed_by = ?, claimed_at = ?, claimed_session = NULL WHERE project = ? AND id = ?${actor.owner ? '' : " AND coalesce(assignee, '') = ?"}`,
                assignee ?? null, person ?? null, stamp(), project, id, ...actor.owner ? [] : [row.assignee ?? ''])
            if (!Number(changes)) throw conflict(`${id} has just been reassigned; read it again`)
            await this.record(project, id, actor, [['assignee', row.assignee, assignee], ['claim', row.claimed_by, person ?? null]])
            await this.touchProject(project)
        })
        this.changed(project)
        return await this.issue(project, id)
    }

    /** Lets go of a claim, which leaves the issue assigned: its holder's, or the owner's. */
    async releaseIssue(project: string, id: string, actor = AGENT): Promise<IssueDetail> {
        id = await this.issueId(project, id)
        const row = await this.issueRow(project, id)
        if (!row.claimed_by) return await this.issue(project, id)
        const rails = await this.railsFor(actor)
        const person = actor.owner ? await this.ownerId() : actor.person ?? rails?.person
        if (rails && person !== row.claimed_by) throw conflict(`${id} is held by ${row.claimed_by}, so only they or the owner can let it go`)
        await this.db.transaction(async () => {
            await this.update('issues', 'project = ? AND id = ?', [project, id], {claimed_by: null, claimed_at: null, claimed_session: null})
            await this.record(project, id, actor, [['claim', row.claimed_by, null]])
            await this.touchProject(project)
        })
        this.changed(project)
        return await this.issue(project, id)
    }

    /** The GitHub issues sent (`parseGithubIssues`'s JSON), each as kept, `owner/name#523`, once (ORR-635): a bare
     * number is on the project's repo, refused when that isn't on GitHub. Undefined when the write leaves them be. */
    protected async githubIssuesOf(project: string, sent: Input[string]): Promise<string[] | undefined> {
        if (sent === undefined || sent === null) return sent === null ? [] : undefined
        const repo = githubRepo((await this.projectRow(project)).repo)
        const kept = (JSON.parse(String(sent)) as string[]).map(issue => githubIssueOf(issue, repo) ?? (() => {
            throw badRequest(/^#?\d+$/.test(issue)
                ? `${project}'s repo isn't on GitHub, so say whose issue ${issue} is: owner/name${issue.replace(/^#?/, '#')}`
                : `"${issue}" isn't a GitHub issue: send its number on ${repo ?? "the project's repo"}, owner/name#523 or its link`)
        })())
        const seen = new Set<string>()
        return kept.filter(issue => !seen.has(issue.toLowerCase()) && !!seen.add(issue.toLowerCase()))
    }

    /** The issues `depends_on` names, checked (ORR-601): each there (an id it had before finds it), in this project or
     * another, not the issue itself and not one that already depends on it, however far down, which would make a
     * loop nothing could start. `id` is null for an issue not made yet. Undefined when the write leaves them be. */
    protected async linksFrom(project: string, id: string | null, refs: Input[string]): Promise<{project: string, id: string}[] | undefined> {
        if (refs === undefined) return undefined
        const links: {project: string, id: string}[] = []
        for (const ref of (refs ?? []) as string[]) {
            const named = parseLinkRef(project, ref)
            if (!named.project || !named.id) throw badRequest(`"${ref}" in "depends_on" isn't an issue: use its id, or project/ID for another project's`)
            const on = {project: named.project, id: await this.issueId(named.project, named.id)}
            await this.issueRow(on.project, on.id)
            if (on.project === project && on.id === id) throw badRequest(`An issue can't depend on itself`)
            if (!links.some(l => l.project === on.project && l.id === on.id)) links.push(on)
        }
        if (links.length > MAX_DEPENDS) throw badRequest(`An issue can depend on ${MAX_DEPENDS} issues at most`)
        if (id) {
            // A sub-issue and its parent already go together: one waiting on the other could never start.
            const row = await this.issueRow(project, id)
            for (const on of links.filter(l => l.project === project)) {
                if (on.id === row.parent || (await this.issueRow(project, on.id)).parent === id) {
                    throw badRequest(`${on.id} and ${id} are a parent and its sub-issue, so one can't depend on the other`)
                }
            }
            for (const on of links) {
                const path = await this.dependsPath(on, {project, id})
                if (path) throw badRequest(`${linkRef(project, on.project, on.id)} already depends on ${id}${path.length > 2 ? ` (through ${path.slice(1, -1).map(p => linkRef(project, p.project, p.id)).join(', ')})` : ''}, so ${id} can't depend on it`)
            }
        }
        return links
    }

    /** The chain from `from` to `to` along what each depends on, if there's one: both ends included. */
    private async dependsPath(from: {project: string, id: string}, to: {project: string, id: string}): Promise<{project: string, id: string}[] | null> {
        const key = (l: {project: string, id: string}) => `${l.project}\u0000${l.id}`
        const came = new Map<string, {project: string, id: string} | null>([[key(from), null]])
        const queue = [from]
        for (let at = queue.shift(); at; at = queue.shift()) {
            if (at.project === to.project && at.id === to.id) {
                const path = [at]
                for (let back = came.get(key(at)); back; back = came.get(key(back))) path.unshift(back)
                return path
            }
            for (const next of await this.all<{project: string, id: string}>('SELECT on_project AS project, on_issue AS id FROM issue_links WHERE project = ? AND issue = ?', at.project, at.id)) {
                if (came.has(key(next))) continue
                came.set(key(next), at)
                queue.push(next)
            }
        }
        return null
    }

    /** Makes `links` what the issue depends on, each one added or dropped once, in its activity as `depends`. */
    protected async setLinks(project: string, id: string, links: {project: string, id: string}[], actor: Actor) {
        const before = await this.all<{project: string, id: string}>('SELECT on_project AS project, on_issue AS id FROM issue_links WHERE project = ? AND issue = ? ORDER BY created_at, on_project, on_issue', project, id)
        const same = (a: {project: string, id: string}) => (b: {project: string, id: string}) => a.project === b.project && a.id === b.id
        const now = stamp()
        for (const gone of before.filter(b => !links.some(same(b)))) {
            await this.run('DELETE FROM issue_links WHERE project = ? AND issue = ? AND on_project = ? AND on_issue = ?', project, id, gone.project, gone.id)
        }
        for (const added of links.filter(l => !before.some(same(l)))) {
            await this.run('INSERT INTO issue_links (project, issue, on_project, on_issue, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                project, id, added.project, added.id, actor.name, Number(actor.owner), now)
        }
        const refs = (list: {project: string, id: string}[]) => list.length ? JSON.stringify(list.map(l => linkRef(project, l.project, l.id))) : null
        const kept = [...before.filter(b => links.some(same(b))), ...links.filter(l => !before.some(same(l)))]
        await this.record(project, id, actor, [['depends', refs(before), refs(kept)]])
    }

    /** The other projects an issue is linked with, either way. */
    protected async linkedProjects(project: string, id: string): Promise<string[]> {
        return (await this.all<{project: string}>(`SELECT on_project AS project FROM issue_links WHERE project = ? AND issue = ?
            UNION SELECT project FROM issue_links WHERE on_project = ? AND on_issue = ?`, project, id, project, id)).map(r => r.project)
    }

    /** An issue the owner's or a member's write (which goes to their own sessions) just made urgent open work (P0, and committed, not closed and not blocked, which it wasn't
     * before) goes to the sessions as a focus, without their asking: to the session working it while it can hear,
     * else to one session orrery picks (pool.ts). The write is saved by now, so a push that fails is only logged. */
    protected async urgent(project: string, before: IssueRow | null, after: IssueRow, actor: Actor) {
        try {
            const urgentWork = async (row: IssueRow) => row.priority === 'P0' && !row.proposal
                && !CLOSED.includes((await this.statuses()).find(s => s.id === row.status)?.kind as Kind)
            if (!(actor.owner || actor.person) || !await urgentWork(after) || (before && await urgentWork(before))) return
            // One blocked (ORR-601) waits for what it depends on, urgent or not: it's handed out once that's done.
            if ((await this.blockers(project, after.id)).length) return
            // On a board with more than one person, what's nobody's stays put (ORR-656).
            if (actor.owner && await this.whoseWork(project, after.assignee) === null) return
            await this.sendFocus(project, after.id, {note: 'It was just made urgent (P0).'}, actor)
        } catch (error) {
            console.error(`[orrery] pushing urgent ${after.id} in ${project}:`, error)
        }
    }
}
