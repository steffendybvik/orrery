// A board's file (board-export.ts) brought into this server as a new board (ORR-670). It only ever makes a new board, all
// or nothing, and the file is untrusted: its rows are checked in a throwaway SQLite at the file's own schema step and
// brought up to this server's there, and every id numbered across the server is renumbered here. Nothing in it speaks for
// anyone: nothing is the owner's, its comments reach no session, its schedules are paused, and what would act on its own
// (prompts, a repo to poll, starting sessions, claims) is left behind.
import {DatabaseSync} from 'node:sqlite'
import type {Db, Value} from './database'
import {EXPORTED} from './board-export'
import {migrate} from './db'
import {badRequest, conflict} from './input'
import {MIGRATIONS} from './migrations/sqlite'
import {randomUid} from './uid'
import type {Actor} from './store'
import {FULL_ID_KEYS, IMAGE_TYPES, KEY, SLUG, UPLOAD_LIMIT} from '../store/schema'

/** The largest file taken: a board's rows, and its images in base64. */
export const BOARD_LIMIT = 256 * 1024 * 1024

type Table = keyof typeof EXPORTED
type Row = Record<string, Value | undefined>
type Tables = Record<Table, Row[]>

const UPLOAD_ID = /^[0-9a-f]{24}$/

const isRow = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** The file's tables, checked in a SQLite of their own at the file's schema step and brought up to this server's: a
 * column it doesn't know, a row pointing at nothing or a value its table refuses turns the whole file down. */
function upToDate(file: Record<string, unknown>, statuses: Row[]): Tables {
    const step = file.schema_step
    if (!Number.isInteger(step) || (step as number) < 1) throw badRequest('That file says no schema step')
    if ((step as number) > MIGRATIONS.length) {
        throw badRequest(`That file is from a newer orrery (schema step ${step}; this one knows up to ${MIGRATIONS.length}). Upgrade this server first.`)
    }
    const given = isRow(file.tables) ? file.tables : {}
    const memory = new DatabaseSync(':memory:')
    try {
        migrate(memory, 'That file', step as number)
        memory.exec('PRAGMA foreign_keys = OFF; DELETE FROM presets')
        const known = new Set((memory.prepare('SELECT id FROM statuses').all() as {id: string}[]).map(status => status.id))
        const add = (table: string, row: Record<string, unknown>) => {
            const columns = new Set((memory.prepare(`PRAGMA table_info("${table}")`).all() as {name: string}[]).map(column => column.name))
            const keys = Object.keys(row)
            for (const key of keys) if (!columns.has(key)) throw badRequest(`That file's ${table} has a column this schema doesn't: ${key}`)
            for (const key of keys) if (row[key] !== null && !['string', 'number'].includes(typeof row[key])) throw badRequest(`That file's ${table}.${key} isn't a plain value`)
            memory.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(key => row[key] as Value & (string | number | null)))
        }
        for (const status of statuses) if (!known.has(String(status.id))) memory.prepare('INSERT INTO statuses (id, name, kind, color, position) VALUES (?, ?, ?, ?, ?)').run(status.id as string, status.name as string, status.kind as string, status.color as string, status.position as number)
        for (const table of Object.keys(EXPORTED) as Table[]) {
            const rows = given[table] ?? []
            if (!Array.isArray(rows)) throw badRequest(`That file's ${table} isn't a list`)
            for (const row of rows) {
                if (!isRow(row)) throw badRequest(`That file's ${table} holds something that isn't a row`)
                // Whatever project a row says, it's on this board. A schedule keeps nothing tied to the server it came from.
                const here = table === 'projects' ? {...row, id: 'uploaded'} : 'project' in row || table === 'presets' ? {...row, project: 'uploaded'} : row
                add(table, table === 'schedules' ? {...here, across: null, place: known.has(String(here.place)) || statuses.some(s => s.id === here.place) ? here.place : 'todo'} : here)
            }
        }
        migrate(memory, 'That file', MIGRATIONS.length)
        const tables = {} as Tables
        for (const table of Object.keys(EXPORTED) as Table[]) tables[table] = memory.prepare(`SELECT * FROM "${table}"${table === 'presets' ? " WHERE project = 'uploaded'" : ''}`).all() as Row[]
        return tables
    } catch (error) {
        if ((error as {statusCode?: number}).statusCode) throw error
        throw badRequest(`That file doesn't hold together: ${(error as Error).message}`)
    } finally {
        memory.close()
    }
}

