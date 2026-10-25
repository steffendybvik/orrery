// The column rules: every leaf issue goes where its status puts it, and parents and chunks follow their
// leaves. Also checks a roadmap in the `roadmap.json` format (chunks of tasks with a status and a plan),
// which `POST /api/projects/:project/import` takes.
import type {Board, Choice, Chunk, Column, Counts, Issue, IssueStatus, Kinds, Picks, Place, Priority, Proposal} from '#shared/roadmap'
import {CLOSED, PRIORITIES, emptyKinds, open, total} from '#shared/roadmap'

/** The statuses and plans of the `roadmap.json` format (and of Orrery before it had statuses of its own). */
export const LEGACY_STATUSES = ['todo', 'doing', 'done'] as const
export const LEGACY_PLANS = ['now', 'next', 'later'] as const

/** A roadmap in the `roadmap.json` format, once checked. */
export interface RoadmapFile {
    comment: string
    chunks: ChunkFile[]
}

export interface ChunkFile {
    id: string
    title: string
    summary: string
    tasks: TaskFile[]
}

export interface TaskFile {
    id: string
    title: string
    priority?: Priority
    assignee?: string
    labels: string[]
    status: (typeof LEGACY_STATUSES)[number]
    plan?: (typeof LEGACY_PLANS)[number]
    notes?: string
    tasks: TaskFile[]
}

/** A file that isn't a roadmap: what's wrong, one line per problem (where, then what). */
export class RoadmapError extends Error {
    constructor(message: string, readonly details: string[] = []) {
        super(message)
    }
}

const ROADMAP_FIELDS = ['$comment', 'chunks']
const CHUNK_FIELDS = ['id', 'title', 'summary', 'tasks']
const TASK_FIELDS = ['id', 'title', 'priority', 'assignee', 'labels', 'status', 'plan', 'notes', 'tasks']

/** Parses and checks the file's text; unknown fields are refused, so typos show up. */
export function readRoadmap(text: string): RoadmapFile {
    let data: unknown
    try {
        data = JSON.parse(text)
    } catch (error) {
        throw new RoadmapError('Not valid JSON', [jsonProblem(text, error)])
    }
    return checkRoadmap(data)
}

