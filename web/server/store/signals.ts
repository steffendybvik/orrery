// Signals to sessions (a focus, a comment, a message) and the uploads they carry.
import {randomBytes} from 'node:crypto'
import type {Asks, Kind, SessionWork, Signal, Upload} from '#shared/roadmap'
import {CLOSED} from '#shared/roadmap'
import {badRequest, checkInput, conflict, forbidden, notFound} from '../utils/input'
import type {Actor, SignalRow} from './schema'
import {AGENT, SIGNAL_FIELDS, CHUNK_SIGNAL_FIELDS, LEGACY_KINDS, UPLOAD_FIELDS, UPLOAD_LIMIT, IMAGE_TYPES, signalOf, nullable, stamp} from './schema'
import {IssueStore} from './issues'

export abstract class SignalStore extends IssueStore {
    /** `Store` has it, with the claims on issues. */
    abstract workedBy(project: string, issue: string, session: string): Promise<void>

    /** Asks the sessions on the project to focus on the issue (`{note?}` says what for). */
    /** Keeps an image for Markdown to show: `{data, name?}` → where it's served and the Markdown that shows it. */
    async createUpload(body: unknown, actor = AGENT): Promise<Upload> {
        const input = checkInput(body, UPLOAD_FIELDS)
        const base64 = String(input.data).replace(/^data:[^,]*;base64,/, '')
        if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(base64)) throw badRequest('"data" should be the image in base64')
        const bytes = Buffer.from(base64, 'base64')
        if (!bytes.length) throw badRequest('"data" is empty')
        if (bytes.length > UPLOAD_LIMIT) throw badRequest(`The image is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; ${UPLOAD_LIMIT / 1024 / 1024} MB at most`)
        const type = IMAGE_TYPES.find(([, test]) => test(bytes))?.[0]
        if (!type) throw badRequest('That isn\'t a PNG, JPEG, GIF or WebP image')
        const name = input.name ? String(input.name).trim().slice(0, 200) || null : null
        const id = randomBytes(12).toString('hex')
        await this.run('INSERT INTO uploads (id, type, name, size, data, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            id, type, name, bytes.length, bytes, actor.name, Number(actor.owner), stamp())
        const url = `/api/uploads/${id}`
        // Brackets would end the alt text early.
        const alt = (name ?? 'image').replace(/\.[a-z0-9]+$/i, '').replace(/[[\]\\]/g, '')
        return {id, type, size: bytes.length, url, markdown: `![${alt}](${url})`}
    }

    /** An image's bytes and type, as kept. */
    async upload(id: string): Promise<{type: string, data: Buffer}> {
        const row = /^[0-9a-f]{24}$/.test(id) ? await this.get<{type: string, data: Uint8Array}>('SELECT type, data FROM uploads WHERE id = ?', id) : undefined
        if (!row) throw notFound(`No image ${id}`)
        return {type: row.type, data: Buffer.from(row.data)}
    }

    async focus(project: string, issue: string, body: unknown, actor = AGENT): Promise<Signal> {
        issue = await this.issueId(project, issue)
        await this.issueRow(project, issue)
        return await this.sendFocus(project, issue, body, actor)
    }

    /** `focus` for an issue id already resolved and checked. */
    protected async sendFocus(project: string, issue: string, body: unknown, actor: Actor): Promise<Signal> {
        const input = checkInput(body ?? {}, SIGNAL_FIELDS)
        const instructions = JSON.stringify(await this.instructionsFor(project, input.instructions))
        const row = await this.get<SignalRow>('INSERT INTO signals (project, issue, kind, note, target, instructions, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
            project, issue, 'focus', nullable(input.note), nullable(input.session), instructions, actor.name, Number(actor.owner), stamp())
        const signal = signalOf(row!)
        // A started issue another session is still on stays its: the one asked gets the claim's 409 if it starts it.
        if (signal.target && !await this.heldElsewhere(project, issue, signal.target)) await this.workedBy(project, issue, signal.target)
        this.onSignal(signal)
        return signal
    }

