// The Orrery's statuses (every project's board has them) and its own settings.
import {randomBytes} from 'node:crypto'
import type {IssueStatus, Kind, Settings, Starts, TerminalApp} from '#shared/roadmap'
import {KINDS, slugify} from '#shared/roadmap'
import type {Input} from '../utils/input'
import {badRequest, checkInput, conflict, forbidden, notFound} from '../utils/input'
import type {Instruction} from '#shared/prompt'
import type {Actor} from './schema'
import {AGENT, SLUG, STATUS_FIELDS, LEGACY_KINDS, SETTINGS_FIELDS, nullable} from './schema'
import {StoreBase} from './base'
import {known} from '#shared/known'

export abstract class StatusStore extends StoreBase {
    /** This Orrery's own settings. */
    async settings(): Promise<Settings> {
        let rows = await this.all<{key: string, value: string}>('SELECT key, value FROM settings')
        // Its id is made the first time it's asked for, and kept.
        if (!rows.some(r => r.key === 'id')) {
            await this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', 'id', JSON.stringify(`orr_${randomBytes(3).toString('hex')}`))
            rows = await this.all<{key: string, value: string}>('SELECT key, value FROM settings')
        }
        const value = (key: string) => {
            const row = rows.find(r => r.key === key)
            return row ? JSON.parse(row.value) as unknown : undefined
        }
        return {
            id: value('id') as string,
            tint: (value('tint') as string | undefined) ?? null,
            statuses: await this.statuses(),
            focus_prompt: (value('focus_prompt') as string | undefined) || null,
            chunk_prompt: (value('chunk_prompt') as string | undefined) || null,
            instructions: (value('instructions') as Instruction[] | undefined) ?? [],
            handle: (value('handle') as string | undefined) || null,
            tracker: (value('tracker') as string | undefined) || null,
            starts: (value('starts') as Starts | null | undefined) ?? null,
            terminal: (value('terminal') as TerminalApp | undefined) ?? 'terminal',
            restrict_proposals: (value('restrict_proposals') as boolean | undefined) ?? true,
            advanced: (value('advanced') as boolean | undefined) ?? false,
        }
    }

    /** The issue statuses, in board order: by kind, then as arranged. */
    async statuses(): Promise<IssueStatus[]> {
        const rows = await this.all<IssueStatus>('SELECT id, name, kind, color, position FROM statuses ORDER BY position, id')
        return KINDS.flatMap(kind => rows.filter(r => r.kind === kind))
    }

    /** A new status, the owner's to add: `{name, kind, color?, id?, position?}`. */
    async createStatus(body: unknown, actor = AGENT): Promise<IssueStatus> {
        this.ownerOnly(actor, 'statuses')
        const input = checkInput(body, {...STATUS_FIELDS, color: {...STATUS_FIELDS.color, required: false}})
        const name = String(input.name).trim()
        const id = input.id ? String(input.id) : slugify(name)
        if (!SLUG.test(id)) throw badRequest(`"${name}" doesn't make an id; give one in "id"`)
        if (id === 'proposed') throw badRequest('"proposed" is where proposals sit; give the status another id')
        if (await this.get('SELECT 1 FROM statuses WHERE id = ?', id)) throw conflict(`There is already a status "${id}"`)
        const position = input.position ?? ((await this.get<{n: number | null}>('SELECT max(position) AS n FROM statuses'))?.n ?? 0) + 1
        await this.run('INSERT INTO statuses (id, name, kind, color, position) VALUES (?, ?, ?, ?, ?)', id, name, String(input.kind), String(input.color ?? 'slate'), Number(position))
        await this.statusesChanged()
        return await this.status(id)
    }

    /** Renames, recolours or moves a status, or gives it another kind (not the last of its kind). */
    async updateStatus(id: string, body: unknown, actor = AGENT): Promise<IssueStatus> {
        this.ownerOnly(actor, 'statuses')
        const before = await this.status(id)
        const input = checkInput(body, STATUS_FIELDS, true)
        if (input.id !== undefined && input.id !== id) throw badRequest("A status's id can't change; rename it with \"name\"")
        if (input.kind !== undefined && input.kind !== before.kind) await this.keepOneOf(before)
        await this.run('UPDATE statuses SET name = coalesce(?, name), kind = coalesce(?, kind), color = coalesce(?, color), position = coalesce(?, position) WHERE id = ?',
            input.name === undefined ? null : String(input.name).trim(), nullable(input.kind), nullable(input.color), input.position === undefined ? null : Number(input.position), id)
        await this.statusesChanged()
        return await this.status(id)
    }

