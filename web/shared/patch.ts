import type {Chunk, Issue, Project} from './roadmap'
import {CLOSED} from './roadmap'

// What changed in a project since the page last had it (ORR-440), so a change to one issue doesn't send the whole
// project to every open tab. A patch carries the issues that changed, whole, and for each chunk with a change its
// fields and its tree of issue ids; a chunk with no change is its id alone. The page builds the project again from
// the patch and what it has. `base` is the revision the patch was made from and `rev` the one it makes: a page
// behind `base` missed one, and reads the project again.

/** An issue's place in its chunk: its id and its sub-issues'. */
export interface Shape {
    id: string
    tasks: Shape[]
}

export type IssueFields = Omit<Issue, 'tasks'>
type ChunkFields = Omit<Chunk, 'tasks'>

export interface ProjectPatch {
    id: string
    base: number
    rev: number
    /** The project's own fields that changed (not its board), and those it no longer has. */
    fields: Partial<Omit<Project, 'board'>>
    unset: string[]
    board: {
        counts: Project['board']['counts']
        kinds: Project['board']['kinds']
        chunks: ((ChunkFields & {tasks: Shape[]}) | {id: string, same: true})[]
    }
    /** Every issue that's new or changed, without its sub-issues. */
    issues: Record<string, IssueFields>
}

const shapeOf = (issues: Issue[]): Shape[] => issues.map(issue => ({id: issue.id, tasks: shapeOf(issue.tasks)}))
const fieldsOf = (issue: Issue): IssueFields => {
    const {tasks: _, ...fields} = issue
    return fields
}
const json = (value: unknown) => JSON.stringify(value)

/** Each issue in `chunks`, by id, as JSON without its sub-issues. */
function issueJson(chunks: Chunk[]): Map<string, string> {
    const found = new Map<string, string>()
    const walk = (issues: Issue[]) => issues.forEach(issue => {
        found.set(issue.id, json(fieldsOf(issue)))
        walk(issue.tasks)
    })
    chunks.forEach(chunk => walk(chunk.tasks))
    return found
}

/** `project` without its issues' notes, which only an issue's own page shows: it reads them itself (ORR-439), so
 * the page's load of every board and the patches after it leave them out. */
export function withoutNotes<T extends Project>(project: T): T {
    const strip = (issues: Issue[]): Issue[] => issues.map(({notes: _, tasks, ...issue}) => ({...issue, tasks: strip(tasks)}))
    return {...project, board: {...project.board, chunks: project.board.chunks.map(chunk => ({...chunk, tasks: strip(chunk.tasks)}))}}
}

const closed = (issue: {kind: string}) => (CLOSED as readonly string[]).includes(issue.kind)

/** `project` without its closed issues (done, canceled) that have no open sub-issue under them: the page's load of every
 * board leaves them out (ORR-447), and reads a project whole when one of its pages opens. A closed issue with open work
 * under it stays, so the tree holds. */
export function withoutClosed<T extends Project>(project: T): T {
    const keep = (issues: Issue[]): Issue[] => issues.flatMap(issue => {
        const tasks = keep(issue.tasks)
        return closed(issue) && !tasks.length ? [] : [{...issue, tasks}]
    })
    return {...project, board: {...project.board, chunks: project.board.chunks.map(chunk => ({...chunk, tasks: keep(chunk.tasks)}))}}
}

/** What changed from `before` (none: everything) to `after`. `seen` saves work on a big project (ORR-483): its
 * `before`, when given, is each of `before`'s issues as JSON, from the diff before, and `after` is filled in with
 * `after`'s, for the next. */
export function diffProject(before: Project | undefined, after: Project, base: number, rev: number, seen?: {before?: Map<string, string>, after?: Map<string, string>}): ProjectPatch {
    const {board: _, ...fields} = after
    const {board: __, ...had} = before ?? {board: undefined}
    const changed: Record<string, unknown> = {}
    const was = had as Record<string, unknown>
    // A field with no value (undefined) wouldn't survive JSON, so one that had a value is `unset` instead.
    for (const [key, value] of Object.entries(fields)) if (value !== undefined && (!before || json(value) !== json(was[key]))) changed[key] = value
    const unset = before ? Object.keys(was).filter(key => was[key] !== undefined && (fields as Record<string, unknown>)[key] === undefined) : []

    const old = seen?.before ?? issueJson(before?.board.chunks ?? [])
    const oldChunks = new Map((before?.board.chunks ?? []).map(chunk => [chunk.id, chunk]))
    const issues: Record<string, IssueFields> = {}
    const chunks = after.board.chunks.map(chunk => {
        let same = true
        const walk = (list: Issue[]) => list.forEach(issue => {
            const now = fieldsOf(issue)
            const text = json(now)
            seen?.after?.set(issue.id, text)
            if (old.get(issue.id) !== text) {
                issues[issue.id] = now
                same = false
            }
            walk(issue.tasks)
        })
        walk(chunk.tasks)
        const {tasks, ...head} = chunk
        const was = oldChunks.get(chunk.id)
        if (same && was) {
            const {tasks: wasTasks, ...wasHead} = was
            if (json(head) === json(wasHead) && json(shapeOf(tasks)) === json(shapeOf(wasTasks))) return {id: chunk.id, same: true as const}
        }
        return {...head, tasks: shapeOf(tasks)}
    })
    return {id: after.id, base, rev, fields: changed as ProjectPatch['fields'], unset, board: {counts: after.board.counts, kinds: after.board.kinds, chunks}, issues}
}

/** `project` with `patch` applied; null when it can't be (a chunk or issue the patch counts on isn't there). A `partial`
 * project was read without its closed issues (`withoutClosed`): one it never had stays out, changed or not, unless open
 * work under it needs it there, when it can't be applied (and the project is read again, with it). */
export function applyPatch(project: Project, patch: ProjectPatch, partial = false): Project | null {
    const issues = new Map<string, IssueFields>()
    const walk = (list: Issue[]) => list.forEach(issue => {
        issues.set(issue.id, fieldsOf(issue))
        walk(issue.tasks)
    })
    project.board.chunks.forEach(chunk => walk(chunk.tasks))
    const chunks = new Map(project.board.chunks.map(chunk => [chunk.id, chunk]))
    const fieldsFor = (id: string): IssueFields | undefined => {
        const sent = patch.issues[id]
        return partial && !issues.has(id) && sent && closed(sent) ? undefined : sent ?? issues.get(id)
    }
    const needed = (shape: Shape): boolean => !!fieldsFor(shape.id) || shape.tasks.some(needed)
    // An issue, null when one it needs is missing, or undefined when it's left out.
    const build = (shape: Shape): Issue | null | undefined => {
        const fields = fieldsFor(shape.id)
        if (!fields) return partial && !needed(shape) ? undefined : null
        const tasks = shape.tasks.map(build)
        return tasks.includes(null) ? null : {...fields, tasks: tasks.filter(Boolean) as Issue[]} as Issue
    }
    const next: Chunk[] = []
    for (const chunk of patch.board.chunks) {
        if ('same' in chunk) {
            const kept = chunks.get(chunk.id)
            if (!kept) return null
            next.push(kept)
            continue
        }
        const tasks = chunk.tasks.map(build)
        if (tasks.includes(null)) return null
        next.push({...chunk, tasks: tasks.filter(Boolean) as Issue[]})
    }
    const result = {...project, ...patch.fields, board: {chunks: next, counts: patch.board.counts, kinds: patch.board.kinds}} as Project
    for (const key of patch.unset) delete (result as unknown as Record<string, unknown>)[key]
    return result
}