    /** Whether a session other than `session` has the issue started and is there to hear. */
    private async heldElsewhere(project: string, issue: string, session: string): Promise<boolean> {
        const worker = await this.listeningWorker(project, issue)
        if (!worker || worker === session) return false
        const status = (await this.issueRow(project, issue)).status
        return (await this.statuses()).find(s => s.id === status)?.kind === 'started'
    }

    /** Asks the sessions (or `session`) to work through the chunk's open issues now, or (`status`) its issues of
     * those statuses, or (`release`) those set for a release; `none` is the issues in no chunk, `all` every chunk's. */
    async focusChunk(project: string, chunk: string, body: unknown, actor = AGENT): Promise<Signal> {
        await this.projectRow(project)
        if (chunk !== 'none' && chunk !== 'all') {
            chunk = await this.chunkId(project, chunk)
            await this.chunkRow(project, chunk)
        }
        const input = checkInput(body ?? {}, CHUNK_SIGNAL_FIELDS)
        let status: string | null = null
        if (input.status) {
            const all = await this.statuses()
            const words = String(input.status).split(',').map(s => s.trim())
            for (const one of words) {
                const ids = await this.statusIds(one)
                const statuses = all.filter(s => ids.includes(s.id))
                if (!statuses.length || statuses.some(s => CLOSED.includes(s.kind))) {
                    throw badRequest(`"status" has "${one}", not an open status (${all.filter(s => !CLOSED.includes(s.kind)).map(s => s.id).join(', ')}) or kind (backlog, todo, started)`)
                }
            }
            // An old word (`doing`) is kept as the kind it means now, which is what the scope matches.
            status = words.map(one => all.some(s => s.id === one) ? one : LEGACY_KINDS[one] ?? one).join(',')
        }
        const release = input.release ? (await this.releaseRow(project, String(input.release))).version : null
        const instructions = JSON.stringify(await this.instructionsFor(project, input.instructions))
        const row = await this.get<SignalRow>('INSERT INTO signals (project, chunk, status, release, kind, note, target, instructions, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
            project, chunk, status, release, 'focus', nullable(input.note), nullable(input.session), instructions, actor.name, Number(actor.owner), stamp())
        const signal = signalOf(row!)
        this.onSignal(signal)
        return signal
    }

    /** The id of the project's latest signal, 0 before its first. */
    async lastSignal(project: string): Promise<number> {
        await this.projectRow(project)
        return Number((await this.get<{id: number | null}>('SELECT MAX(id) AS id FROM signals WHERE project = ?', project))?.id ?? 0)
    }

    /** The project's signals after `after` (an id), oldest first; or the latest ones about an issue or a chunk. */
    async listSignals(project: string, after = 0, limit = 50, about?: {issue?: string, chunk?: string}): Promise<Signal[]> {
        await this.projectRow(project)
        if (about?.issue || about?.chunk) {
            const [column, id] = about.issue ? ['issue', await this.issueId(project, about.issue)] : ['chunk', await this.chunkId(project, about.chunk!)]
            return (await this.all<SignalRow>(`SELECT * FROM signals WHERE project = ? AND ${column} = ? ORDER BY id DESC LIMIT ?`, project, id, limit))
                .reverse().map(signalOf)
        }
        return (await this.all<SignalRow>('SELECT * FROM signals WHERE project = ? AND id > ? ORDER BY id LIMIT ?', project, after, limit)).map(signalOf)
    }

    /** What each of the project's sessions is on, for its Sessions page: the open issues it worked last (newest
     * first), and the last `signals` signals that went to it, by its id or, sent to every session, by its name.
     * `ids` are every id a session has gone by (it gets a new one on a `/clear`), its own when left out. */
    async sessionWork(project: string, sessions: {id: string, name: string, ids?: string[]}[], signals = 5): Promise<Record<string, SessionWork>> {
        await this.projectRow(project)
        const open = new Map((await this.listIssues(project)).filter(i => i.kind !== 'proposed' && !CLOSED.includes(i.kind as Kind)).map(i => [i.id, i]))
        const worked = await this.all<{issue: string, session: string}>('SELECT issue, session FROM issue_sessions WHERE project = ? ORDER BY at DESC', project)
        const recent = (await this.all<SignalRow>('SELECT * FROM signals WHERE project = ? ORDER BY id DESC LIMIT 200', project)).map(signalOf)
        return Object.fromEntries(sessions.map(session => {
            const ids = session.ids ?? [session.id]
            const issues = new Set(worked.filter(w => ids.includes(w.session) && open.has(w.issue)).map(w => w.issue))
            return [session.id, {
                issues: [...issues].map(issue => open.get(issue)!).map(({id, title, column, kind, priority}) => ({id, title, column, kind, priority})),
                signals: recent.filter(s => (s.target && ids.includes(s.target)) || (!s.target && s.delivered_to.includes(session.name))).slice(0, signals),
            }]
        }))
    }