    /** Removes a status; its issues and schedules move to `into` (another status), which it needs when it has any. */
    async deleteStatus(id: string, into: string | undefined, actor = AGENT) {
        this.ownerOnly(actor, 'statuses')
        const status = await this.status(id)
        await this.keepOneOf(status)
        const used = (await this.one<{n: number}>('SELECT (SELECT count(*) FROM issues WHERE status = ?) + (SELECT count(*) FROM schedules WHERE place = ?) AS n', id, id)).n
        if (into !== undefined) await this.status(into)
        if (into === id) throw badRequest('Move its issues to another status')
        if (used && !into) throw conflict(`${used} issues or schedules are in ${status.name}; say which status they move to with ?into=`)
        await this.db.transaction(async () => {
            if (into) {
                await this.run('UPDATE issues SET status = ? WHERE status = ?', into, id)
                await this.run('UPDATE schedules SET place = ? WHERE place = ?', into, id)
                await this.run('UPDATE signals SET status = ? WHERE status = ?', into, id)
            }
            await this.run('DELETE FROM statuses WHERE id = ?', id)
        })
        await this.statusesChanged()
    }

    async status(id: string): Promise<IssueStatus> {
        const found = (await this.statuses()).find(s => s.id === id)
        if (!found) throw notFound(`No status "${id}"`)
        return found
    }

    /** The status an issue gets from what was sent: a status's id, a kind (its first status), or the words
     * from before statuses (`doing`; `todo` with a `plan`). */
    async resolveStatus(status: Input[string], plan?: Input[string]): Promise<string> {
        const statuses = await this.statuses()
        const first = (kind: Kind) => known(statuses.find(s => s.kind === kind), `a ${kind} status`).id
        if (plan !== undefined && (status === undefined || status === 'todo')) return first(plan ? 'todo' : 'backlog')
        if (status === undefined) return first('backlog')
        const text = String(status)
        if (statuses.some(s => s.id === text)) return text
        if (KINDS.includes(text as Kind)) return first(text as Kind)
        if (LEGACY_KINDS[text]) return first(LEGACY_KINDS[text])
        throw badRequest(`"status" is "${text}", not one of ${statuses.map(s => s.id).join(', ')} (or a kind: ${KINDS.join(', ')})`)
    }

    /** What a status filter or focus means: the status ids it covers (an id, a kind, or an old word). */
    /** The status ids a status's id or kind stands for; several, comma-separated, stand for all of theirs. */
    protected async statusIds(status: string): Promise<string[]> {
        const statuses = await this.statuses()
        const of = (one: string) => {
            if (statuses.some(s => s.id === one)) return [one]
            const kind = (KINDS.includes(one as Kind) ? one : LEGACY_KINDS[one]) as Kind | undefined
            return kind ? statuses.filter(s => s.kind === kind).map(s => s.id) : []
        }
        return [...new Set(status.split(',').map(s => s.trim()).filter(Boolean).flatMap(of))]
    }

    protected async keepOneOf(status: IssueStatus) {
        if ((await this.statuses()).filter(s => s.kind === status.kind).length === 1) throw conflict(`${status.name} is the only ${status.kind} status; add another before it goes`)
    }

    protected ownerOnly(actor: Actor, what: string) {
        if (!actor.owner) throw forbidden(`Only the owner changes the ${what}; send Orrery-Actor: <owner>`)
    }

    /** Every board is drawn again with them, and the page gets the new list with the settings. */
    protected async statusesChanged() {
        this.onSettings(await this.settings())
        for (const {id} of await this.all<{id: string}>('SELECT id FROM projects')) this.changed(id)
    }

    /** The owner's to change: they're how the Orrery looks to them. */
    async updateSettings(body: unknown, actor = AGENT): Promise<Settings> {
        if (!actor.owner) throw forbidden("Only the owner changes the Orrery's settings; send Orrery-Actor: <owner>")
        const input = checkInput(body, SETTINGS_FIELDS, true)
        await this.db.transaction(async () => {
            for (const [key, sent] of Object.entries(input)) {
                if (sent === undefined) continue
                // An empty template is none: the default.
                const value = (key === 'focus_prompt' || key === 'chunk_prompt') && typeof sent === 'string' ? sent.trim() || null
                    : key === 'handle' && typeof sent === 'string' ? sent.toLowerCase()
                    // Checked and given back as JSON text: kept as the value it stands for.
                    : key === 'starts' && typeof sent === 'string' ? JSON.parse(sent) as unknown : sent
                await this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
            }
        })
        const settings = await this.settings()
        this.onSettings(settings)
        // Every project says whether Orrery starts its sessions.
        if (input.starts !== undefined) for (const {id} of await this.all<{id: string}>('SELECT id FROM projects')) this.changed(id)
        return settings
    }
}
