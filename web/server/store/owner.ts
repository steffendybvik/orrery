// The owner (their name and id) and the bell: agents' comments waiting on them.
import type {Notice, NoticeList, Owner} from '#shared/roadmap'
import {NOTICE_LISTS} from '#shared/roadmap'
import type {Input} from '../utils/input'
import {badRequest, checkInput, forbidden} from '../utils/input'
import type {CommentRow} from './schema'
import {AGENT, OWNER_FIELDS, actorId, ANSWERED, commentOf} from './schema'
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
            await this.run('UPDATE issues SET assignee = ? WHERE lower(assignee) = ?', name, before.name)
            await this.run('UPDATE issues SET decided_by = ? WHERE lower(decided_by) = ?', name, before.name)
        })
        if (name !== before.name) for (const {id} of await this.all<{id: string}>('SELECT id FROM projects')) this.changed(id)
        // Open pages hear it with the settings, and ask who the owner is now.
        this.onSettings(await this.settings())
        return await this.ownerOf()
    }

    /** Agents' comments across projects. The `bell`: the latest 30 not cleared, those still waiting on the
     * owner (a decision or feedback they haven't answered) first. The notifications page's lists, newest
     * first: `waiting` (every one), and `inbox` (the rest) and `cleared` a page at a time, `limit` of them
     * (50, at most 200) older than the notice `before`. */
    async notices({list = 'bell', before, limit}: {list?: NoticeList, before?: number, limit?: number} = {}): Promise<Notice[]> {
        const which = {
            bell: 'cleared = 0',
            waiting: 'cleared = 0 AND asks IS NOT NULL AND NOT answered',
            inbox: 'cleared = 0 AND NOT (asks IS NOT NULL AND NOT answered)',
            cleared: 'cleared = 1',
        }[list]
        if (!NOTICE_LISTS.includes(list)) throw badRequest(`Unknown list "${list}"; use ${NOTICE_LISTS.join(', ')}`)
        const paged = list === 'inbox' || list === 'cleared'
        const after = paged && before !== undefined ? 'AND (created_at, id) < (SELECT created_at, id FROM comments WHERE id = ?)' : ''
        const count = list === 'bell' ? 30 : paged ? Math.min(Math.max(1, limit ?? 50), 200) : undefined
        return (await this.all<CommentRow & {title: string, cleared: number}>(`
            SELECT * FROM (
                SELECT c.*, i.title, ${ANSWERED} FROM comments c JOIN issues i ON i.project = c.project AND i.id = c.issue
                WHERE c.owned = 0) AS listed
            WHERE ${which} ${after}
            ORDER BY ${list === 'bell' ? '(asks IS NOT NULL AND NOT answered) DESC, ' : ''}created_at DESC, id DESC ${count ? 'LIMIT ?' : ''}`,
        ...after && before !== undefined ? [before] : [], ...count ? [count] : []))
            .map(row => ({...commentOf(row), project: row.project, title: row.title, ...row.cleared ? {cleared: true} : {}}))
    }

    /** Takes notices out of the bell (the comments stay on their issues): those in `ids`, or all made at
     * or before `before`. Says how many. */
    async clearNotices(body: unknown): Promise<number> {
        const {ids, before} = (body ?? {}) as {ids?: unknown, before?: unknown}
        if (Array.isArray(ids) && ids.every(id => Number.isInteger(id)) && ids.length) {
            return Number((await this.run(`UPDATE comments SET cleared = 1 WHERE owned = 0 AND cleared = 0 AND id IN (${ids.map(() => '?').join(', ')})`, ...ids as number[])).changes)
        }
        if (typeof before === 'string' && before) {
            // Not the ones still waiting on the owner: those go when they're answered, or one by one.
            return Number((await this.run(`UPDATE comments AS c SET cleared = 1 WHERE owned = 0 AND cleared = 0 AND created_at <= ?
                AND (asks IS NULL OR EXISTS (SELECT 1 FROM comments o WHERE o.project = c.project AND o.issue = c.issue AND o.owned = 1 AND o.id > c.id))`, before)).changes)
        }
        throw badRequest('Send "ids" (comment ids) or "before" (a time) to clear')
    }

    /** The handle in issues' references: the owner's, or else their id. */
    protected async handle(): Promise<string> {
        return (await this.settings()).handle ?? (await this.ownerOf()).name
    }
}
