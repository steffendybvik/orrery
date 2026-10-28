import type {Chunk, Issue, Project} from './roadmap'

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

/** What changed from `before` (none: everything) to `after`. */
export function diffProject(before: Project | undefined, after: Project, base: number, rev: number): ProjectPatch {
    const {board: _, ...fields} = after
    const {board: __, ...had} = before ?? {board: undefined}
    const changed: Record<string, unknown> = {}
    const was = had as Record<string, unknown>
    // A field with no value (undefined) wouldn't survive JSON, so one that had a value is `unset` instead.
    for (const [key, value] of Object.entries(fields)) if (value !== undefined && (!before || json(value) !== json(was[key]))) changed[key] = value
    const unset = before ? Object.keys(was).filter(key => was[key] !== undefined && (fields as Record<string, unknown>)[key] === undefined) : []

    const old = issueJson(before?.board.chunks ?? [])
    const oldChunks = new Map((before?.board.chunks ?? []).map(chunk => [chunk.id, chunk]))
    const issues: Record<string, IssueFields> = {}
    const chunks = after.board.chunks.map(chunk => {
        let same = true
        const walk = (list: Issue[]) => list.forEach(issue => {
            const now = fieldsOf(issue)
            if (old.get(issue.id) !== json(now)) {
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

/** `project` with `patch` applied; null when it can't be (a chunk or issue the patch counts on isn't there). */
export function applyPatch(project: Project, patch: ProjectPatch): Project | null {
    const issues = new Map<string, IssueFields>()
    const walk = (list: Issue[]) => list.forEach(issue => {
        issues.set(issue.id, fieldsOf(issue))
        walk(issue.tasks)
    })
    project.board.chunks.forEach(chunk => walk(chunk.tasks))
    const chunks = new Map(project.board.chunks.map(chunk => [chunk.id, chunk]))
    const build = (shape: Shape): Issue | null => {
        const fields = patch.issues[shape.id] ?? issues.get(shape.id)
        if (!fields) return null
        const tasks = shape.tasks.map(build)
        return tasks.every(Boolean) ? {...fields, tasks: tasks as Issue[]} as Issue : null
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
        if (!tasks.every(Boolean)) return null
        next.push({...chunk, tasks: tasks as Issue[]})
    }
    const result = {...project, ...patch.fields, board: {chunks: next, counts: patch.board.counts, kinds: patch.board.kinds}} as Project
    for (const key of patch.unset) delete (result as unknown as Record<string, unknown>)[key]
    return result
}