    /** Sends a schedule's message to the project's sessions: about no issue, as the schedule's maker. */
    async message(project: string, schedule: number, text: string, actor = AGENT): Promise<Signal> {
        await this.projectRow(project)
        const row = await this.get<SignalRow>('INSERT INTO signals (project, schedule, kind, note, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
            project, schedule, 'message', text, actor.name, Number(actor.owner), stamp())
        const signal = signalOf(row!)
        this.onSignal(signal)
        return signal
    }

    /** The owner's own words to one session, through its channel: about no issue, from no schedule. */
    async messageSession(project: string, session: string, text: unknown, actor = AGENT): Promise<Signal> {
        if (!actor.owner) throw forbidden('Only the owner messages a session; send Orrery-Actor: <owner>')
        await this.projectRow(project)
        const note = typeof text === 'string' ? text.trim() : ''
        if (!note) throw badRequest('Send the message as {"text": "…"}')
        const row = await this.get<SignalRow>('INSERT INTO signals (project, kind, note, target, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
            project, 'message', note, session, actor.name, 1, stamp())
        const signal = signalOf(row!)
        this.onSignal(signal)
        return signal
    }

    /** Whether a signal of the owner's waits to reach the session (any of its `ids`), for it or for every session. */
    async waiting(project: string, ids: string[]): Promise<boolean> {
        return !!await this.get(`SELECT 1 FROM signals WHERE project = ? AND owned = 1 AND delivered_to = '[]'
            AND (target IS NULL OR target IN (${ids.map(() => '?').join(', ')})) LIMIT 1`, project, ...ids)
    }

    /** The owner's scheduled asks and messages from the last day that no session has heard yet: the next
     * one to connect gets them. */
    async unheardScheduled(project: string): Promise<Signal[]> {
        const since = new Date(Date.now() - 86_400_000).toISOString()
        return (await this.all<SignalRow>(`
            SELECT s.* FROM signals s LEFT JOIN issues i ON i.project = s.project AND i.id = s.issue
            WHERE s.project = ? AND s.owned = 1 AND s.delivered_to = '[]' AND s.created_at >= ?
              AND ((s.kind = 'focus' AND i.schedule IS NOT NULL AND i.status NOT IN (SELECT id FROM statuses WHERE kind IN ('done', 'canceled'))) OR s.kind = 'message')
            ORDER BY s.id`, project, since)).map(signalOf)
    }

    /** Notes that a session got the signal. Two sessions saying so at once both count: the list is only written
     * over if it's still the one read, else read again. */
    async delivered(project: string, id: number, to: string): Promise<Signal> {
        let row: SignalRow | undefined
        let names: string[] = []
        for (let tries = 0; ; tries++) {
            row = await this.get<SignalRow>('SELECT * FROM signals WHERE project = ? AND id = ?', project, id)
            if (!row) throw notFound(`No signal ${id} in ${project}`)
            names = [...new Set([...JSON.parse(row.delivered_to) as string[], to])]
            const {changes} = await this.run('UPDATE signals SET delivered_to = ? WHERE id = ? AND delivered_to = ?', JSON.stringify(names), id, row.delivered_to)
            if (changes) break
            // Lost every race: say so, rather than a receipt that wasn't kept.
            if (tries === 9) throw conflict(`Signal ${id} is being marked by too many sessions at once; try again`)
        }
        const signal = signalOf({...row, delivered_to: JSON.stringify(names)})
        this.onSignal(signal)
        return signal
    }
}
