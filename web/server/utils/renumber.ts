// Ids are the project's: chunks are numbered 1, 2, … and issues KEY-1, KEY-2, … Renumbering a
// project gives what doesn't have one yet the next free number, in roadmap order (sub-issues right
// after their parent), and keeps each old id as an alias, so links and agents that use it still find
// the same thing. Ids already in that form keep it, and the counters never go back: a number never
// comes to mean another issue.
import type {DatabaseSync, SQLInputValue} from 'node:sqlite'
import type {Db} from './database'

/** An id an issue had, pointed at its id now (replacing where it pointed before). */
export const UPSERT_ISSUE_ALIAS = 'INSERT INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?) ON CONFLICT (project, alias) DO UPDATE SET issue = excluded.issue'
/** The same for a chunk. */
export const UPSERT_CHUNK_ALIAS = 'INSERT INTO chunk_aliases (project, alias, chunk) VALUES (?, ?, ?) ON CONFLICT (project, alias) DO UPDATE SET chunk = excluded.chunk'

// Marks ids mid-rename, so a new id never meets an old one in a primary key.
const MOVING = '\u0001'

type Statement = [sql: string, ...params: SQLInputValue[]]
type Issue = {id: string, parent: string | null, chunk: string | null}

const KEY = 'SELECT key, next_number, next_chunk FROM projects WHERE id = ?'
type Project = {key: string, next_number: number, next_chunk: number}
const CHUNKS = 'SELECT id FROM chunks WHERE project = ? ORDER BY position, created_at'
const ISSUES = 'SELECT id, parent, chunk FROM issues WHERE project = ? ORDER BY position, created_at'

/** Run with foreign keys off or deferred: rows point at ids that are changing. */
export async function renumber(db: Db, project: string) {
    const statements = plan(project, (await db.get<Project>(KEY, project))!, await db.all<{id: string}>(CHUNKS, project), await db.all<Issue>(ISSUES, project))
    for (const statement of statements) await db.run(...statement)
}

/** The same, on the raw connection: for the migration step that gave everything its id. */
export function renumberSync(db: DatabaseSync, project: string) {
    const statements = plan(project, db.prepare(KEY).get(project) as Project, db.prepare(CHUNKS).all(project) as {id: string}[], db.prepare(ISSUES).all(project) as Issue[])
    for (const [sql, ...params] of statements) db.prepare(sql).run(...params)
}

/** The writes that renumber the project, in order. */
function plan(project: string, {key, next_number, next_chunk}: Project, chunks: {id: string}[], issues: Issue[]): Statement[] {
    const statements: Statement[] = []
    const run = (...statement: Statement) => statements.push(statement)

    const children = new Map<string | null, typeof issues>()
    for (const issue of issues) children.set(issue.parent, [...children.get(issue.parent) ?? [], issue])
    const order: string[] = []
    const walk = (id: string) => {
        order.push(id)
        children.get(id)?.forEach(child => walk(child.id))
    }
    const top = children.get(null) ?? []
    for (const chunk of [...chunks.map(c => c.id), null]) top.filter(t => t.chunk === chunk).forEach(t => walk(t.id))

    const chunkIds = numbered(chunks.map(c => c.id), /^(\d+)$/, n => String(n), next_chunk)
    const own = new RegExp(`^${key}-(\\d+)$`)
    const issueIds = numbered(order, own, n => `${key}-${n}`, next_number)

    for (const [from, to] of chunkIds) {
        run('UPDATE chunks SET id = ? WHERE project = ? AND id = ?', MOVING + to, project, from)
        run('UPDATE issues SET chunk = ? WHERE project = ? AND chunk = ?', MOVING + to, project, from)
        run('UPDATE chunk_aliases SET chunk = ? WHERE project = ? AND chunk = ?', MOVING + to, project, from)
    }
    for (const [from, to] of issueIds) {
        run('UPDATE issues SET id = ? WHERE project = ? AND id = ?', MOVING + to, project, from)
        run('UPDATE issues SET parent = ? WHERE project = ? AND parent = ?', MOVING + to, project, from)
        run('UPDATE comments SET issue = ? WHERE project = ? AND issue = ?', MOVING + to, project, from)
        run('UPDATE issue_aliases SET issue = ? WHERE project = ? AND issue = ?', MOVING + to, project, from)
    }
    const strip = `substr(%, ${MOVING.length + 1})`
    run(`UPDATE chunks SET id = ${strip.replace('%', 'id')} WHERE project = ? AND substr(id, 1, 1) = ?`, project, MOVING)
    run(`UPDATE issues SET chunk = ${strip.replace('%', 'chunk')} WHERE project = ? AND substr(chunk, 1, 1) = ?`, project, MOVING)
    run(`UPDATE chunk_aliases SET chunk = ${strip.replace('%', 'chunk')} WHERE project = ? AND substr(chunk, 1, 1) = ?`, project, MOVING)
    run(`UPDATE issues SET id = ${strip.replace('%', 'id')} WHERE project = ? AND substr(id, 1, 1) = ?`, project, MOVING)
    run(`UPDATE issues SET parent = ${strip.replace('%', 'parent')} WHERE project = ? AND substr(parent, 1, 1) = ?`, project, MOVING)
    run(`UPDATE comments SET issue = ${strip.replace('%', 'issue')} WHERE project = ? AND substr(issue, 1, 1) = ?`, project, MOVING)
    run(`UPDATE issue_aliases SET issue = ${strip.replace('%', 'issue')} WHERE project = ? AND substr(issue, 1, 1) = ?`, project, MOVING)

    for (const [from, to] of chunkIds) if (from !== to) run(UPSERT_CHUNK_ALIAS, project, from, to)
    for (const [from, to] of issueIds) if (from !== to) run(UPSERT_ISSUE_ALIAS, project, from, to)
    // An alias that is now some thing's own id would only mislead.
    run('DELETE FROM chunk_aliases WHERE project = ? AND alias IN (SELECT id FROM chunks WHERE project = ?)', project, project)
    run('DELETE FROM issue_aliases WHERE project = ? AND alias IN (SELECT id FROM issues WHERE project = ?)', project, project)
    run('UPDATE projects SET next_number = ?, next_chunk = ? WHERE id = ?', after(issueIds.values(), own, next_number), after(chunkIds.values(), /^(\d+)$/, next_chunk), project)
    return statements
}

/** Keeps the ids already in `form` and gives the rest the next numbers, from `next` or past the highest. */
function numbered(ids: string[], form: RegExp, name: (n: number) => string, next: number): Map<string, string> {
    next = after(ids, form, next)
    return new Map(ids.map(id => [id, form.test(id) ? id : name(next++)]))
}

/** The number after the highest of `ids` in `form`, or `next` if that's further on. */
function after(ids: Iterable<string>, form: RegExp, next: number): number {
    return Math.max(next, ...[...ids].map(id => Number(form.exec(id)?.[1] ?? 0) + 1))
}
