// The owner (their name and id) and the bell: agents' comments waiting on them.
import type {Notice, NoticeList, Owner} from '#shared/roadmap'
import {NOTICE_LISTS} from '#shared/roadmap'
import type {Input} from '../utils/input'
import {badRequest, checkInput, forbidden} from '../utils/input'
import type {CommentRow} from './schema'
import {AGENT, OWNER_FIELDS, actorId, ANSWERED, SINCE, commentOf, stamp} from './schema'
import {StatusStore} from './statuses'

export abstract class OwnerStore extends StatusStore {
    /** The owner's id: what waits on them (a proposal, an agent's ask) is assigned to it. */
    protected async ownerId() {
        return (await this.ownerOf()).name
    }

    /** An assignee as stored: `owner` is the owner's id, whatever their name, so an agent needn't know it. */
    protected async assigneeOf(value: Input[string]): Promise<string | null | undefined> {
        if (value === undefined) return undefined
        const name = String(value ?? '').trim()
        return name.toLowerCase() === 'owner' ? await this.ownerId() : name || null
    }

    /** The owner: their name as the page shows it, their `Orrery-Actor` id, and whether they've given it. */
    async ownerOf(): Promise<Owner> {
        const row = await this.get<{value: string}>("SELECT value FROM settings WHERE key = 'owner'")
        const display = row ? String(JSON.parse(row.value)) : ''
        return display ? {name: actorId(display), display, named: true} : {name: this.unnamed, display: this.unnamed, named: false}
    }

