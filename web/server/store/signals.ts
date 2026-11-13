// Signals to sessions (a focus, a comment, a message) and the uploads they carry.
import {randomBytes} from 'node:crypto'
import type {Kind, SessionWork, Signal, Upload} from '#shared/roadmap'
import {CLOSED, heaviest, modelFor} from '#shared/roadmap'
import {badRequest, checkInput, conflict, notFound} from '../utils/input'
import type {Actor, IssueRecord, SignalRow} from './schema'
import {AGENT, SIGNAL_FIELDS, MILESTONE_SIGNAL_FIELDS, LEGACY_KINDS, UPLOAD_FIELDS, UPLOAD_LIMIT, IMAGE_TYPES, ORRERY, signalOf, nullable, stamp} from './schema'
import {IssueStore} from './issues'
import {sessionWork} from './session-work'
import {EVERY} from '../utils/pool'
import {compressImage} from '../utils/compress'
import {known} from '#shared/known'
import {ownerOnly} from '../utils/permission'

/** How long a signal is kept (ORR-778). What it's for is over within a day; the rest is the Sessions page's history. */
export const KEEP_SIGNALS = 30 * 86_400_000
/** How long an image nothing refers to is kept: long enough for one in a draft to be saved (ORR-778). */
const KEEP_UNUSED_UPLOADS = 90 * 86_400_000
const UPLOAD_LINK = /\/api\/uploads\/([0-9a-f]{24})/g

/** A signal's row as it's written: what it's about, its target already picked, and who it's from. */
export interface SignalFields {
    kind: 'focus' | 'comment' | 'message'
    created_by: string
    owned: boolean
    issue?: string | null
    milestone?: string | null
    status?: string | null
    release?: string | null
    epic?: number | null
    schedule?: number | null
    note?: string | null
    preset?: string | null
    via?: string | null
    target?: string | null
    person?: string | null
    instructions?: string[]
    model?: string | null
}

export abstract class SignalStore extends IssueStore {
    /** A signal write sent to the Rust API when it's in front, as it's the `signals` table's one writer then (ORR-1090):
     * its reply, or undefined with no API set up, which leaves the write to the store here. Imported when used, as the
     * router reads the store. */
    private async signalsApi<T>(method: string, path: string, body: unknown): Promise<T | undefined> {
        const {writeToApi} = await import('../utils/api-router')
        return (await writeToApi(method, path, body, ORRERY, {always: true}))?.reply as T | undefined
    }

