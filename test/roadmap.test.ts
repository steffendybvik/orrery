import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import type {IssueStatus} from '#shared/roadmap'
import {DEFAULT_STATUSES, total} from '#shared/roadmap'
import type {BoardInput, IssueInput, TaskFile} from '../server/utils/roadmap'
import {RoadmapError, buildBoard, checkRoadmap, legacyStatus, readRoadmap} from '../server/utils/roadmap'

const STATUSES: IssueStatus[] = DEFAULT_STATUSES.map((s, position) => ({...s, position}))
const first = (kind: string) => STATUSES.find(s => s.kind === kind)!.id

/** A roadmap in mesher's format, its statuses as Orrery's import makes them. */
const legacy = (tasks: TaskFile[]): IssueInput[] => tasks.map(({plan, ...t}) => ({...t, status: first(legacyStatus(t.status, plan)), tasks: legacy(t.tasks)}))
const fromFile = (data: unknown): BoardInput => ({chunks: checkRoadmap(data).chunks.map(c => ({...c, tasks: legacy(c.tasks)}))})

type Leaf = {id: string, title?: string, status?: string, proposal?: 'pending', tasks?: Leaf[]}
const issue = ({id, title = id, status = 'backlog', proposal, tasks = []}: Leaf): IssueInput => ({id, title, status, labels: [], proposal, tasks: tasks.map(issue)})
const board = (...chunks: Leaf[][]) => buildBoard({chunks: chunks.map((tasks, i) => ({id: String(i + 1), title: `C${i + 1}`, summary: '', tasks: tasks.map(issue)}))}, STATUSES)

function problems(data: unknown): string[] {
    try {
        checkRoadmap(data)
    } catch (error) {
        if (error instanceof RoadmapError) return error.details
        throw error
    }
    return []
}

describe('columns', () => {
    it('puts a leaf in its status, and counts it by status and by kind', () => {
        const {chunks, counts, kinds} = board([
            {id: 'A-1', status: 'done'},
            {id: 'A-2', status: 'in-progress'},
            {id: 'A-3', status: 'in-review'},
            {id: 'A-4', status: 'todo'},
            {id: 'A-5', status: 'canceled'},
        ])
        expect(chunks[0]!.tasks.map(t => [t.column, t.kind])).toEqual([['done', 'done'], ['in-progress', 'started'], ['in-review', 'started'], ['todo', 'todo'], ['canceled', 'canceled']])
        expect(counts).toEqual({'done': 1, 'in-progress': 1, 'in-review': 1, 'todo': 1, 'canceled': 1})
        expect([kinds.done, kinds.started, kinds.canceled, total(kinds)]).toEqual([1, 2, 1, 4])
        expect(chunks[0]!.column).toBe('in-progress')
    })

    it('puts a parent in its least-along open status: started, then todo, then backlog', () => {
        const {chunks} = board(
            [{id: 'P-1', status: 'done', tasks: [{id: 'P-1a', status: 'done'}, {id: 'P-1b', status: 'todo'}, {id: 'P-1c'}]}],
            [{id: 'R-1', tasks: [{id: 'R-1a', status: 'in-review'}, {id: 'R-1b', status: 'in-progress'}, {id: 'R-1c', status: 'todo'}]}],
            [{id: 'V-1', tasks: [{id: 'V-1a', status: 'in-review'}, {id: 'V-1b', status: 'done'}]}],
        )
        const parent = chunks[0]!.tasks[0]!
        expect(parent.column).toBe('todo')
        expect([parent.kinds.done, total(parent.kinds)]).toEqual([1, 3])
        expect(chunks[1]!.column).toBe('in-progress')
        expect(chunks[2]!.column).toBe('in-review')
    })

    it('rolls nested sub-issues up through every parent', () => {
        const {chunks} = board([
            {id: 'N-1', status: 'todo', tasks: [
                {id: 'N-1a', tasks: [{id: 'N-1a1', status: 'in-progress'}, {id: 'N-1a2', status: 'done'}]},
                {id: 'N-1b', status: 'done'},
            ]},
        ])
        const top = chunks[0]!.tasks[0]!
        expect([top.column, top.tasks[0]!.column]).toEqual(['in-progress', 'in-progress'])
        expect([top.kinds.done, total(top.kinds)]).toEqual([2, 3])
    })

    it('puts a chunk without issues in the backlog', () => {
        expect(board([]).chunks[0]!.column).toBe('backlog')
    })

    it('is Done when every leaf is closed and one is done, Canceled when none is', () => {
        const {chunks} = board(
            [{id: 'D-1', tasks: [{id: 'D-1a', status: 'done'}, {id: 'D-1b', status: 'canceled'}]}],
            [{id: 'X-1', tasks: [{id: 'X-1a', status: 'canceled'}]}],
        )
        expect([chunks[0]!.tasks[0]!.column, chunks[0]!.column, chunks[0]!.kind]).toEqual(['done', 'done', 'done'])
        expect([chunks[1]!.column, chunks[1]!.kind]).toEqual(['canceled', 'canceled'])
        // Canceled work is out of progress: one done of one.
        expect([chunks[0]!.kinds.done, total(chunks[0]!.kinds)]).toEqual([1, 1])
    })

    it('puts a proposal and everything under it in Proposed, out of the committed work', () => {
        const {chunks} = board([{id: 'Q-1', proposal: 'pending', tasks: [{id: 'Q-1a', status: 'in-progress'}]}, {id: 'Q-2', status: 'todo'}])
        expect(chunks[0]!.tasks[0]!.column).toBe('proposed')
        expect([chunks[0]!.kinds.proposed, total(chunks[0]!.kinds), chunks[0]!.column]).toEqual([1, 1, 'todo'])
    })

    it("follows a status's kind, whatever it's called", () => {
        const statuses: IssueStatus[] = [...STATUSES, {id: 'blocked', name: 'Blocked', kind: 'started', color: 'rose', position: 9}]
        const {chunks} = buildBoard({chunks: [{id: '1', title: 'C', summary: '', tasks: [issue({id: 'B-1', status: 'blocked'}), issue({id: 'B-2', status: 'todo'})]}]}, statuses)
        expect([chunks[0]!.tasks[0]!.kind, chunks[0]!.column, chunks[0]!.kinds.started]).toEqual(['started', 'blocked', 1])
    })
})