    /** Names the owner: anyone may the first time (the page asks on first open), then only the owner. What
     * was theirs under the old id (what they made, what's assigned to them, their decisions) moves to the new one. */
    async nameOwner(body: unknown, actor = AGENT): Promise<Owner> {
        const before = await this.ownerOf()
        if (before.named && !actor.owner) throw forbidden("Only the owner renames the owner; send Orrery-Actor: <owner>")
        const display = String(checkInput(body, OWNER_FIELDS).name).trim().slice(0, 60)
        const name = actorId(display)
        if (!name) throw badRequest('The name needs a letter or a digit in it')
        if (name === AGENT.name) throw badRequest(`"${AGENT.name}" is what requests without Orrery-Actor are; pick another name`)
        // Every agent sends this one, as the guide tells it to: as the owner's name it would make them all the owner.
        if (name === 'claude') throw badRequest('"claude" is what agents send as Orrery-Actor; pick another name')
        await this.db.transaction(async () => {
            await this.run("INSERT INTO settings (key, value) VALUES ('owner', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(display))
            if (name === before.name) return
            for (const table of ['projects', 'chunks', 'issues', 'docs', 'comments', 'signals', 'schedules', 'issue_events'])
                await this.run(`UPDATE ${table} SET created_by = ? WHERE owned = 1 AND lower(created_by) = ?`, name, before.name)
            await this.run('UPDATE schedules_across SET created_by = ? WHERE lower(created_by) = ?', name, before.name)
            await this.run('UPDATE issues SET assignee = ? WHERE lower(assignee) = ?', name, before.name)
            await this.run('UPDATE issues SET decided_by = ? WHERE lower(decided_by) = ?', name, before.name)
        })
        if (name !== before.name) for (const {id} of await this.all<{id: string}>('SELECT id FROM projects')) this.changed(id)
        // Open pages hear it with the settings, and ask who the owner is now.
        this.onSettings(await this.settings())
        return await this.ownerOf()
    }

    /** Agents' comments across projects. The `bell`: the latest 30 not cleared, those still waiting on the
     * owner (a decision or feedback they haven't answered) first, with agents' proposals waiting on them
     * ahead of all. The notifications page's lists, newest first: `waiting` (every one, proposals among
     * them), and `inbox` (the rest) and `cleared` a page at a time, `limit` of them (50, at most 200) older
     * than the notice `before`. A proposal the owner cleared is only in `cleared`, on its first page. */
    async notices({list = 'bell', before, limit}: {list?: NoticeList, before?: number, limit?: number} = {}): Promise<Notice[]> {
        const comments = await this.commentNotices({list, before, limit})
        if (list === 'inbox' || list === 'cleared' && before !== undefined) return comments
        const proposals = await this.proposalNotices(list === 'cleared')
        return list === 'bell'
            ? [...proposals, ...comments]
            : [...proposals, ...comments].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
    }

    /** Agents' proposals waiting on the owner (pending, not under another proposal), newest put up first: those not
     * cleared, or only those `cleared` since they were last put up. */
    private async proposalNotices(cleared = false): Promise<Notice[]> {
        const rows = await this.all<{project: string, id: string, title: string, notes: string | null, choices: string, created_by: string, created_at: string, updated_at: string, put_up: string}>(`
            SELECT * FROM (
                SELECT i.project, i.id, i.title, i.notes, i.choices, i.created_by, i.created_at, i.updated_at,
                    coalesce((SELECT max(e.created_at) FROM issue_events e WHERE e.project = i.project AND e.issue = i.id AND e.field = 'proposal' AND e.after = 'pending'), i.created_at) AS put_up
                FROM issues i
                WHERE i.proposal = 'pending' AND i.owned = 0
                    AND NOT EXISTS (SELECT 1 FROM issues p WHERE p.project = i.project AND p.id = i.parent AND p.proposal IS NOT NULL)) AS pending
            WHERE ${cleared ? '' : 'NOT '}EXISTS (SELECT 1 FROM proposal_clears c WHERE c.project = pending.project AND c.issue = pending.id AND c.put_up = pending.put_up)`)
        return rows.map(row => ({
            id: 0, issue: row.id, body: row.notes ?? '', asks: 'decision' as const, answered: false,
            created_by: row.created_by, protected: false, created_at: row.put_up, updated_at: row.updated_at,
            project: row.project, title: row.title, proposal: {choices: (JSON.parse(row.choices || '[]') as unknown[]).length},
            ...cleared ? {cleared: true} : {},
        })).sort((a, b) => b.created_at.localeCompare(a.created_at))
    }

    private async commentNotices({list = 'bell', before, limit}: {list?: NoticeList, before?: number, limit?: number}): Promise<Notice[]> {
        if (!NOTICE_LISTS.includes(list)) throw badRequest(`Unknown list "${list}"; use ${NOTICE_LISTS.join(', ')}`)
        // The bell: those waiting on the owner first, then the latest, 30 in all.
        if (list === 'bell') {
            const waiting = await this.commentRows(`c.cleared = 0 AND c.asks IS NOT NULL AND NOT ${SINCE}`, 30)
            const latest = await this.commentRows('c.cleared = 0', 30)
            const seen = new Set(waiting.map(n => n.id))
            return [...waiting, ...latest.filter(n => !seen.has(n.id))].slice(0, 30)
        }
        const which = {
            waiting: `c.cleared = 0 AND c.asks IS NOT NULL AND NOT ${SINCE}`,
            inbox: `c.cleared = 0 AND (c.asks IS NULL OR ${SINCE})`,
            cleared: 'c.cleared = 1',
        }[list]
        const paged = list === 'inbox' || list === 'cleared'
        return await this.commentRows(which, paged ? Math.min(Math.max(1, limit ?? 50), 200) : undefined, paged ? before : undefined)
    }

    /** Agents' comments matching `which`, newest first, at most `count`, older than the comment `before`. Filtered
     * before they're joined to their issues and `answered` is worked out, so an index on the comments walks them in
     * order and stops at `count` (ORR-441). */
    private async commentRows(which: string, count?: number, before?: number): Promise<Notice[]> {
        const after = before !== undefined ? 'AND (c.created_at, c.id) < (SELECT created_at, id FROM comments WHERE id = ?)' : ''
        return (await this.all<CommentRow & {title: string, cleared: number}>(`
            SELECT c.*, i.title, ${ANSWERED} FROM comments c JOIN issues i ON i.project = c.project AND i.id = c.issue
            WHERE c.owned = 0 AND ${which} ${after}
            ORDER BY c.created_at DESC, c.id DESC ${count ? 'LIMIT ?' : ''}`,
        ...before !== undefined ? [before] : [], ...count ? [count] : []))
            .map(row => ({...commentOf(row), project: row.project, title: row.title, ...row.cleared ? {cleared: true} : {}}))
    }

    /** Takes notices out of the bell (the comments stay on their issues, the proposals pending): the comments in
     * `ids` and the agents' proposals in `proposals` (`{project, issue}`), or all comments made at or before `before`.
     * Says how many. */
    async clearNotices(body: unknown): Promise<number> {
        const {ids = [], proposals = [], before} = (body ?? {}) as {ids?: unknown, proposals?: unknown, before?: unknown}
        const picked = Array.isArray(ids) && ids.every(id => Number.isInteger(id)) && Array.isArray(proposals)
            && proposals.every(p => typeof p?.project === 'string' && typeof p?.issue === 'string')
        if (picked && (ids.length || proposals.length)) {
            let cleared = ids.length
                ? Number((await this.run(`UPDATE comments SET cleared = 1 WHERE owned = 0 AND cleared = 0 AND id IN (${ids.map(() => '?').join(', ')})`, ...ids as number[])).changes)
                : 0
            const waiting = new Map((await this.proposalNotices()).map(n => [`${n.project}/${n.issue}`, n.created_at]))
            const now = stamp()
            for (const {project, issue} of proposals as {project: string, issue: string}[]) {
                const putUp = waiting.get(`${project}/${issue}`)
                if (!putUp) continue
                await this.run('INSERT INTO proposal_clears (project, issue, put_up, cleared_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', project, issue, putUp, now)
                cleared++
            }
            return cleared
        }
        if (typeof before === 'string' && before) {
            // Not the ones still waiting on the owner: those go when they're answered, or one by one.
            return Number((await this.run(`UPDATE comments AS c SET cleared = 1 WHERE owned = 0 AND cleared = 0 AND created_at <= ?
                AND (asks IS NULL OR EXISTS (SELECT 1 FROM comments o WHERE o.project = c.project AND o.issue = c.issue AND o.owned = 1 AND o.id > c.id))`, before)).changes)
        }
        throw badRequest('Send "ids" (comment ids), "proposals" ([{project, issue}]) or "before" (a time) to clear')
    }

    /** The handle in issues' references: the owner's, or else their id. */
    protected async handle(): Promise<string> {
        return (await this.settings()).handle ?? (await this.ownerOf()).name
    }
}
