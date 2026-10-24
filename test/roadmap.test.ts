import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {total} from '#shared/roadmap'
import {RoadmapError, buildBoard, checkRoadmap, readRoadmap} from '../server/utils/roadmap'

const board = (data: unknown) => buildBoard(checkRoadmap(data))

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
    it('puts a leaf where its status and plan put it', () => {
        const {chunks, counts} = board({chunks: [{id: 'c', title: 'C', tasks: [
            {id: 'A-1', title: 'done', status: 'done', plan: 'now'},
            {id: 'A-2', title: 'doing', status: 'doing'},
            {id: 'A-3', title: 'now', plan: 'now'},
            {id: 'A-4', title: 'next', plan: 'next'},
            {id: 'A-5', title: 'later', plan: 'later'},
        ]}]})
        expect(chunks[0]!.tasks.map(t => t.column)).toEqual(['done', 'doing', 'now', 'next', 'later'])
        expect(total(counts)).toBe(5)
        expect(chunks[0]!.column).toBe('doing')
    })

    it('puts a leaf without a plan in the backlog', () => {
        const {chunks} = board({chunks: [{id: 'c', title: 'C', tasks: [
            {id: 'B-1', title: 'unplanned'},
            {id: 'B-2', title: 'todo, unplanned', status: 'todo'},
        ]}]})
        expect(chunks[0]!.tasks.map(t => t.column)).toEqual(['backlog', 'backlog'])
        expect(chunks[0]!.column).toBe('backlog')
        expect(chunks[0]!.tasks[0]!.status).toBe('todo')
    })

    it('puts a parent with mixed sub-issues in the soonest open column', () => {
        const {chunks} = board({chunks: [
            {id: 'open', title: 'Open', tasks: [
                {id: 'P-1', title: 'parent', status: 'done', tasks: [
                    {id: 'P-1a', title: 'done', status: 'done'},
                    {id: 'P-1b', title: 'later', plan: 'later'},
                    {id: 'P-1c', title: 'next', plan: 'next'},
                    {id: 'P-1d', title: 'backlog'},
                ]},
                {id: 'P-2', title: 'later', plan: 'later'},
            ]},
            {id: 'shipped', title: 'Shipped', tasks: [{id: 'S-1', title: 'done', status: 'done'}]},
        ]})
        const parent = chunks[0]!.tasks[0]!
        expect(parent.column).toBe('next')
        expect([parent.counts.done, total(parent.counts)]).toEqual([1, 4])
        expect(chunks[0]!.column).toBe('next')
        expect([chunks[0]!.counts.done, total(chunks[0]!.counts)]).toEqual([1, 5])
        expect(chunks[1]!.column).toBe('done')
    })

    it('rolls nested sub-issues up through every parent', () => {
        const {chunks} = board({chunks: [{id: 'c', title: 'C', tasks: [
            {id: 'N-1', title: 'top', plan: 'later', tasks: [
                {id: 'N-1a', title: 'middle', tasks: [
                    {id: 'N-1a1', title: 'doing', status: 'doing'},
                    {id: 'N-1a2', title: 'done', status: 'done'},
                ]},
                {id: 'N-1b', title: 'done', status: 'done'},
            ]},
        ]}]})
        const top = chunks[0]!.tasks[0]!
        expect(top.column).toBe('doing')
        expect(top.tasks[0]!.column).toBe('doing')
        expect([top.counts.done, total(top.counts)]).toEqual([2, 3])
    })

    it('puts a chunk without issues in the backlog', () => {
        expect(board({chunks: [{id: 'c', title: 'C', tasks: []}]}).chunks[0]!.column).toBe('backlog')
    })

    it('is Done only when every leaf is', () => {
        const {chunks} = board({chunks: [{id: 'c', title: 'C', tasks: [
            {id: 'D-1', title: 'parent', tasks: [{id: 'D-1a', title: 'done', status: 'done'}, {id: 'D-1b', title: 'done', status: 'done'}]},
        ]}]})
        expect(chunks[0]!.tasks[0]!.column).toBe('done')
        expect(chunks[0]!.column).toBe('done')
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

    it('reads as a roadmap', () => {
        const {chunks, counts} = buildBoard(roadmap)
        expect(chunks).toHaveLength(16)
        expect(total(counts)).toBe(139)
        expect(chunks.reduce((sum, c) => sum + total(c.counts), 0)).toBe(139)
    })
})
