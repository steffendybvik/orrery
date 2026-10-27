// Many issues at once, and what moves or deletes an issue with its sub-issues.
import type {Choice, Decision, Picks} from '#shared/roadmap'
import type {Input} from '../utils/input'
import {badRequest, checkInput, forbidden} from '../utils/input'
import {describePicks, resolvePicks} from '../utils/choices'
import {UPSERT_ISSUE_ALIAS} from '../utils/renumber'
import type {BulkResult, IssueDetail, Actor} from './schema'
import {BULK_FIELDS, AGENT, DECISION_FIELDS, DECIDED, stamp} from './schema'
import {CommentStore} from './comments'

export abstract class BulkStore extends CommentStore {
    /** Runs `work` for each issue on its own, so one refusal doesn't stop the rest, and says each one's outcome. */
    protected async each(ids: unknown, work: (id: string) => Promise<unknown>): Promise<BulkResult[]> {
        if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw badRequest('Send "ids": the issues, as a list of their ids')
        const held = this.held ??= new Set()
        try {
            const results: BulkResult[] = []
            for (const id of new Set(ids as string[])) {
                try {
                    await work(id)
                    results.push({id, ok: true})
                } catch (error) {
                    results.push({id, ok: false, error: (error as Error).message})
                }
            }
            return results
        } finally {
            if (this.held === held) {
                this.held = null
                held.forEach(project => this.changed(project))
            }
        }
    }

    /** One change to many issues: `{ids, set: {status?, priority?, assignee?, chunk?, release?}, labels?: {add?, remove?}}`. */
    async updateIssues(project: string, body: unknown, actor = AGENT): Promise<BulkResult[]> {
        await this.projectRow(project)
        const {ids, set = {}, labels} = (body ?? {}) as {ids?: unknown, set?: Record<string, unknown>, labels?: {add?: unknown, remove?: unknown}}
        const fields = Object.keys(set ?? {}).filter(key => !BULK_FIELDS.includes(key))
        if (fields.length) throw badRequest(`Many issues at once take ${BULK_FIELDS.join(', ')} in "set", and labels as {add, remove}; not ${fields.join(', ')}`)
        const list = (value: unknown, key: string) => {
            if (value === undefined) return []
            if (!Array.isArray(value) || value.some(l => typeof l !== 'string')) throw badRequest(`"labels.${key}" should be a list of labels`)
            return value as string[]
        }
        const [add, remove] = [list(labels?.add, 'add'), list(labels?.remove, 'remove')]
        return await this.each(ids, async id => {
            const patch: Record<string, unknown> = {...set}
            if (add.length || remove.length) {
                const now = JSON.parse((await this.issueRow(project, await this.issueId(project, id))).labels) as string[]
                patch.labels = [...new Set([...now.filter(l => !remove.includes(l)), ...add])]
            }
            await this.updateIssue(project, id, patch, actor)
        })
    }

    /** The owner's one decision on many proposals: `{ids, decision, note?}`. Approving takes each one's recommended
     * picks; one with a choice that has none is skipped, so nothing is approved on a guess. */
    async decideIssues(project: string, body: unknown, actor = AGENT): Promise<BulkResult[]> {
        await this.projectRow(project)
        const {ids, ...decision} = (body ?? {}) as {ids?: unknown}
        if ('picks' in decision || 'explore' in decision) throw badRequest('Many proposals at once take a decision and a note; picks and explore go one at a time')
        return await this.each(ids, async id => {
            const row = await this.issueRow(project, await this.issueId(project, id))
            const choices = JSON.parse(row.choices) as Choice[]
            const unsure = choices.filter(c => !c.from && !c.recommended?.length)
            if ((decision as {decision?: string}).decision === 'approved' && unsure.length) {
                throw badRequest(`Needs your picks: nothing is recommended for ${unsure.map(c => `"${c.question}"`).join(', ')}`)
            }
            await this.decide(project, id, decision, actor)
        })
    }

    /** Many issues deleted, each with its sub-issues; one under another in the list goes with it. */
    async deleteIssues(project: string, body: unknown, actor = AGENT): Promise<BulkResult[]> {
        await this.projectRow(project)
        const {ids} = (body ?? {}) as {ids?: unknown}
        const gone = new Set<string>()
        return await this.each(ids, async id => {
            id = await this.issueId(project, id)
            if (gone.has(id)) return
            const subtree = await this.subtree(project, id)
            await this.deleteIssue(project, id, actor)
            subtree.forEach(i => gone.add(i))
        })
    }