describe('checking the file', () => {
    it('refuses typos and names where they are', () => {
        expect(problems({chunks: [{id: 'c', title: 'C', tasks: [{id: 'A-1', title: 'x', stauts: 'done'}]}]}))
            .toEqual(['A-1: unknown field "stauts"'])
    })

    it('refuses values outside the lists', () => {
        expect(problems({chunks: [{id: 'c', title: 'C', tasks: [{id: 'A-1', title: 'x', status: 'doin', priority: 'P9', plan: 'soon'}]}]})).toEqual([
            'A-1: "priority" is "P9", not one of P0, P1, P2, P3',
            'A-1: "status" is "doin", not one of todo, doing, done',
            'A-1: "plan" is "soon", not one of now, next, later',
        ])
    })

    it('refuses a missing title, missing tasks and a reused id', () => {
        expect(problems({chunks: [
            {id: 'c', tasks: [{id: 'A-1', title: 'x'}, {id: 'A-1', title: 'y'}]},
            {id: 'd', title: 'D'},
        ]})).toEqual(['A-1: id is used by more than one issue', 'chunk "c": missing "title"', 'chunk "d": missing "tasks"'])
    })

    it('refuses invalid JSON', () => {
        expect(() => readRoadmap('{"chunks": [}')).toThrow(RoadmapError)
    })
})

describe("mesher's roadmap", () => {
    const roadmap = readRoadmap(readFileSync(new URL('./fixtures/mesher-roadmap.json', import.meta.url), 'utf8'))

    it('reads as a roadmap, todo with a plan in Todo, without one in Backlog and doing in In progress', () => {
        const {chunks, kinds} = buildBoard({chunks: roadmap.chunks.map(c => ({...c, tasks: legacy(c.tasks)}))}, STATUSES)
        expect(chunks).toHaveLength(16)
        expect(total(kinds)).toBe(139)
        expect(chunks.reduce((sum, c) => sum + total(c.kinds), 0)).toBe(139)
        expect(fromFile({chunks: [{id: 'c', title: 'C', tasks: [{id: 'A', title: 'A', plan: 'now'}, {id: 'B', title: 'B'}, {id: 'D', title: 'D', status: 'doing'}]}]})
            .chunks[0]!.tasks.map(t => t.status)).toEqual(['todo', 'backlog', 'in-progress'])
    })
})