export function checkRoadmap(data: unknown): RoadmapFile {
    const problems: string[] = []
    const problem = (where: string, what: string) => problems.push(`${where}: ${what}`)
    const issueIds = new Set<string>()
    const chunkIds = new Set<string>()

    function fields(value: Record<string, unknown>, known: string[], where: string) {
        for (const key of Object.keys(value)) {
            if (!known.includes(key)) problem(where, `unknown field "${key}"`)
        }
    }

    function text(value: Record<string, unknown>, key: string, where: string, required = false): string | undefined {
        const found = value[key]
        if (found === undefined) {
            if (required) problem(where, `missing "${key}"`)
            return undefined
        }
        if (typeof found === 'string') return found
        problem(where, `"${key}" should be text, not ${describe(found)}`)
        return undefined
    }

    function oneOf<T extends string>(value: Record<string, unknown>, key: string, allowed: readonly T[], where: string): T | undefined {
        const found = text(value, key, where)
        if (found === undefined || allowed.includes(found as T)) return found as T | undefined
        problem(where, `"${key}" is "${found}", not one of ${allowed.join(', ')}`)
        return undefined
    }

    function list(value: Record<string, unknown>, key: string, where: string): unknown[] {
        const found = value[key]
        if (found === undefined) return []
        if (Array.isArray(found)) return found
        problem(where, `"${key}" should be a list, not ${describe(found)}`)
        return []
    }

    function labels(value: Record<string, unknown>, where: string): string[] {
        const found = list(value, 'labels', where)
        if (found.every(l => typeof l === 'string')) return found as string[]
        problem(where, '"labels" should be a list of strings')
        return []
    }

    function task(value: unknown, where: string): TaskFile | null {
        if (!isObject(value)) {
            problem(where, `should be an issue, not ${describe(value)}`)
            return null
        }
        const id = text(value, 'id', where, true)
        const at = id ? id : where
        if (id) {
            if (issueIds.has(id)) problem(at, 'id is used by more than one issue')
            issueIds.add(id)
        }
        fields(value, TASK_FIELDS, at)
        const tasks = list(value, 'tasks', at).map((t, i) => task(t, `${at} › tasks[${i}]`))
        return {
            id: id ?? '',
            title: text(value, 'title', at, true) ?? '',
            priority: oneOf(value, 'priority', PRIORITIES, at),
            assignee: text(value, 'assignee', at),
            labels: labels(value, at),
            status: oneOf(value, 'status', LEGACY_STATUSES, at) ?? 'todo',
            plan: oneOf(value, 'plan', LEGACY_PLANS, at),
            notes: text(value, 'notes', at),
            tasks: tasks.filter(t => t !== null),
        }
    }

    function chunk(value: unknown, where: string): ChunkFile | null {
        if (!isObject(value)) {
            problem(where, `should be a chunk, not ${describe(value)}`)
            return null
        }
        const id = text(value, 'id', where, true)
        const at = id ? `chunk "${id}"` : where
        if (id) {
            if (chunkIds.has(id)) problem(at, 'id is used by more than one chunk')
            chunkIds.add(id)
        }
        fields(value, CHUNK_FIELDS, at)
        if (!Array.isArray(value.tasks)) problem(at, 'missing "tasks"')
        const tasks = list(value, 'tasks', at).map((t, i) => task(t, `${at} › tasks[${i}]`))
        return {
            id: id ?? '',
            title: text(value, 'title', at, true) ?? '',
            summary: text(value, 'summary', at) ?? '',
            tasks: tasks.filter(t => t !== null),
        }
    }

    if (!isObject(data)) throw new RoadmapError('Not a roadmap', [`the file: should be an object with "chunks", not ${describe(data)}`])
    fields(data, ROADMAP_FIELDS, 'the file')
    if (!Array.isArray(data.chunks)) problem('the file', 'missing "chunks"')
    const chunks = list(data, 'chunks', 'the file').map((c, i) => chunk(c, `chunks[${i}]`))
    const roadmap = {comment: text(data, '$comment', 'the file') ?? '', chunks: chunks.filter(c => c !== null)}

    if (problems.length) throw new RoadmapError(problems.length === 1 ? '1 problem in the roadmap' : `${problems.length} problems in the roadmap`, problems)
    return roadmap
}

/** The status a task in the `roadmap.json` format becomes: done → Done, doing → In progress, todo → Todo with a plan,
 * Backlog without one. */
export function legacyStatus(status: TaskFile['status'], plan?: TaskFile['plan']): Place {
    if (status === 'done') return 'done'
    if (status === 'doing') return 'started'
    return plan ? 'todo' : 'backlog'
}

/** An issue as the board is built from it: as written, plus what the database knows. */
export interface IssueInput extends Omit<TaskFile, 'tasks' | 'status' | 'plan'> {
    /** A status's id. */
    status: string
    proposal?: Proposal
    decidedBy?: string
    decidedAt?: string
    decisionNote?: string
    choices?: Choice[]
    picks?: Picks
    explore?: {choice: string, option: string}
    comments?: number
    aliases?: string[]
    schedule?: number
    createdBy?: string
    protected?: boolean
    createdAt?: string
    updatedAt?: string
    tasks: IssueInput[]
}

export interface BoardInput {
    chunks: (Omit<ChunkFile, 'tasks'> & {priority?: Priority, aliases?: string[], createdBy?: string, protected?: boolean, tasks: IssueInput[]})[]
}

/** Places every issue in its column and rolls them up into their parents and chunks. `statuses` are in board order. */
export function buildBoard(roadmap: BoardInput, statuses: IssueStatus[]): Board {
    const rules = new Rules(statuses)
    const counts: Counts = {}
    const kinds = emptyKinds()
    const chunks = roadmap.chunks.map((chunk): Chunk => {
        const tasks = chunk.tasks.map(task => rules.issue(task))
        const own = rules.sum(tasks)
        merge(counts, own.counts)
        mergeKinds(kinds, own.kinds)
        const {id, title, summary, priority, aliases = [], createdBy = '', protected: owned = false} = chunk
        const column = rules.columnOf(own.counts, own.kinds)
        return {id, title, summary: summary || undefined, priority, column, kind: rules.kindOf(column), counts: own.counts, kinds: own.kinds, aliases, createdBy, protected: owned, tasks}
    })
    return {chunks, counts, kinds}
}

