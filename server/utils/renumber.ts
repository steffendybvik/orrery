// Ids are the project's: chunks are numbered 1, 2, … and issues KEY-1, KEY-2, … Renumbering a
// project gives what doesn't have one yet the next free number, in roadmap order (sub-issues right
// after their parent), and keeps each old id as an alias, so links and agents that use it still find
// the same thing. Ids already in that form keep it: a number never comes to mean another issue.
import type {DatabaseSync, SQLInputValue} from 'node:sqlite'

// Marks ids mid-rename, so a new id never meets an old one in a primary key.
const MOVING = '\u0001'

/** Run with foreign keys off or deferred: rows point at ids that are changing. */
export function renumber(db: DatabaseSync, project: string) {
    const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params)
    const all = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as T[]
    const {key} = db.prepare('SELECT key FROM projects WHERE id = ?').get(project) as {key: string}
    const chunks = all<{id: string}>('SELECT id FROM chunks WHERE project = ? ORDER BY position, created_at', project)
    const issues = all<{id: string, parent: string | null, chunk: string | null}>('SELECT id, parent, chunk FROM issues WHERE project = ? ORDER BY position, created_at', project)

    const children = new Map<string | null, typeof issues>()
    for (const issue of issues) children.set(issue.parent, [...children.get(issue.parent) ?? [], issue])
    const order: string[] = []
    const walk = (id: string) => {
        order.push(id)
        children.get(id)?.forEach(child => walk(child.id))
    }
    const top = children.get(null) ?? []
    for (const chunk of [...chunks.map(c => c.id), null]) top.filter(t => t.chunk === chunk).forEach(t => walk(t.id))

    const chunkIds = numbered(chunks.map(c => c.id), /^(\d+)$/, n => String(n))
    const own = new RegExp(`^${key}-(\\d+)$`)
    const issueIds = numbered(order, own, n => `${key}-${n}`)

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

    for (const [from, to] of chunkIds) if (from !== to) run('INSERT OR REPLACE INTO chunk_aliases (project, alias, chunk) VALUES (?, ?, ?)', project, from, to)
    for (const [from, to] of issueIds) if (from !== to) run('INSERT OR REPLACE INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?)', project, from, to)
    // An alias that is now some thing's own id would only mislead.
    run('DELETE FROM chunk_aliases WHERE project = ? AND alias IN (SELECT id FROM chunks WHERE project = ?)', project, project)
    run('DELETE FROM issue_aliases WHERE project = ? AND alias IN (SELECT id FROM issues WHERE project = ?)', project, project)
    const highest = (ids: Iterable<string>, form: RegExp) => Math.max(0, ...[...ids].map(id => Number(form.exec(id)?.[1] ?? 0)))
    run('UPDATE projects SET next_number = ?, next_chunk = ? WHERE id = ?', highest(issueIds.values(), own) + 1, highest(chunkIds.values(), /^(\d+)$/) + 1, project)
}

/** Keeps the ids already in `form` and gives the rest the next numbers after the highest, in order. */
function numbered(ids: string[], form: RegExp, name: (n: number) => string): Map<string, string> {
    let next = Math.max(0, ...ids.map(id => Number(form.exec(id)?.[1] ?? 0))) + 1
    return new Map(ids.map(id => [id, form.test(id) ? id : name(next++)]))
}