    /** Deletes its sub-issues and comments too. */
    async deleteIssue(project: string, id: string, actor = AGENT) {
        id = await this.issueId(project, id)
        await this.issueRow(project, id)
        const subtree = await this.subtree(project, id)
        this.refuse(actor, `Deleting ${id}`, await this.ownedUnder(project, subtree))
        await this.db.transaction(async () => {
            await this.run(`DELETE FROM issue_aliases WHERE project = ? AND issue IN (${subtree.map(() => '?').join(', ')})`, project, ...subtree)
            await this.issuesMoved(project, new Map(subtree.map(old => [old, null])))
            await this.run('DELETE FROM issues WHERE project = ? AND id = ?', project, id)
            await this.touchProject(project)
        })
        this.changed(project)
    }

    /** The owner's decision on a proposal: approved (which commits it, into Todo: approving means it's work), changes asked
     * for, or rejected. It's kept on the issue and left as their comment, so the session on it hears, and
     * the issue goes back to the agent who proposed it. */
    async decide(project: string, id: string, body: unknown, actor = AGENT): Promise<IssueDetail> {
        id = await this.issueId(project, id)
        const row = await this.issueRow(project, id)
        if (!actor.owner) throw forbidden(`Deciding on ${id} is the owner's call; send Orrery-Actor: <owner>`)
        if (!row.proposal) throw badRequest(`${id} isn't a proposal; make it one with PATCH {"proposal": "pending"}`)
        const input = checkInput(body ?? {}, DECISION_FIELDS)
        const decision = input.decision as Decision
        const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null
        const assignee = row.owned ? row.assignee : row.created_by
        // With choices: approving takes the picks (the recommendation where none is sent), and asking for
        // changes can name an option to go further down.
        const choices = JSON.parse(row.choices) as Choice[]
        if (input.picks !== undefined && (decision !== 'approved' || !choices.length)) throw badRequest(`"picks" go with approving a proposal that has choices`)
        if (input.explore !== undefined && decision !== 'changes') throw badRequest(`"explore" goes with asking for changes`)
        let picks: Picks | null = null
        if (decision === 'approved' && choices.length) {
            try {
                picks = resolvePicks(choices, input.picks ? JSON.parse(String(input.picks)) as Picks : {})
            } catch (error) {
                throw badRequest(`Can't approve ${id} with those picks: ${(error as Error).message}`)
            }
        }
        const explore = input.explore ? JSON.parse(String(input.explore)) as {choice: string, option: string} : null
        const explored = explore && choices.find(c => c.key === explore.choice)?.options.find(o => o.key === explore.option)
        if (explore && !explored) throw badRequest(`${id} has no option ${explore.option} in a choice "${explore.choice}"`)
        await this.db.transaction(async () => {
            await this.run('UPDATE issues SET proposal = ?, decided_by = ?, decided_at = ?, decision_note = ?, assignee = ?, picks = ?, explore = ? WHERE project = ? AND id = ?',
                decision, actor.name, stamp(), note, assignee, picks ? JSON.stringify(picks) : null, explore ? JSON.stringify(explore) : null, project, id)
            await this.record(project, id, actor, [['proposal', row.proposal, decision], ['assignee', row.assignee, assignee]])
        })
        const said = picks ? `Approved this proposal with:\n${describePicks(choices, picks)}`
            : explored ? `Asked to explore ${explored.key} (${explored.title}) further: add a choice that goes down it, then put the proposal up again.`
            : DECIDED[decision]
        await this.createComment(project, id, {body: note ? `${said}\n\n${note}` : said}, actor)
        // Approving is the owner saying it's work, so it goes on the roadmap now, keeping who decided and the picks:
        // into Todo while it's still in the backlog, else where its work already took it (started, done).
        if (decision === 'approved') {
            const waiting = (await this.statuses()).find(s => s.id === row.status)?.kind === 'backlog'
            return await this.updateIssue(project, id, waiting ? {proposal: null, status: 'todo'} : {proposal: null}, actor)
        }
        return await this.issue(project, id)
    }