const inserting = (table: string, row: Row) => {
    const keys = Object.keys(row)
    return {sql: `INSERT INTO ${table} (${keys.map(key => `"${key}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, values: keys.map(key => row[key] as Value)}
}

async function insert(db: Db, table: string, row: Row) {
    const {sql, values} = inserting(table, row)
    await db.run(sql, ...values)
}

/** The same, for a table numbered across the whole server: the id it gets here. */
async function insertNew(db: Db, table: string, row: Row): Promise<number> {
    const {sql, values} = inserting(table, row)
    const made = await db.get<{id: number}>(`${sql} RETURNING id`, ...values)
    if (!made) throw new Error(`Nothing came back from adding to ${table}`)
    return made.id
}

/** A schedule's list of preset ids, as much of one as the file holds. */
function presetsOf(value: unknown): unknown[] {
    try {
        const list = JSON.parse(String(value))
        return Array.isArray(list) ? list : []
    } catch {
        return []
    }
}

/** Parents before their sub-issues, as each row points at the one above it. The throwaway database checked there's one. */
function parentsFirst(issues: Row[]): Row[] {
    const byId = new Map(issues.map(issue => [issue.id, issue]))
    const out: Row[] = []
    const placed = new Set<unknown>()
    const place = (issue: Row, seen: Set<unknown>) => {
        if (placed.has(issue.id)) return
        if (seen.has(issue.id)) throw badRequest(`That file's issue ${issue.id} is its own parent`)
        seen.add(issue.id)
        const parent = byId.get(issue.parent)
        if (parent) place(parent, seen)
        placed.add(issue.id)
        out.push(issue)
    }
    for (const issue of issues) place(issue, new Set())
    return out
}

/** The next number after the highest one in these ids, or `at` when that's further on: an id the file names is never handed out again. */
function pastIds(ids: unknown[], at: unknown): number {
    const numbers = ids.map(id => Number(/(\d+)$/.exec(String(id))?.[1] ?? 0))
    return Math.max(Number(at) || 1, ...numbers.map(n => n + 1))
}

/** The images the file's text shows: each checked as an image, by its bytes rather than what it says. One this server
 * already has by that id stays as it is. */
async function bringUploads(db: Db, uploads: unknown, actor: Actor) {
    if (!Array.isArray(uploads)) return
    for (const upload of uploads) {
        if (!isRow(upload) || typeof upload.id !== 'string' || !UPLOAD_ID.test(upload.id) || typeof upload.data !== 'string') throw badRequest('That file holds an image it can\'t read')
        const data = Buffer.from(upload.data, 'base64')
        const type = IMAGE_TYPES.find(([, test]) => test(data))?.[0]
        if (!type || data.length > UPLOAD_LIMIT) throw badRequest(`That file's image ${upload.id} isn't a PNG, JPEG, GIF or WebP of ${UPLOAD_LIMIT / 1024 / 1024} MB at most`)
        if (await db.get('SELECT 1 FROM uploads WHERE id = ?', upload.id)) continue
        await db.run('INSERT INTO uploads (id, type, name, size, data, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
            upload.id, type, typeof upload.name === 'string' ? upload.name.slice(0, 200) : null, data.length, data, actor.name, new Date().toISOString())
    }
}

/** Brings the file in as a new board, and says its id. `holder` is the person who holds it: whoever is uploading it. */
export async function uploadBoard(db: Db, file: unknown, as: {id?: string, key?: string, name?: string}, actor: Actor, holder: string): Promise<string> {
    if (!isRow(file) || file.format !== 'orrery-board') throw badRequest('That isn\'t a board\'s file')
    if (file.format_version !== 1) throw badRequest(`That file's format (${String(file.format_version)}) is one this orrery can't read`)
    const statusesInFile = (Array.isArray(file.statuses) ? file.statuses : []).filter(isRow) as Row[]
    const tables = upToDate(file, statusesInFile)
    const [source] = tables.projects
    if (!source || tables.projects.length !== 1) throw badRequest('That file should hold one project')
    const id = as.id ?? String(file.project ?? '')
    const key = as.key ?? String(source.key)
    if (!SLUG.test(id)) throw badRequest(`"${id}" doesn't make a project's id`)
    if (!KEY.test(key) || FULL_ID_KEYS.includes(key)) throw badRequest(`"${key}" doesn't make a project's key`)

    return await db.transaction(async () => {
        if (await db.get('SELECT 1 FROM projects WHERE id = ?', id)) throw conflict(`There is already a project "${id}": choose another id`)
        if (await db.get('SELECT 1 FROM projects WHERE key = ?', key)) throw conflict(`There is already a project with the key ${key}: choose another`)
        const now = new Date().toISOString()

        // Statuses by id, else the first of their kind. People by name, and an open issue with nobody here goes unassigned.
        const statuses = await db.all<{id: string, kind: string}>('SELECT id, kind FROM statuses ORDER BY position')
        const statusFor = (status: unknown) => {
            const same = statuses.find(s => s.id === status)
            if (same) return same
            const kind = statusesInFile.find(s => s.id === status)?.kind
            return statuses.find(s => s.kind === kind) ?? statuses.find(s => s.kind === 'backlog') ?? {id: 'backlog', kind: 'backlog'}
        }
        const people = await db.all<{id: string, name: string}>('SELECT id, name FROM people')
        const named = new Map((Array.isArray(file.people) ? file.people : []).filter(isRow).map(person => [String(person.id).toLowerCase(), String(person.name).toLowerCase()]))
        const personFor = (who: unknown): string | null => {
            if (typeof who !== 'string') return null
            const name = named.get(who.toLowerCase()) ?? who.toLowerCase()
            return people.find(person => person.name.toLowerCase() === name)?.id ?? null
        }
        const onThisBoard = (row: Row): Row => ({...row, project: id, ...'owned' in row ? {owned: 0} : {}})

        await bringUploads(db, file.uploads, actor)

        // What points outside the board stays only where it leads somewhere here that the uploader may see.
        const seen = async (project: string) => !!await db.get('SELECT 1 FROM project_members WHERE project = ? AND person = ?', project, holder)
        const from = typeof source.releases_from === 'string' && await seen(source.releases_from) ? source.releases_from : null
        await insert(db, 'projects', {...source, id, key, name: as.name ?? source.name, uid: randomUid(), created_by: actor.name, owned: Number(actor.owner),
            focus_prompt: null, chunk_prompt: null, instructions: '[]', starts: null, repo: null,
            releases_from: from, release_mode: source.release_mode !== 'own' && !from ? 'none' : source.release_mode,
            next_number: pastIds(tables.issues.map(issue => issue.id), source.next_number), next_chunk: pastIds(tables.chunks.map(chunk => chunk.id), source.next_chunk),
        })
        await db.run("INSERT INTO project_members (project, person, role, created_at) VALUES (?, ?, 'owner', ?)", id, holder, now)
        for (const member of tables.project_members) {
            const person = personFor(member.person)
            if (person && person !== holder) await db.run("INSERT INTO project_members (project, person, role, created_at) VALUES (?, ?, 'member', ?) ON CONFLICT DO NOTHING", id, person, String(member.created_at ?? now))
        }

        for (const table of ['chunks', 'chunk_aliases', 'doc_sections', 'docs', 'releases'] as Table[]) {
            for (const row of tables[table]) await insert(db, table, onThisBoard(table === 'releases' ? {...row, doc_mark: null} : row))
        }

        const newId: Record<'schedules' | 'comments' | 'doc_revisions', Map<unknown, number>> = {schedules: new Map(), comments: new Map(), doc_revisions: new Map()}
        const without = ({id: _id, ...row}: Row): Row => row
        const presets = new Map<unknown, number>()
        for (const preset of tables.presets) presets.set(preset.id, await insertNew(db, 'presets', onThisBoard({...without(preset), default_key: null})))
        for (const schedule of tables.schedules) {
            newId.schedules.set(schedule.id, await insertNew(db, 'schedules', onThisBoard({...without(schedule), enabled: 0, next_run: null, place: statusFor(schedule.place).id, created_by: actor.name, across: null,
                presets: JSON.stringify(presetsOf(schedule.presets).flatMap(preset => presets.get(preset) ?? []))})))
        }

        const versions = new Set(tables.releases.map(release => release.version))
        for (const issue of parentsFirst(tables.issues)) {
            const status = statusFor(issue.status)
            const open = status.kind !== 'done' && status.kind !== 'canceled'
            const assignee = personFor(issue.assignee)
            await insert(db, 'issues', onThisBoard({...issue, status: status.id, assignee: assignee ?? (open ? null : issue.assignee), created_person: personFor(issue.created_person),
                claimed_by: null, claimed_at: null, claimed_session: null, session_name: null,
                ships_in: from || versions.has(issue.ships_in) ? issue.ships_in : null,
                schedule: newId.schedules.get(issue.schedule) ?? null}))
        }
        for (const table of ['issue_aliases'] as Table[]) for (const row of tables[table]) await insert(db, table, onThisBoard(row))
        for (const link of tables.issue_links) {
            const inside = link.on_project === file.project
            if (!inside && !(typeof link.on_project === 'string' && await seen(link.on_project) && await db.get('SELECT 1 FROM issues WHERE project = ? AND id = ?', link.on_project, link.on_issue as Value))) continue
            await insert(db, 'issue_links', onThisBoard({...link, on_project: inside ? id : link.on_project}))
        }

        for (const event of tables.issue_events) await insert(db, 'issue_events', onThisBoard(without(event)))
        // Said by whoever the file says, which is why it says it's the file's: no one here said it, and it asks nothing of anyone.
        for (const comment of tables.comments) {
            newId.comments.set(comment.id, await insertNew(db, 'comments', onThisBoard({...without(comment), created_by: `${comment.created_by} (from a file)`, person: null, cleared: 1, asks: null, session_name: null})))
        }
        for (const request of tables.schedule_requests) {
            const comment = newId.comments.get(request.comment)
            if (comment) await insert(db, 'schedule_requests', {...request, comment, schedule: newId.schedules.get(request.schedule) ?? null, state: request.state === 'asked' ? 'expired' : request.state})
        }
        for (const revision of tables.doc_revisions) newId.doc_revisions.set(revision.id, await insertNew(db, 'doc_revisions', onThisBoard({...without(revision), session_name: null})))
        for (const release of tables.releases) {
            const mark = newId.doc_revisions.get(release.doc_mark)
            if (mark) await db.run('UPDATE releases SET doc_mark = ? WHERE project = ? AND version = ?', mark, id, release.version as Value)
        }
        for (const run of tables.schedule_runs) {
            const schedule = newId.schedules.get(run.schedule)
            if (schedule) await insert(db, 'schedule_runs', {...without(run), schedule})
        }

        // The board's history says where it came from.
        for (const issue of tables.issues) {
            await db.run("INSERT INTO issue_events (project, issue, field, after, created_by, owned, created_at) VALUES (?, ?, 'uploaded', ?, ?, ?, ?)", id, issue.id as Value, typeof file.exported_at === 'string' ? file.exported_at : null, actor.name, Number(actor.owner), now)
        }
        return id
    })
}
