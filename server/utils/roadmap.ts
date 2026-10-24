// The column rules, a port of mesher's `roadmap.rs`: every leaf issue goes where its status and plan
// put it, and parents and chunks follow their leaves. Also checks a roadmap in mesher's
// `docs/roadmap.json` format, which `POST /api/projects/:project/import` takes.
import type {Board, Chunk, Column, Counts, Issue, Plan, Priority, Status} from '#shared/roadmap'
import {COLUMNS, PLANS, PRIORITIES, STATUSES, emptyCounts, total} from '#shared/roadmap'

/** A roadmap in `docs/roadmap.json`'s format, once checked. */
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
    status: Status
    plan?: Plan
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
            status: oneOf(value, 'status', STATUSES, at) ?? 'todo',
            plan: oneOf(value, 'plan', PLANS, at),
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

/** An issue as the board is built from it: as written, plus what the database knows. */
export interface IssueInput extends Omit<TaskFile, 'tasks'> {
    comments?: number
    aliases?: string[]
    createdBy?: string
    protected?: boolean
    createdAt?: string
    updatedAt?: string
    tasks: IssueInput[]
}

export interface BoardInput {
    chunks: (Omit<ChunkFile, 'tasks'> & {priority?: Priority, aliases?: string[], createdBy?: string, protected?: boolean, tasks: IssueInput[]})[]
}

/** Places every issue in its column and rolls them up into their parents and chunks. */
export function buildBoard(roadmap: BoardInput): Board {
    const counts = emptyCounts()
    const chunks = roadmap.chunks.map((chunk): Chunk => {
        const tasks = chunk.tasks.map(issueOf)
        const own = sum(tasks.map(t => t.counts))
        merge(counts, own)
        const {id, title, summary, priority, aliases = [], createdBy = '', protected: owned = false} = chunk
        return {id, title, summary: summary || undefined, priority, column: columnOf(own), counts: own, aliases, createdBy, protected: owned, tasks}
    })
    return {chunks, counts}
}

function issueOf(task: IssueInput): Issue {
    const tasks = task.tasks.map(issueOf)
    const counts = tasks.length ? sum(tasks.map(t => t.counts)) : emptyCounts()
    if (!tasks.length) counts[leafColumn(task.status, task.plan)] += 1
    const {id, title, priority, assignee, labels, status, plan, notes, comments = 0, aliases = [], createdBy = '', protected: owned = false, createdAt = '', updatedAt = ''} = task
    return {id, title, priority, assignee, labels, status, plan, notes, column: columnOf(counts), counts, comments, aliases, createdBy, protected: owned, createdAt, updatedAt, tasks}
}

/** A leaf issue: done → Done; doing → Doing; otherwise its plan, and Backlog when it has none. */
export function leafColumn(status: Status, plan?: Plan): Column {
    if (status === 'done') return 'done'
    if (status === 'doing') return 'doing'
    return plan ?? 'backlog'
}

/** Done when every leaf is; Doing when any is; else the soonest column an open leaf is in. A chunk
 * without issues yet is in the backlog. */
export function columnOf(counts: Counts): Column {
    if (!total(counts)) return 'backlog'
    if (counts.done === total(counts)) return 'done'
    return COLUMNS.find(column => column !== 'done' && counts[column] > 0) ?? 'backlog'
}

function sum(all: Counts[]): Counts {
    const counts = emptyCounts()
    all.forEach(c => merge(counts, c))
    return counts
}

function merge(into: Counts, from: Counts) {
    for (const column of COLUMNS) into[column] += from[column]
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