    /** Writes a signal whose target is picked (`POST …/signals`), and tells the sessions of it here, as they're this
     * machine's. */
    protected async writeSignal(project: string, fields: SignalFields): Promise<Signal> {
        const sent = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null))
        const signal = await this.signalsApi<Signal>('POST', `/api/projects/${encodeURIComponent(project)}/signals`, sent) ?? await this.writeSignalHere(project, fields)
        this.signalled(signal)
        return signal
    }

    private async writeSignalHere(project: string, fields: SignalFields): Promise<Signal> {
        const {instructions, owned, ...rest} = fields
        type Value = string | number | null
        const columns: [string, Value][] = [['project', project]]
        for (const [name, value] of Object.entries(rest) as [string, Value | undefined][]) if (value !== undefined) columns.push([name, value])
        if (instructions) columns.push(['instructions', JSON.stringify(instructions)])
        columns.push(['owned', Number(owned)], ['created_at', stamp()])
        return signalOf(await this.one<SignalRow>(`INSERT INTO signals (${columns.map(([name]) => name).join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING *`,
            ...columns.map(([, value]) => value)))
    }

    /** Keeps an image for Markdown to show: `{data, name?}` → where it's served and the Markdown that shows it. A PNG or
     * JPEG is kept as WebP when that's smaller (see compress.ts). */
    async createUpload(body: unknown, actor = AGENT): Promise<Upload> {
        const input = checkInput(body, UPLOAD_FIELDS)
        const base64 = String(input.data).replace(/^data:[^,]*;base64,/, '')
        if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(base64)) throw badRequest('"data" should be the image in base64')
        const bytes = Buffer.from(base64, 'base64')
        if (!bytes.length) throw badRequest('"data" is empty')
        if (bytes.length > UPLOAD_LIMIT) throw badRequest(`The image is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; ${UPLOAD_LIMIT / 1024 / 1024} MB at most`)
        const came = IMAGE_TYPES.find(([, test]) => test(bytes))?.[0]
        if (!came) throw badRequest('That isn\'t a PNG, JPEG, GIF or WebP image')
        const {type, data} = await compressImage(bytes, came)
        const name = input.name ? String(input.name).trim().slice(0, 200) || null : null
        const id = randomBytes(12).toString('hex')
        await this.run('INSERT INTO uploads (id, type, name, size, data, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            id, type, name, data.length, data, actor.name, Number(actor.owner), stamp())
        const url = `/api/uploads/${id}`
        // Brackets would end the alt text early.
        const alt = (name ?? 'image').replace(/\.[a-z0-9]+$/i, '').replace(/[[\]\\]/g, '')
        return {id, type, size: data.length, url, markdown: `![${alt}](${url})`}
    }

    /** Keeps the PNGs and JPEGs uploaded before images were compressed as WebP where that's smaller, in place (their
     * ids and links stay), once: `settings.uploads_compressed` says it's done. Says how many and the bytes saved. */
    async compressUploads(): Promise<{images: number, saved: number} | null> {
        if (await this.get("SELECT 1 FROM settings WHERE key = 'uploads_compressed'")) return null
        let images = 0
        let saved = 0
        const ids = await this.all<{id: string}>("SELECT id FROM uploads WHERE type IN ('image/png', 'image/jpeg') ORDER BY created_at")
        for (const {id} of ids) {
            // One at a time, so a big database's images aren't all held at once.
            const row = await this.get<{type: string, data: Uint8Array}>('SELECT type, data FROM uploads WHERE id = ?', id)
            if (!row) continue
            const before = Buffer.from(row.data)
            const after = await compressImage(before, row.type)
            if (after.data === before) continue
            await this.run('UPDATE uploads SET type = ?, size = ?, data = ? WHERE id = ?', after.type, after.data.length, after.data, id)
            images++
            saved += before.length - after.data.length
        }
        await this.run("INSERT INTO settings (key, value) VALUES ('uploads_compressed', ?) ON CONFLICT (key) DO NOTHING", JSON.stringify(new Date().toISOString()))
        return {images, saved}
    }

    /** An image's bytes and type, as kept. */
    async upload(id: string): Promise<{type: string, data: Buffer}> {
        const row = /^[0-9a-f]{24}$/.test(id) ? await this.get<{type: string, data: Uint8Array}>('SELECT type, data FROM uploads WHERE id = ?', id) : undefined
        if (!row) throw notFound(`No image ${id}`)
        return {type: row.type, data: Buffer.from(row.data)}
    }

    /** Asks the sessions on the project to focus on the issue (`{note?}` says what for). */
    async focus(project: string, issue: string, body: unknown, actor = AGENT): Promise<Signal> {
        issue = await this.issueId(project, issue)
        await this.pointAt(project, issue, await this.issueRow(project, issue), actor)
        return await this.sendFocus(project, issue, body, actor)
    }

    /** With people, pointing a session at an issue says whose it is (ORR-655): a person's own stays theirs, and an
     * unassigned one becomes theirs. Someone else's is refused, unless it's the owner taking it over, which shows in the
     * activity. An agent can't assign itself in this way. */
    private async pointAt(project: string, issue: string, row: {assignee: string | null}, actor: Actor) {
        if (!actor.asked || actor.chat || !await this.isShared()) return
        const holder = await this.holderOf(row.assignee)
        const rails = await this.railsFor(actor)
        if (rails && (!rails.person || rails.person !== actor.name.toLowerCase())) return await this.mustHold(rails, issue, row.assignee, 'focus a session on it')
        const person = rails?.person ?? await this.ownerId()
        if (holder === person) return
        if (holder && rails) await this.mustHold(rails, issue, row.assignee, 'focus a session on it')
        await this.update('issues', 'project = ? AND id = ?', [project, issue], {assignee: person, claimed_by: null, claimed_at: null, claimed_session: null})
        await this.record(project, issue, actor, [['assignee', row.assignee, person]])
        this.changed(project)
    }

    /** `focus` for an issue id already resolved and checked. Aimed at no session, it goes to the one already on the
     * issue if that one is listening, else to the one on an issue above it (ORR-613: a follow-up is its to start), else
     * to one orrery picks (pool.ts). Only a milestone can go to every session (ORR-681). */
    protected async sendFocus(project: string, issue: string, body: unknown, actor: Actor): Promise<Signal> {
        const input = checkInput(body ?? {}, SIGNAL_FIELDS)
        if (input.session === EVERY) throw badRequest(`Only a milestone can go to every session, not issue ${issue}: name one in "session", or leave it out for orrery to pick one`)
        const instructions = await this.instructionsFor(project, input.instructions)
        const member = this.memberAiming(actor, input.session)
        // The owner's goes to the sessions of whoever has the issue, and on what's nobody's, to their own (ORR-656).
        const whose = member ?? (actor.owner ? await this.whoseWork(project, (await this.issueRow(project, issue)).assignee) ?? (await this.isShared() ? await this.ownerId() : undefined) : undefined)
        const named = input.session && input.session !== EVERY ? this.sessionPerson(String(input.session)) : undefined
        if (!member && whose && named && named !== whose) throw conflict(`${issue} is ${whose}'s, and session ${String(input.session)} is ${named}'s, so it can't be sent this: assign the issue to them first`)
        const theirs = (session: string | null | undefined) => {
            if (!session) return null
            const person = this.sessionPerson(session)
            return !whose || person === whose || !member && !person ? session : null
        }
        const target = nullable(input.session) ?? theirs(await this.listeningWorker(project, issue)) ?? theirs((await this.heldAbove(project, issue))?.holder) ?? null
        const signal = await this.writeSignal(project, {issue, kind: 'focus', note: nullable(input.note), target, person: whose ?? null, instructions,
            model: await this.modelNeeded(project, issue), created_by: actor.name, owned: actor.owner})
        // A started issue another session is still on stays its: the one asked gets the claim's 409 if it starts it.
        if (signal.target && signal.target !== EVERY && !await this.takenFrom(project, issue, signal.target)) await this.workedBy(project, issue, signal.target)
        return signal
    }

    /** The model a signal about the issue needs (ORR-868): its own, else what its kind starts a session on. No session on a lighter
     * one takes it from the pool (pool.ts). */
    protected async modelNeeded(project: string, issue: string): Promise<string> {
        const {labels, model, effort} = await this.issueFacts(project, issue)
        return modelFor({labels, model, effort}, await this.workKinds()).model ?? 'best'
    }

    /** The heaviest model a milestone's open issues need (`all`: every milestone's, `none`: those in none), as a session working
     * through them may come to any; none when it has no open issues. With `epic`, only those in it. */
    private async milestoneModelNeeded(project: string, milestone: string, epic: number | null = null): Promise<string | null> {
        const issues = await this.listIssues(project, milestone === 'all' ? {} : {milestone})
        const open = (epic === null ? issues : await this.inEpic(project, issues, epic)).filter(i => !CLOSED.includes(i.kind as Kind))
        const kinds = await this.workKinds()
        return open.length ? heaviest(open.map(i => modelFor(i, kinds))).model ?? 'best' : null
    }

    /** The member behind a signal, if one is (ORR-658): it goes only to their own sessions, so naming someone else's is
     * refused rather than sent nowhere. */
    private memberAiming(actor: Actor, session: unknown): string | undefined {
        const member = actor.owner ? undefined : actor.person
        if (member && session && session !== EVERY && this.sessionPerson(String(session)) !== member) throw conflict(`Session ${String(session)} isn't ${member}'s, so it can't be sent this: comment on the issue instead`)
        return member
    }

    /** Asks the sessions (or `session`) to work through the milestone's open issues now, or (`status`) its issues of
     * those statuses, or (`release`) those set for a release; `none` is the issues in no milestone, `all` every milestone's. */
    async focusMilestone(project: string, milestone: string, body: unknown, actor = AGENT): Promise<Signal> {
        await this.projectRow(project)
        if (milestone !== 'none' && milestone !== 'all') {
            milestone = await this.milestoneId(project, milestone)
            await this.milestoneRow(project, milestone)
        }
        const input = checkInput(body ?? {}, MILESTONE_SIGNAL_FIELDS)
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
        const epic = input.epic === undefined || input.epic === null ? null : (await this.epicRow(input.epic as string)).id
        const instructions = await this.instructionsFor(project, input.instructions)
        return await this.writeSignal(project, {milestone, status, release, epic, kind: 'focus', note: nullable(input.note), target: nullable(input.session),
            person: this.memberAiming(actor, input.session) ?? null, instructions, model: await this.milestoneModelNeeded(project, milestone, epic), created_by: actor.name, owned: actor.owner})
    }

    /** Asks the sessions to work through an epic's open issues (ORR-987): a focus on each project it has open issues in,
     * as a milestone's over the whole project (`all`) narrowed to the epic, so each goes to that project's sessions (one
     * orrery picks, or `*`) and starts one there as any owner's focus does. `{note?, status?, instructions?}` go to each.
     * A named session (ORR-958) gets a focus for each of those projects it hears, and none for the others; one that
     * hears none of them is refused, as nothing would reach it. With a status, only the projects with an open issue of
     * it in the epic hear it, so no session is asked to work through nothing. */
    async focusEpic(id: number, body: unknown, actor = AGENT): Promise<Signal[]> {
        const epic = await this.epicRow(id)
        const input = checkInput(body ?? {}, MILESTONE_SIGNAL_FIELDS)
        if (input.release !== undefined && input.release !== null) throw badRequest("An epic's focus can't name a release: a release is one project's")
        const named = typeof input.session === 'string' && input.session && input.session !== EVERY ? input.session : undefined
        const projects = (await this.all<{project: string}>('SELECT DISTINCT project FROM issues WHERE epic = ? ORDER BY project', epic.id)).map(r => r.project)
        // Narrowed to a status (ORR-958), only the projects with an open issue of it in the epic: by its status, or kind.
        const words = input.status ? String(input.status).split(',').map(w => w.trim()).map(w => LEGACY_KINDS[w] ?? w) : undefined
        const open: string[] = []
        for (const project of projects) {
            // Only where it has open work: a project whose part is done hears nothing.
            if ((await this.inEpic(project, await this.listIssues(project), epic.id)).some(i => i.kind !== 'proposed' && !CLOSED.includes(i.kind as Kind)
                && (!words || words.includes(i.column) || words.includes(i.kind)))) open.push(project)
        }
        const to = named ? open.filter(project => this.hears(project, named)) : open
        if (named && open.length && !to.length) throw badRequest(`Session ${named} hears none of the projects the epic has open issues in (${open.join(', ')})`)
        const signals: Signal[] = []
        for (const project of to) signals.push(await this.focusMilestone(project, 'all', {...input, epic: epic.id}, actor))
        return signals
    }

    /** Of `issues` (one project's), those in the epic: set for it, or under one that is. */
    private async inEpic(project: string, issues: IssueRecord[], epic: number): Promise<IssueRecord[]> {
        const rows = await this.all<{id: string, parent: string | null, epic: number | null}>('SELECT id, parent, epic FROM issues WHERE project = ?', project)
        const byId = new Map(rows.map(r => [r.id, r]))
        const inIt = (id: string | null | undefined, depth = 0): boolean => {
            const row = id ? byId.get(id) : undefined
            if (!row || depth > 50) return false
            return row.epic === null || row.epic === undefined ? inIt(row.parent, depth + 1) : Number(row.epic) === epic
        }
        return issues.filter(i => inIt(i.id))
    }

    /** Lets go of signals past KEEP_SIGNALS, heard or not (ORR-778). Nothing they answer for reaches back that far: what
     * waits on one looks a day back, and `carryUnanswered` no further than this. */
    async pruneSignals(now = Date.now()): Promise<number> {
        const sent = await this.signalsApi<{pruned: number}>('POST', '/api/signals/prune', {})
        if (sent) return sent.pruned
        return (await this.run('DELETE FROM signals WHERE created_at < ?', new Date(now - KEEP_SIGNALS).toISOString())).changes
    }

    /** Removes images past KEEP_UNUSED_UPLOADS that nothing refers to (ORR-778). What refers to one is any text in any
     * table, a new column included, so a place to keep Markdown can't be missed; a failed look removes nothing. Once its
     * backups age out, a removed image is gone. */
    async sweepUploads(now = Date.now()): Promise<{uploads: number, bytes: number}> {
        const before = new Date(now - KEEP_UNUSED_UPLOADS).toISOString()
        return await this.db.transaction(async () => {
            const old = await this.all<{id: string, size: number}>('SELECT id, size FROM uploads WHERE created_at < ?', before)
            if (!old.length) return {uploads: 0, bytes: 0}
            const used = await this.uploadsReferred()
            const unused = old.filter(upload => !used.has(upload.id))
            for (const {id} of unused) await this.run('DELETE FROM uploads WHERE id = ?', id)
            return {uploads: unused.length, bytes: unused.reduce((sum, upload) => sum + Number(upload.size), 0)}
        })
    }

    /** The ids of the images any text in the database links to. */
    private async uploadsReferred(): Promise<Set<string>> {
        const columns = await this.all<{tbl: string, col: string}>(this.db.dialect === 'postgres'
            ? `SELECT table_name AS tbl, column_name AS col FROM information_schema.columns
               WHERE table_schema = current_schema() AND data_type IN ('text', 'character varying', 'json', 'jsonb')`
            : `SELECT m.name AS tbl, c.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) c
               WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND upper(c.type) NOT IN ('BLOB', 'INTEGER', 'REAL')`)
        const texts = columns.filter(({tbl}) => tbl !== 'uploads')
        if (!texts.some(({tbl, col}) => tbl === 'comments' && col === 'body')) throw new Error("Couldn't read which columns hold text")
        const used = new Set<string>()
        for (const {tbl, col} of texts) {
            const rows = await this.all<{text: string}>(`SELECT CAST("${col}" AS TEXT) AS text FROM "${tbl}" WHERE CAST("${col}" AS TEXT) LIKE ?`, '%/api/uploads/%')
            for (const {text} of rows) for (const [, id] of text.matchAll(UPLOAD_LINK)) used.add(id as string)
        }
        return used
    }

    /** The id of the project's latest signal, 0 before its first. */
    async lastSignal(project: string): Promise<number> {
        // Asked of the API when it's set up (ORR-1133), so this server reads none of it from the database.
        const {readFromApi} = await import('../utils/api-router')
        const read = await readFromApi<{id: number}>(`/api/projects/${encodeURIComponent(project)}/signals/last`)
        if (read) return read.id
        await this.projectRow(project)
        return Number((await this.get<{id: number | null}>('SELECT MAX(id) AS id FROM signals WHERE project = ?', project))?.id ?? 0)
    }

    /** The project's signals after `after` (an id), oldest first; or the latest ones about an issue or a milestone. */
    async listSignals(project: string, after = 0, limit = 50, about?: {issue?: string, milestone?: string}): Promise<Signal[]> {
        await this.projectRow(project)
        const which = about?.issue ? ['issue', await this.issueId(project, about.issue)] as const : about?.milestone ? ['milestone', await this.milestoneId(project, about.milestone)] as const : undefined
        if (which) {
            const [column, id] = which
            return (await this.all<SignalRow>(`SELECT * FROM signals WHERE project = ? AND ${column} = ? ORDER BY id DESC LIMIT ?`, project, id, limit))
                .reverse().map(signalOf)
        }
        return (await this.all<SignalRow>('SELECT * FROM signals WHERE project = ? AND id > ? ORDER BY id LIMIT ?', project, after, limit)).map(signalOf)
    }

    /** What each of the project's sessions is on, for its Sessions page: the open issues it worked last (newest
     * first, each with when it took it), and the last `signals` signals that went to it, by its id or, sent to every session, by its name.
     * `ids` are every id a session has gone by (it gets a new one on a `/clear`), its own when left out. */
    async sessionWork(project: string, sessions: {id: string, name: string, ids?: string[]}[], signals = 5): Promise<Record<string, SessionWork>> {
        // From the API when it's set up (ORR-1174), which only this server can ask, as only it knows the sessions: the
        // Sessions page asks for every project's, and reading them here was most of what this server still read.
        if (signals === 5) {
            const asked = JSON.stringify(sessions.map(({id, name, ids}) => ({id, name, ...ids ? {ids} : {}})))
            const read = await this.fromApi<Record<string, SessionWork>>(`/api/projects/${encodeURIComponent(project)}/session-work?sessions=${encodeURIComponent(asked)}`)
            if (read) return read
        }
        await this.projectRow(project)
        const open = new Map((await this.listIssues(project)).filter(i => i.kind !== 'proposed' && !CLOSED.includes(i.kind as Kind)).map(i => [i.id, i]))
        const worked = await this.all<{issue: string, session: string, since: string | null}>('SELECT issue, session, since FROM issue_sessions WHERE project = ? ORDER BY at DESC', project)
        const recent = (await this.all<SignalRow>('SELECT * FROM signals WHERE project = ? ORDER BY id DESC LIMIT 200', project)).map(signalOf)
        return Object.fromEntries(sessions.map(session => {
            const ids = session.ids ?? [session.id]
            const mine = worked.filter(w => ids.includes(w.session) && open.has(w.issue))
            return [session.id, {
                issues: mine.flatMap(({issue, since}) => {
                    const found = open.get(issue)
                    return found ? [{id: found.id, title: found.title, column: found.column, kind: found.kind, priority: found.priority, ...since ? {since} : {}}] : []
                }),
                signals: recent.filter(s => ids.includes(s.target ?? '') || ((!s.target || s.target === EVERY) && s.delivered_to.includes(session.name))).slice(0, signals),
            }]
        }))
    }

    /** Sends a schedule's message to the project's sessions, or to one (`target`): about no issue, as the schedule's maker.
     * With the schedule's own `model` (ORR-869), no session on a lighter one takes it. */
    async message(project: string, schedule: number, text: string, actor = AGENT, target?: string, preset?: string, model?: string): Promise<Signal> {
        await this.projectRow(project)
        return await this.writeSignal(project, {schedule, kind: 'message', note: text, preset: preset ?? null, target: target ?? null,
            model: model && model !== 'best' ? model : null, created_by: actor.name, owned: actor.owner})
    }

    /** The owner's own words to one session, through its channel: about no issue, from no schedule; their chat's for
     * them when the actor says it's `via` it. With `preset`
     * (an id its sessions can have), they're that preset's text as the owner sent it, tweaked or not, and the
     * message is labelled by its name. */
    async messageSession(project: string, session: string, text: unknown, actor = AGENT, preset?: unknown): Promise<Signal> {
        ownerOnly(actor, 'sessions.message')
        await this.projectRow(project)
        const note = typeof text === 'string' ? text.trim() : ''
        if (!note) throw badRequest('Send the message as {"text": "…"}')
        if (preset !== undefined && preset !== null && !Number.isInteger(preset)) throw badRequest('Send preset as a preset\'s id')
        const from = typeof preset === 'number' ? known((await this.presetsFor(project, [preset]))[0], 'the preset').name : null
        return await this.writeSignal(project, {kind: 'message', note, preset: from, via: actor.via ?? null, target: session, created_by: actor.name, owned: true})
    }

    /** Whether the owner sent this session something of its own (by one of its ids) that it hasn't heard yet. */
    async waitingFor(project: string, ids: string[]): Promise<boolean> {
        const read = await sessionWork.of(project, ids)
        if (read) return read.waiting_for
        return !!await this.get(`SELECT 1 FROM signals WHERE project = ? AND owned = 1 AND delivered_to = '[]'
            AND target IN (${ids.map(() => '?').join(', ')}) LIMIT 1`, project, ...ids)
    }

    /** Whether a signal of the owner's waits to reach the session (any of its `ids`), for it, for every session or
     * for the one orrery picks. */
    async waiting(project: string, ids: string[]): Promise<boolean> {
        const read = await sessionWork.of(project, ids)
        if (read) return read.waiting
        return !!await this.get(`SELECT 1 FROM signals WHERE project = ? AND owned = 1 AND delivered_to = '[]'
            AND (target IS NULL OR target = ? OR target IN (${ids.map(() => '?').join(', ')})) LIMIT 1`, project, EVERY, ...ids)
    }

    /** Whether an owner's focus on the issue from the last ten minutes hasn't been heard yet (Focus on this, a P0's push):
     * it's on its way, so another isn't sent (ORR-515). */
    async focusOnItsWay(project: string, issue: string): Promise<boolean> {
        const read = await sessionWork.focusing(project, issue)
        if (read) return read.length > 0
        const since = new Date(Date.now() - 600_000).toISOString()
        return !!await this.get(`SELECT 1 FROM signals WHERE project = ? AND issue = ? AND kind = 'focus' AND (owned = 1 OR person IS NOT NULL)
            AND delivered_to = '[]' AND created_at >= ? LIMIT 1`, project, issue, since)
    }

    /** The owner's and members' signals from the last day for one session orrery picks (pool.ts) that none has heard
     * yet: the next session to go idle that may hear them takes them. */
    async pooledWaiting(project: string): Promise<Signal[]> {
        const read = await sessionWork.unheard(project, 'pooled')
        if (read) return read
        const since = new Date(Date.now() - 86_400_000).toISOString()
        return (await this.all<SignalRow>(`SELECT * FROM signals WHERE project = ? AND (owned = 1 OR person IS NOT NULL) AND delivered_to = '[]'
            AND target IS NULL AND created_at >= ? ORDER BY id`, project, since)).map(signalOf)
    }

    /** The owner's scheduled asks and messages from the last day that no session has heard yet: the next
     * one to connect gets them. */
    async unheardScheduled(project: string): Promise<Signal[]> {
        const read = await sessionWork.unheard(project, 'scheduled')
        if (read) return read
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
        const signal = await this.signalsApi<Signal>('POST', `/api/projects/${encodeURIComponent(project)}/signals/${id}/receipts`, {to}) ?? await this.deliveredHere(project, id, to)
        this.signalled(signal)
        return signal
    }

    private async deliveredHere(project: string, id: number, to: string): Promise<Signal> {
        let row: SignalRow | undefined
        let names: string[]
        for (let tries = 0; ; tries++) {
            row = await this.get<SignalRow>('SELECT * FROM signals WHERE project = ? AND id = ?', project, id)
            if (!row) throw notFound(`No signal ${id} in ${project}`)
            names = [...new Set([...JSON.parse(row.delivered_to) as string[], to])]
            const {changes} = await this.run('UPDATE signals SET delivered_to = ? WHERE id = ? AND delivered_to = ?', JSON.stringify(names), id, row.delivered_to)
            if (changes) break
            // Lost every race: say so, rather than a receipt that wasn't kept.
            if (tries === 9) throw conflict(`Signal ${id} is being marked by too many sessions at once; try again`)
        }
        return signalOf({...row, delivered_to: JSON.stringify(names)})
    }

    /** A session's new id (after a `/clear`) takes over the signals sent to its old one. */
    protected async retargetSignals(project: string, from: string, to: string) {
        if (await this.signalsApi('POST', `/api/projects/${encodeURIComponent(project)}/signals/retarget`, {from, to})) return
        await this.run('UPDATE signals SET target = ? WHERE project = ? AND target = ?', to, project, from)
    }
}