class Rules {
    private readonly kind = new Map<string, Place>()
    /** The open statuses, least along first: started, then todo, then backlog, each in board order. */
    private readonly open: IssueStatus[]

    constructor(private readonly statuses: IssueStatus[]) {
        statuses.forEach(s => this.kind.set(s.id, s.kind))
        this.kind.set('proposed', 'proposed')
        this.open = (['started', 'todo', 'backlog'] as const).flatMap(kind => statuses.filter(s => s.kind === kind))
    }

    kindOf(column: Column): Place {
        return this.kind.get(column) ?? 'backlog'
    }

    /** `proposed`: it's under a proposal, so it's proposed too. */
    issue(task: IssueInput, proposed = false): Issue {
        proposed ||= !!task.proposal
        const tasks = task.tasks.map(t => this.issue(t, proposed))
        let {counts, kinds} = this.sum(tasks)
        if (!tasks.length) {
            const column = proposed ? 'proposed' : this.kind.has(task.status) ? task.status : this.first('backlog')
            counts = {[column]: 1}
            kinds = {...emptyKinds(), [this.kindOf(column)]: 1}
        }
        const column = this.columnOf(counts, kinds)
        const {id, title, priority, assignee, labels, status, notes, proposal, decidedBy, decidedAt, decisionNote, choices = [], picks, explore, comments = 0, aliases = [], schedule, createdBy = '', protected: owned = false, createdAt = '', updatedAt = ''} = task
        return {id, title, priority, assignee, labels, status, notes, proposal, decidedBy, decidedAt, decisionNote, choices, picks, explore, column, kind: this.kindOf(column), counts, kinds, comments, aliases, schedule, createdBy, protected: owned, createdAt, updatedAt, tasks}
    }

    /** Closed when every committed leaf is: its first done status with leaves, or canceled when none was done.
     * Else the least-along open status any leaf is in. Proposed when it's only proposals; nothing yet is in the backlog. */
    columnOf(counts: Counts, kinds: Kinds): Column {
        const has = (s: IssueStatus) => (counts[s.id] ?? 0) > 0
        if (!total(kinds) && !kinds.canceled) return kinds.proposed ? 'proposed' : this.first('backlog')
        if (!open(kinds)) {
            return this.statuses.find(s => s.kind === 'done' && has(s))?.id ?? this.statuses.find(s => CLOSED.includes(s.kind) && has(s))!.id
        }
        return this.open.find(has)!.id
    }

    sum(issues: {counts: Counts, kinds: Kinds}[]): {counts: Counts, kinds: Kinds} {
        const counts: Counts = {}
        const kinds = emptyKinds()
        issues.forEach(i => {
            merge(counts, i.counts)
            mergeKinds(kinds, i.kinds)
        })
        return {counts, kinds}
    }

    /** The first status of a kind, in board order; there's always one of each. */
    first(kind: Place): Column {
        return this.statuses.find(s => s.kind === kind)?.id ?? kind
    }
}

function merge(into: Counts, from: Counts) {
    for (const [column, n] of Object.entries(from)) into[column] = (into[column] ?? 0) + n
}

function mergeKinds(into: Kinds, from: Kinds) {
    for (const kind of Object.keys(into) as Place[]) into[kind] += from[kind]
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'a list'
    if (typeof value === 'object') return 'an object'
    return `${typeof value} ${JSON.stringify(value)}`
}

/** JSON.parse's message, with the line and column when it only gives a position. */
function jsonProblem(text: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    const position = /position (\d+)/.exec(message)
    if (!position || /line \d+/.test(message)) return message
    const before = text.slice(0, Number(position[1])).split('\n')
    return `${message} (line ${before.length}, column ${before.at(-1)!.length + 1})`
}