    /** Moves an issue and everything under it to `to`, where they get its ids (KEY-n); the ids they had
     * stay as aliases there. Says the issue's new id. */
    protected async moveIssue(from: string, id: string, to: string, parent: Input[string], chunk: Input[string], actor: Actor): Promise<string> {
        await this.projectRow(to)
        const parentId = parent ? await this.issueId(to, String(parent)) : null
        const chunkId = chunk ? await this.chunkId(to, String(chunk)) : null
        if (parentId) await this.issueRow(to, parentId)
        if (parentId && chunkId) throw badRequest(`A sub-issue is in its parent's chunk; leave out "chunk" or "parent"`)
        if (chunkId) await this.chunkRow(to, chunkId)
        const subtree = await this.subtree(from, id)
        const marks = subtree.map(() => '?').join(', ')
        // Releases are the source project's, so an issue keeps its release only between projects sharing them.
        const source = await this.releaseSource(from)
        const ships = source && source === await this.releaseSource(to) ? 'ships_in' : 'NULL'
        const moved = await this.db.transaction(async () => {
            // Rows move first and get their new ids and links after, so the foreign keys wait for the commit.
            await this.db.deferConstraints()
            const names = new Map<string, string>()
            for (const old of subtree) names.set(old, await this.nextId(to, 'issue'))
            const links = await this.all<{id: string, parent: string | null}>(`SELECT id, parent FROM issues WHERE project = ? AND id IN (${marks})`, from, ...subtree)
            const comments = await this.all<{id: number, issue: string}>(`SELECT id, issue FROM comments WHERE project = ? AND issue IN (${marks})`, from, ...subtree)
            const aliases = await this.all<{alias: string, issue: string}>(`SELECT alias, issue FROM issue_aliases WHERE project = ? AND issue IN (${marks})`, from, ...subtree)
            const position = await this.nextPosition('issues', to)
            for (const link of links) {
                const next = names.get(link.id)!
                await this.run(`UPDATE issues SET project = ?, id = ?, parent = ?, chunk = ?, ships_in = ${ships}, position = position + ? WHERE project = ? AND id = ?`,
                    to, next, link.id === id ? parentId : names.get(link.parent!) ?? null, link.id === id && !parentId ? chunkId : null, position, from, link.id)
            }
            for (const comment of comments) await this.run('UPDATE comments SET project = ?, issue = ? WHERE id = ?', to, names.get(comment.issue)!, comment.id)
            for (const [old, next] of names) await this.run('UPDATE issue_events SET project = ?, issue = ? WHERE project = ? AND issue = ?', to, next, from, old)
            await this.record(to, names.get(id)!, actor, [['project', from, to]])
            await this.run(`DELETE FROM issue_aliases WHERE project = ? AND issue IN (${marks})`, from, ...subtree)
            for (const {alias, issue} of aliases) await this.run(UPSERT_ISSUE_ALIAS, to, alias, names.get(issue)!)
            for (const [old, next] of names) await this.run(UPSERT_ISSUE_ALIAS, to, old, next)
            await this.issuesMoved(from, names, to)
            await this.run('UPDATE issues SET updated_at = ? WHERE project = ? AND id = ?', stamp(), to, names.get(id)!)
            await this.touchProject(from)
            await this.touchProject(to)
            return names.get(id)!
        })
        this.changed(from)
        this.changed(to)
        return moved
    }

    /** What names an issue by id without a foreign key to it, after the issues in `names` moved from
     * `project` to `to` (under their new id) or went (null): their signals follow them, so a session
     * catching up is told about the issue where it is now, or not at all; a schedule's runs let go of
     * one that went. So no id there comes to mean another issue. */
    protected async issuesMoved(project: string, names: Map<string, string | null>, to = project) {
        for (const [old, next] of names) {
            if (next) await this.run('UPDATE signals SET project = ?, issue = ? WHERE project = ? AND issue = ?', to, next, project, old)
            else {
                await this.run('DELETE FROM signals WHERE project = ? AND issue = ?', project, old)
                await this.run('UPDATE schedule_runs SET issue = NULL WHERE issue = ? AND schedule IN (SELECT id FROM schedules WHERE project = ?)', old, project)
            }
        }
    }

    /** The issue's id and every id under it. */
    protected async subtree(project: string, id: string): Promise<string[]> {
        const children = await this.all<{id: string}>('SELECT id FROM issues WHERE project = ? AND parent = ?', project, id)
        return [id, ...(await Promise.all(children.map(c => this.subtree(project, c.id)))).flat()]
    }
}
